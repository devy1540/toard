import type {
  RollupDataValidationResult,
} from "@toard/storage-clickhouse";
import { getPool } from "./db";
import { getStorage } from "./storage";
import {
  PgRollupCutoverRepository,
  type RollupCutoverLayer,
  type RollupCutoverRecord,
  type RollupCutoverRepository,
  type RollupFailureKind,
} from "./rollup-cutover-state";

const REQUIRED_HEALTHY_SECONDS = 60 * 60;
const ACTIVE_VALIDATION_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const MAX_TRANSIENT_FAILURES = 3;
const MAX_OBSERVATION_INCREMENT_SECONDS = 60;
const FIFTEEN_MINUTES_MS = 15 * 60 * 1_000;
const DEFAULT_FINALIZE_DELAY_MS = 30 * 60 * 1_000;
const MAX_TIMEZONE_PENDING_JOBS = 10_000;

export type RollupValidationResult = {
  ok: boolean;
  kind: RollupFailureKind | null;
  detail: string | null;
};

export type RollupLayerReadiness = {
  ready: boolean;
  validationReady?: boolean;
  forceValidation?: boolean;
  kind: Exclude<RollupFailureKind, "mismatch"> | null;
  detail: string | null;
  activeTimezones: string[];
};

export type RollupCutoverDependencies = {
  repository: RollupCutoverRepository;
  eligibleTarget(now: Date): Date;
  readiness(
    layer: RollupCutoverLayer,
    target: Date,
    state: RollupCutoverRecord["state"],
  ): Promise<RollupLayerReadiness>;
  validate(
    layer: RollupCutoverLayer,
    target: Date,
    activeTimezones: string[],
    scope: "initial" | "recurring",
  ): Promise<RollupValidationResult>;
  logTransition(
    layer: RollupCutoverLayer,
    from: RollupCutoverRecord["state"],
    to: RollupCutoverRecord["state"],
    target: Date | null,
  ): void;
};

export type RollupCutoverPool = {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>> }>;
};

export function rollupEligibleTargetAt(
  now: Date,
  env: Record<string, string | undefined> = process.env,
): Date {
  if (!Number.isFinite(now.getTime())) throw new Error("invalid rollup cutover time");
  const configuredDelay = Number(env.CLICKHOUSE_ROLLUP_FINALIZE_DELAY_MS);
  const delayMs = Number.isFinite(configuredDelay) && configuredDelay > 0
    ? Math.floor(configuredDelay)
    : DEFAULT_FINALIZE_DELAY_MS;
  return new Date(
    Math.floor((now.getTime() - delayMs) / FIFTEEN_MINUTES_MS) * FIFTEEN_MINUTES_MS,
  );
}

function parsedDate(value: unknown): Date | null {
  const date = value instanceof Date
    ? value
    : typeof value === "string"
      ? new Date(value)
      : null;
  return date && Number.isFinite(date.getTime()) ? date : null;
}

export async function loadRollupLayerReadinessWith(
  pool: RollupCutoverPool,
  layer: RollupCutoverLayer,
  target: Date,
  state: RollupCutoverRecord["state"],
): Promise<RollupLayerReadiness> {
  const timezonesPromise = pool.query(
    "SELECT timezone, validated_at FROM clickhouse_rollup_timezones ORDER BY activated_at, timezone",
  );
  if (layer === "usage_15m_v2") {
    const [watermark, dirty, timezones] = await Promise.all([
      pool.query(
        "SELECT watermark FROM clickhouse_rollup_watermarks WHERE name = $1",
        ["usage_15m_v2"],
      ),
      pool.query(
        `SELECT count(*)::int AS count
         FROM clickhouse_rollup_dirty_buckets
         WHERE name = $1 AND bucket >= $2 AND bucket < $3`,
        ["usage_15m_v2", new Date(target.getTime() - 400 * 24 * 60 * 60 * 1_000), target],
      ),
      timezonesPromise,
    ]);
    const watermarkAt = parsedDate(watermark.rows[0]?.watermark);
    const dirtyCount = Number(dirty.rows[0]?.count ?? 0);
    const ready = watermarkAt != null
      && watermarkAt.getTime() >= target.getTime()
      && dirtyCount === 0;
    return {
      ready,
      validationReady: ready,
      kind: ready ? null : "lag",
      detail: ready ? null : `15m watermark/dirty not ready for ${target.toISOString()}`,
      activeTimezones: timezones.rows
        .map(({ timezone }) => timezone)
        .filter((timezone): timezone is string => typeof timezone === "string"),
    };
  }

  const [jobs, timezones] = await Promise.all([
    pool.query(
      `SELECT count(*) FILTER (WHERE status = 'pending')::int AS pending,
              count(*) FILTER (WHERE status = 'inflight')::int AS inflight
       FROM clickhouse_timezone_rollup_jobs
       WHERE status IN ('pending', 'inflight')`,
    ),
    timezonesPromise,
  ]);
  const pending = Number(jobs.rows[0]?.pending ?? 0);
  const inflight = Number(jobs.rows[0]?.inflight ?? 0);
  const outstanding = pending + inflight;
  const hasUnvalidatedTimezone = timezones.rows.some(
    ({ validated_at }) => parsedDate(validated_at) == null,
  );
  const ready = state === "active"
    ? outstanding <= MAX_TIMEZONE_PENDING_JOBS
    : outstanding === 0;
  return {
    ready,
    validationReady: outstanding === 0,
    forceValidation: state === "active" && outstanding === 0 && hasUnvalidatedTimezone,
    kind: ready ? null : "lag",
    detail: ready ? null : `timezone rollup jobs outstanding: ${outstanding}`,
    activeTimezones: timezones.rows
      .map(({ timezone }) => timezone)
      .filter((timezone): timezone is string => typeof timezone === "string"),
  };
}

