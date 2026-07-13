import { getPool } from "./db";
import {
  runClickHouse15mV2Task,
  runClickHouseTimezoneTask,
  type ObservedWorkerOutcome,
} from "./clickhouse-outbox";
import {
  PgRollupCoordinatorRepository,
  type RollupSchedulerOutcome,
  type RollupSchedulerTask,
} from "./rollup-coordinator-state";
import {
  PgRollupWorkerRepository,
  shadowWorkerEnabled,
  type RollupWorkerName,
  type RollupWorkerRecord,
} from "./rollup-worker-state";
import { PgTimezoneRollupRepository } from "./timezone-rollup";

const COORDINATOR_TICK_MS = 10_000;
const WORKER_MIN_CADENCE_MS = 60_000;
const STARVATION_LIMIT_MS = 120_000;
const ROLLUP_BUCKET_MS = 15 * 60 * 1_000;
const DEFAULT_FINALIZE_DELAY_MS = 30 * 60 * 1_000;

export type RollupCoordinatorTask = Exclude<RollupSchedulerTask, "idle">;

export type RollupCoordinatorCandidate = {
  task: RollupCoordinatorTask;
  due: boolean;
  eligibleSince: Date | null;
  lastStartedAt: Date | null;
  nextAttemptAt: Date | null;
};

export type RollupCoordinatorDependencies = {
  withLoadSlot<T>(operation: () => Promise<T>): Promise<
    { acquired: false } | { acquired: true; value: T }
  >;
  scheduler: {
    recordHeartbeat(at: Date): Promise<void>;
    recordStarted(task: RollupSchedulerTask, at: Date): Promise<void>;
    recordFinished(
      task: RollupSchedulerTask,
      outcome: RollupSchedulerOutcome,
      at: Date,
      error?: string,
    ): Promise<void>;
  };
  getWorker(worker: RollupWorkerName): Promise<RollupWorkerRecord>;
  setEligibility(worker: RollupWorkerName, eligible: boolean, at: Date): Promise<void>;
  countUsageBacklog(now: Date): Promise<number>;
  countTimezoneBacklog(): Promise<{ eligible: number; waitingForBase: number }>;
  validationCandidate(now: Date): Promise<RollupCoordinatorCandidate | null>;
  runTask(task: RollupCoordinatorTask): Promise<RollupSchedulerOutcome>;
};

function isRunnable(candidate: RollupCoordinatorCandidate, now: Date): boolean {
  if (!candidate.due) return false;
  if (candidate.nextAttemptAt && candidate.nextAttemptAt > now) return false;
  return !candidate.lastStartedAt
    || now.getTime() - candidate.lastStartedAt.getTime() >= WORKER_MIN_CADENCE_MS;
}

function waitedTooLong(candidate: RollupCoordinatorCandidate, now: Date): boolean {
  return candidate.eligibleSince != null
    && now.getTime() - candidate.eligibleSince.getTime() >= STARVATION_LIMIT_MS;
}

function lastStartedRank(candidate: RollupCoordinatorCandidate): number {
  return candidate.lastStartedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
}

const STABLE_TASK_ORDER: Record<RollupCoordinatorTask, number> = {
  validation: 0,
  usage_15m_v2: 1,
  timezone: 2,
};

export function selectRollupTask(
  candidates: readonly RollupCoordinatorCandidate[],
  now: Date,
): RollupCoordinatorTask | null {
  const runnable = candidates.filter((candidate) => isRunnable(candidate, now));
  runnable.sort((left, right) => {
    if (left.task === "validation" || right.task === "validation") {
      if (left.task === right.task) return 0;
      return left.task === "validation" ? -1 : 1;
    }
    const leftStarved = waitedTooLong(left, now);
    const rightStarved = waitedTooLong(right, now);
    if (leftStarved !== rightStarved) return leftStarved ? -1 : 1;
    const lastStarted = lastStartedRank(left) - lastStartedRank(right);
    if (lastStarted !== 0) return lastStarted;
    return STABLE_TASK_ORDER[left.task] - STABLE_TASK_ORDER[right.task];
  });
  return runnable[0]?.task ?? null;
}

export type CoordinatorTickOutcome = {
  status: "busy" | "idle" | "completed" | "failed";
  task: RollupSchedulerTask;
  outcome: RollupSchedulerOutcome;
};