function elapsedHealthySeconds(record: RollupCutoverRecord, now: Date): number {
  if (!record.lastCheckedAt) return 0;
  const elapsed = Math.floor((now.getTime() - record.lastCheckedAt.getTime()) / 1_000);
  return Math.max(0, Math.min(MAX_OBSERVATION_INCREMENT_SECONDS, elapsed));
}

function recurringValidationDue(record: RollupCutoverRecord, now: Date): boolean {
  return !record.lastValidationAt
    || now.getTime() - record.lastValidationAt.getTime() >= ACTIVE_VALIDATION_INTERVAL_MS;
}

export async function markValidatedTimezonesWith(
  pool: RollupCutoverPool,
  timezones: readonly string[],
  validatedAt: Date,
): Promise<void> {
  if (timezones.length === 0) return;
  await pool.query(
    `UPDATE clickhouse_rollup_timezones
     SET validated_at = $2
     WHERE timezone = ANY($1::text[])`,
    [[...timezones], validatedAt],
  );
}

async function runValidation(
  dependencies: RollupCutoverDependencies,
  layer: RollupCutoverLayer,
  target: Date,
  activeTimezones: string[],
  scope: "initial" | "recurring",
): Promise<RollupValidationResult> {
  try {
    return await dependencies.validate(layer, target, activeTimezones, scope);
  } catch (error) {
    return { ok: false, kind: "unavailable", detail: String(error) };
  }
}

async function saveTransition(
  dependencies: RollupCutoverDependencies,
  record: RollupCutoverRecord,
  update: Omit<RollupCutoverRecord, "layer" | "updatedAt">,
): Promise<RollupCutoverRecord> {
  const saved = await dependencies.repository.save(record.layer, update);
  if (record.state !== saved.state) {
    dependencies.logTransition(record.layer, record.state, saved.state, saved.targetWatermark);
  }
  return saved;
}

function baseUpdate(record: RollupCutoverRecord, now: Date) {
  return {
    state: record.state,
    targetWatermark: record.targetWatermark,
    healthySeconds: record.healthySeconds,
    lastCheckedAt: now,
    lastValidationAt: record.lastValidationAt,
    consecutiveFailures: record.consecutiveFailures,
    lastFailureKind: record.lastFailureKind,
    lastFailure: record.lastFailure,
    activatedAt: record.activatedAt,
  };
}

async function recordUnhealthy(
  dependencies: RollupCutoverDependencies,
  record: RollupCutoverRecord,
  now: Date,
  kind: Exclude<RollupFailureKind, "mismatch">,
  detail: string | null,
): Promise<RollupCutoverRecord> {
  const failures = record.state === "active" ? record.consecutiveFailures + 1 : record.consecutiveFailures;
  const fallback = record.state === "active" && failures >= MAX_TRANSIENT_FAILURES;
  return saveTransition(dependencies, record, {
    ...baseUpdate(record, now),
    state: fallback ? "fallback" : record.state,
    consecutiveFailures: failures,
    lastFailureKind: kind,
    lastFailure: detail,
  });
}

async function recordValidationFailure(
  dependencies: RollupCutoverDependencies,
  record: RollupCutoverRecord,
  now: Date,
  result: RollupValidationResult,
): Promise<RollupCutoverRecord> {
  const kind = result.kind ?? "unavailable";
  const failures = record.consecutiveFailures + 1;
  const fallback = kind === "mismatch"
    || (record.state === "active" && failures >= MAX_TRANSIENT_FAILURES);
  return saveTransition(dependencies, record, {
    ...baseUpdate(record, now),
    state: fallback ? "fallback" : record.state,
    consecutiveFailures: failures,
    lastFailureKind: kind,
    lastFailure: result.detail,
  });
}