export async function runRollupCoordinatorTickWith(
  dependencies: RollupCoordinatorDependencies,
  now: Date,
): Promise<CoordinatorTickOutcome> {
  if (!Number.isFinite(now.getTime())) throw new Error("invalid rollup coordinator time");
  const slot = await dependencies.withLoadSlot(async () => {
    await dependencies.scheduler.recordHeartbeat(now);
    const [usage, timezone, usageBacklog, timezoneBacklog, validation] = await Promise.all([
      dependencies.getWorker("usage_15m_v2"),
      dependencies.getWorker("timezone"),
      dependencies.countUsageBacklog(now),
      dependencies.countTimezoneBacklog(),
      dependencies.validationCandidate(now),
    ]);
    const usageDue = !usage.paused && usageBacklog > 0;
    const timezoneDue = !timezone.paused && timezoneBacklog.eligible > 0;
    await Promise.all([
      dependencies.setEligibility("usage_15m_v2", usageDue, now),
      dependencies.setEligibility("timezone", timezoneDue, now),
    ]);
    const task = selectRollupTask([
      {
        task: "usage_15m_v2",
        due: usageDue,
        eligibleSince: usageDue ? usage.eligibleSince ?? now : null,
        lastStartedAt: usage.lastStartedAt,
        nextAttemptAt: usage.nextAttemptAt,
      },
      {
        task: "timezone",
        due: timezoneDue,
        eligibleSince: timezoneDue ? timezone.eligibleSince ?? now : null,
        lastStartedAt: timezone.lastStartedAt,
        nextAttemptAt: timezone.nextAttemptAt,
      },
      ...(validation ? [validation] : []),
    ], now);
    if (!task) {
      await dependencies.scheduler.recordFinished("idle", "idle", now);
      return { status: "idle", task: "idle", outcome: "idle" } as const;
    }

    await dependencies.scheduler.recordStarted(task, now);
    try {
      const outcome = await dependencies.runTask(task);
      await dependencies.scheduler.recordFinished(task, outcome, new Date());
      return {
        status: outcome === "failed" ? "failed" : "completed",
        task,
        outcome,
      } as const;
    } catch (error) {
      await dependencies.scheduler.recordFinished(task, "failed", new Date(), String(error));
      return { status: "failed", task, outcome: "failed" } as const;
    }
  });
  return slot.acquired
    ? slot.value
    : { status: "busy", task: "idle", outcome: "idle" };
}

function finalizeTarget(now: Date): Date {
  const configured = Number(process.env.CLICKHOUSE_ROLLUP_FINALIZE_DELAY_MS);
  const delay = Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_FINALIZE_DELAY_MS;
  return new Date(Math.floor((now.getTime() - delay) / ROLLUP_BUCKET_MS) * ROLLUP_BUCKET_MS);
}

async function countUsageBacklog(now: Date): Promise<number> {
  const target = finalizeTarget(now);
  const result = await getPool().query<{ due: boolean }>(
    `SELECT
       COALESCE(
         (SELECT watermark < $1 FROM clickhouse_rollup_watermarks WHERE name = 'usage_15m_v2'),
         TRUE
       ) OR EXISTS (
         SELECT 1
         FROM clickhouse_rollup_dirty_buckets
         WHERE name = 'usage_15m_v2' AND bucket < $1
       ) AS due`,
    [target],
  );
  return result.rows[0]?.due ? 1 : 0;
}

function workerOutcome(outcome: Exclude<ObservedWorkerOutcome, "busy">): RollupSchedulerOutcome {
  if (outcome === "failed") return "failed";
  if (outcome === "completed") return "success";
  return "superseded";
}

export async function runRollupCoordinatorTick(now = new Date()): Promise<CoordinatorTickOutcome> {
  const pool = getPool();
  const workers = new PgRollupWorkerRepository(pool);
  const scheduler = new PgRollupCoordinatorRepository(pool);
  const timezone = new PgTimezoneRollupRepository(pool);
  let pendingValidation: import("./rollup-cutover").RollupValidationTask | null = null;
  return runRollupCoordinatorTickWith({
    withLoadSlot: (operation) => workers.withLoadSlot(operation),
    scheduler,
    getWorker: (worker) => workers.get(worker),
    setEligibility: (worker, eligible, at) => workers.setEligibility(worker, eligible, at),
    countUsageBacklog,
    countTimezoneBacklog: () => timezone.countBacklog(),
    async validationCandidate(at) {
      const { reconcileRollupCutover } = await import("./rollup-cutover");
      pendingValidation = (await reconcileRollupCutover(at)).validation;
      return pendingValidation
        ? {
            task: "validation",
            due: true,
            eligibleSince: at,
            lastStartedAt: null,
            nextAttemptAt: null,
          }
        : null;
    },
    async runTask(task) {
      if (task === "usage_15m_v2") return workerOutcome(await runClickHouse15mV2Task());
      if (task === "timezone") return workerOutcome(await runClickHouseTimezoneTask());
      if (!pendingValidation) return "superseded";
      const { executeRollupValidation } = await import("./rollup-cutover");
      return executeRollupValidation(pendingValidation);
    },
  }, now);
}

export function startRollupCoordinator(): void {
  if (process.env.STORAGE_BACKEND !== "clickhouse") return;
  if (
    !shadowWorkerEnabled(process.env, "CLICKHOUSE_15M_V2_COMPACTOR")
    && !shadowWorkerEnabled(process.env, "CLICKHOUSE_TIMEZONE_ROLLUP_COMPACTOR")
  ) return;
  const global = globalThis as { __toardRollupCoordinatorStarted?: true };
  if (global.__toardRollupCoordinatorStarted) return;
  global.__toardRollupCoordinatorStarted = true;
  const schedule = () => {
    const timer = setTimeout(() => {
      void runRollupCoordinatorTick()
        .catch((error) => {
          console.warn(`[toard] rollup coordinator failed — ${String(error)} — retrying later`);
        })
        .finally(schedule);
    }, COORDINATOR_TICK_MS);
    timer.unref();
  };
  schedule();
}