export type RollupValidationTask = {
  layer: RollupCutoverLayer;
  target: Date;
  scope: "initial" | "recurring";
  activeTimezones: string[];
};

type ReconciledLayer = {
  record: RollupCutoverRecord;
  validation: RollupValidationTask | null;
};

async function reconcileLayer(
  dependencies: RollupCutoverDependencies,
  record: RollupCutoverRecord,
  now: Date,
  eligibleTarget: Date,
): Promise<ReconciledLayer> {
  const target = record.state === "observing" && record.targetWatermark
    ? record.targetWatermark
    : eligibleTarget;
  let readiness: RollupLayerReadiness;
  try {
    readiness = await dependencies.readiness(record.layer, target, record.state);
  } catch (error) {
    return {
      record: await recordUnhealthy(dependencies, record, now, "unavailable", String(error)),
      validation: null,
    };
  }
  if (!readiness.ready) {
    return {
      record: await recordUnhealthy(
        dependencies,
        record,
        now,
        readiness.kind ?? "unavailable",
        readiness.detail,
      ),
      validation: null,
    };
  }

  if (record.state === "backfilling" || record.state === "fallback") {
    const saved = await saveTransition(dependencies, record, {
      ...baseUpdate(record, now),
    });
    return {
      record: saved,
      validation: {
        layer: record.layer,
        target,
        scope: "initial",
        activeTimezones: readiness.activeTimezones,
      },
    };
  }

  if (record.state === "observing") {
    const healthySeconds = Math.min(
      REQUIRED_HEALTHY_SECONDS,
      record.healthySeconds + elapsedHealthySeconds(record, now),
    );
    if (healthySeconds < REQUIRED_HEALTHY_SECONDS) {
      return {
        record: await saveTransition(dependencies, record, {
          ...baseUpdate(record, now),
          healthySeconds,
          consecutiveFailures: 0,
          lastFailureKind: null,
          lastFailure: null,
        }),
        validation: null,
      };
    }
    const saved = await saveTransition(dependencies, record, {
      ...baseUpdate(record, now),
      healthySeconds,
    });
    return {
      record: saved,
      validation: {
        layer: record.layer,
        target,
        scope: "initial",
        activeTimezones: readiness.activeTimezones,
      },
    };
  }

  if (!readiness.forceValidation && !recurringValidationDue(record, now)) {
    return {
      record: await saveTransition(dependencies, record, {
        ...baseUpdate(record, now),
        consecutiveFailures: 0,
        lastFailureKind: null,
        lastFailure: null,
      }),
      validation: null,
    };
  }
  if (readiness.validationReady === false) {
    return {
      record: await saveTransition(dependencies, record, {
        ...baseUpdate(record, now),
        consecutiveFailures: 0,
        lastFailureKind: null,
        lastFailure: null,
      }),
      validation: null,
    };
  }
  const saved = await saveTransition(dependencies, record, {
    ...baseUpdate(record, now),
  });
  return {
    record: saved,
    validation: {
      layer: record.layer,
      target,
      scope: "recurring",
      activeTimezones: readiness.activeTimezones,
    },
  };
}

export async function reconcileRollupCutoverWith(
  dependencies: RollupCutoverDependencies,
  now: Date,
): Promise<{ validation: RollupValidationTask | null }> {
  if (!Number.isFinite(now.getTime())) throw new Error("invalid rollup cutover time");
  const eligibleTarget = dependencies.eligibleTarget(now);
  const usage = await reconcileLayer(
    dependencies,
    await dependencies.repository.get("usage_15m_v2"),
    now,
    eligibleTarget,
  );
  if (usage.validation) return { validation: usage.validation };
  const timezone = await dependencies.repository.get("timezone");
  if (usage.record.state !== "active") {
    if (
      timezone.state !== "backfilling"
      || timezone.targetWatermark
      || timezone.healthySeconds !== 0
    ) {
      await saveTransition(dependencies, timezone, {
        ...baseUpdate(timezone, now),
        state: "backfilling",
        targetWatermark: null,
        healthySeconds: 0,
        consecutiveFailures: 0,
        lastFailureKind: null,
        lastFailure: null,
        activatedAt: null,
      });
    }
    return { validation: null };
  }
  const timezoneTarget = timezone.state === "active" || timezone.activatedAt
    ? eligibleTarget
    : usage.record.targetWatermark ?? eligibleTarget;
  const timezoneResult = await reconcileLayer(dependencies, timezone, now, timezoneTarget);
  return { validation: timezoneResult.validation };
}

export async function executeRollupValidationWith(
  task: RollupValidationTask,
  dependencies: RollupCutoverDependencies,
  now: Date,
): Promise<"success" | "failed" | "superseded"> {
  const record = await dependencies.repository.get(task.layer);
  if (
    (task.scope === "recurring" && record.state !== "active")
    || (task.scope === "initial" && !["backfilling", "fallback", "observing"].includes(record.state))
  ) return "superseded";

  let readiness: RollupLayerReadiness;
  try {
    readiness = await dependencies.readiness(task.layer, task.target, record.state);
  } catch (error) {
    await recordUnhealthy(dependencies, record, now, "unavailable", String(error));
    return "failed";
  }
  if (!readiness.ready) {
    await recordUnhealthy(
      dependencies,
      record,
      now,
      readiness.kind ?? "unavailable",
      readiness.detail,
    );
    return "superseded";
  }
  if (task.scope === "recurring" && readiness.validationReady === false) {
    await saveTransition(dependencies, record, {
      ...baseUpdate(record, now),
      consecutiveFailures: 0,
      lastFailureKind: null,
      lastFailure: null,
    });
    return "superseded";
  }

  const validation = await runValidation(
    dependencies,
    task.layer,
    task.target,
    readiness.activeTimezones,
    task.scope,
  );
  if (!validation.ok) {
    await recordValidationFailure(dependencies, record, now, validation);
    return "failed";
  }

  if (task.scope === "recurring") {
    await saveTransition(dependencies, record, {
      ...baseUpdate(record, now),
      lastValidationAt: now,
      consecutiveFailures: 0,
      lastFailureKind: null,
      lastFailure: null,
    });
    return "success";
  }
  if (record.state === "observing") {
    if (record.healthySeconds < REQUIRED_HEALTHY_SECONDS) return "superseded";
    await saveTransition(dependencies, record, {
      ...baseUpdate(record, now),
      state: "active",
      lastValidationAt: now,
      consecutiveFailures: 0,
      lastFailureKind: null,
      lastFailure: null,
      activatedAt: now,
    });
    return "success";
  }
  await saveTransition(dependencies, record, {
    ...baseUpdate(record, now),
    state: "observing",
    targetWatermark: task.target,
    healthySeconds: 0,
    lastValidationAt: now,
    consecutiveFailures: 0,
    lastFailureKind: null,
    lastFailure: null,
    activatedAt: null,
  });
  return "success";
}

export async function advanceRollupCutoverWith(
  dependencies: RollupCutoverDependencies,
  now: Date,
): Promise<void> {
  const result = await reconcileRollupCutoverWith(dependencies, now);
  if (result.validation) {
    await executeRollupValidationWith(result.validation, dependencies, now);
  }
}

type RollupValidationStorage = {
  validateUsage15mV2(target: Date, lookbackMs?: number): Promise<RollupDataValidationResult>;
  validateTimezoneRollups(
    timezones: readonly string[],
    now?: Date,
  ): Promise<RollupDataValidationResult>;
};

function validationResult(result: RollupDataValidationResult): RollupValidationResult {
  return result.ok
    ? { ok: true, kind: null, detail: null }
    : { ok: false, kind: "mismatch", detail: result.detail };
}

function productionCutoverDependencies(): RollupCutoverDependencies {
  const pool = getPool();
  const repository = new PgRollupCutoverRepository(pool);
  const storage = getStorage() as unknown as RollupValidationStorage;
  return {
    repository,
    eligibleTarget: (at) => rollupEligibleTargetAt(at),
    readiness: (layer, target, state) => loadRollupLayerReadinessWith(pool, layer, target, state),
    async validate(layer, target, activeTimezones, scope) {
      if (layer === "usage_15m_v2") {
        const lookbackMs = scope === "initial"
          ? 400 * 24 * 60 * 60 * 1_000
          : 24 * 60 * 60 * 1_000;
        return validationResult(await storage.validateUsage15mV2(target, lookbackMs));
      }
      const result = validationResult(
        await storage.validateTimezoneRollups(activeTimezones, target),
      );
      if (result.ok) {
        await markValidatedTimezonesWith(pool, activeTimezones, new Date());
      }
      return result;
    },
    logTransition(layer, from, to, target) {
      console.log(JSON.stringify({
        event: "rollup_cutover_transition",
        layer,
        from,
        to,
        targetWatermark: target?.toISOString() ?? null,
      }));
    },
  };
}

export async function reconcileRollupCutover(
  now = new Date(),
): Promise<{ validation: RollupValidationTask | null }> {
  return reconcileRollupCutoverWith(productionCutoverDependencies(), now);
}

export async function executeRollupValidation(
  task: RollupValidationTask,
  now = new Date(),
): Promise<"success" | "failed" | "superseded"> {
  return executeRollupValidationWith(task, productionCutoverDependencies(), now);
}

export async function advanceRollupCutover(now = new Date()): Promise<void> {
  await advanceRollupCutoverWith(productionCutoverDependencies(), now);
}
