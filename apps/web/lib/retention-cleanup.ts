import { getPool } from "./db";
import { pruneClickHouseUsageRetention } from "./clickhouse-outbox";
import {
  MAX_ACTIVE_ROLLUP_TIMEZONES,
  timezoneCoverageCutoffs,
} from "./timezone-rollup";

const POSTGRES_RAW_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_RAW_EVENT_LIMIT = 1_000;
const STARTUP_DELAY_MS = 45_000;
const DAILY_TICK_MS = 24 * 60 * 60 * 1_000;
const RAW_DRAIN_FOLLOWUP_DELAY_MS = 1_000;
const RAW_DRAIN_ERROR_BACKOFF_MS = 60_000;

type QueryResult<Row extends Record<string, unknown> = Record<string, unknown>> = {
  rows: Row[];
  rowCount: number | null;
};

type RetentionClient = {
  query(sql: string, params?: unknown[]): Promise<QueryResult>;
  release(): void;
};

type RawRetentionPool = {
  connect(): Promise<RetentionClient>;
};

type CoverageRetentionPool = {
  query(sql: string, params?: unknown[]): Promise<QueryResult>;
};

export type UsageRetentionDependencies = {
  prunePostgresRawEvents(now: Date): Promise<unknown>;
  pruneTimezoneCoverage(now: Date): Promise<unknown>;
  pruneClickHouseUsageRetention(now: Date): Promise<unknown>;
  warn(message: string): void;
};

export type UsageRetentionResult = {
  postgresRawEvents: "completed" | "failed";
  timezoneCoverage: "completed" | "failed";
  clickhouseUsage: "completed" | "failed";
};

type RetentionTimerHandle = {
  unref?(): unknown;
};

export type PostgresRawRetentionDrainOptions<Handle extends RetentionTimerHandle> = {
  prunePostgresRawEvents(now: Date): Promise<{ rawEvents: number }>;
  now(): Date;
  schedule(callback: () => void, delayMs: number): Handle;
  clear(handle: Handle): void;
  warn(message: string): void;
  batchLimit?: number;
  followupDelayMs?: number;
  errorBackoffMs?: number;
};

export type PostgresRawRetentionDrain = {
  run(now?: Date): Promise<"completed" | "overlap" | "stopped">;
  stop(): void;
};

export { timezoneCoverageCutoffs };

function requireValidNow(now: Date): void {
  if (!Number.isFinite(now.getTime())) throw new Error("유효한 retention 기준 시각이 아님");
}

export function createPostgresRawRetentionDrain<Handle extends RetentionTimerHandle>(
  options: PostgresRawRetentionDrainOptions<Handle>,
): PostgresRawRetentionDrain {
  const batchLimit = options.batchLimit ?? DEFAULT_RAW_EVENT_LIMIT;
  const followupDelayMs = options.followupDelayMs ?? RAW_DRAIN_FOLLOWUP_DELAY_MS;
  const errorBackoffMs = options.errorBackoffMs ?? RAW_DRAIN_ERROR_BACKOFF_MS;
  if (!Number.isFinite(batchLimit) || batchLimit <= 0) {
    throw new Error("raw event drain batch limit은 양수여야 함");
  }
  if (!Number.isFinite(followupDelayMs) || followupDelayMs < 0) {
    throw new Error("raw event drain followup delay는 음수가 아니어야 함");
  }
  if (!Number.isFinite(errorBackoffMs) || errorBackoffMs <= 0) {
    throw new Error("raw event drain error backoff는 양수여야 함");
  }

  let inFlight = false;
  let stopped = false;
  let timer: Handle | null = null;

  const clearScheduled = () => {
    if (!timer) return;
    options.clear(timer);
    timer = null;
  };

  let run: PostgresRawRetentionDrain["run"];
  const scheduleNext = (delayMs: number) => {
    if (stopped || timer) return;
    timer = options.schedule(() => {
      timer = null;
      void run(options.now()).catch(() => {
        options.warn("[toard] postgresRawEvents retention drain failed — retrying with backoff");
      });
    }, delayMs);
    timer.unref?.();
  };

  run = async (now = options.now()) => {
    requireValidNow(now);
    if (stopped) return "stopped";
    if (inFlight) return "overlap";
    clearScheduled();
    inFlight = true;
    try {
      const result = await options.prunePostgresRawEvents(now);
      if (result.rawEvents >= batchLimit) scheduleNext(followupDelayMs);
      return "completed";
    } catch (error) {
      scheduleNext(errorBackoffMs);
      throw error;
    } finally {
      inFlight = false;
    }
  };

  return {
    run,
    stop() {
      stopped = true;
      clearScheduled();
    },
  };
}

export async function prunePostgresRawEventsAt(
  pool: RawRetentionPool,
  now = new Date(),
  limit = DEFAULT_RAW_EVENT_LIMIT,
): Promise<{ rawEvents: number }> {
  requireValidNow(now);
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error("raw event retention limit은 양수여야 함");
  }
  const boundedLimit = Math.floor(limit);
  const cutoff = new Date(now.getTime() - POSTGRES_RAW_RETENTION_MS);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const deleted = await client.query(
      `WITH expired AS (
         SELECT id
         FROM raw_events
         WHERE received_at < $1
         ORDER BY id
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       ), detached AS (
         UPDATE usage_events
         SET raw_event_id = NULL
         WHERE raw_event_id IN (SELECT id FROM expired)
       )
       DELETE FROM raw_events
       WHERE id IN (SELECT id FROM expired)`,
      [cutoff, boundedLimit],
    );
    await client.query("COMMIT");
    return { rawEvents: deleted.rowCount ?? 0 };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function pruneTimezoneCoverageAt(
  pool: CoverageRetentionPool,
  now = new Date(),
): Promise<{ timezoneCoverage: number }> {
  requireValidNow(now);
  const registry = await pool.query(
    `SELECT timezone
     FROM clickhouse_rollup_timezones
     ORDER BY activated_at, timezone
     LIMIT $1`,
    [MAX_ACTIVE_ROLLUP_TIMEZONES],
  );
  const timezones = registry.rows
    .slice(0, MAX_ACTIVE_ROLLUP_TIMEZONES)
    .map(({ timezone }) => timezone)
    .filter((timezone): timezone is string => typeof timezone === "string");
  if (timezones.length === 0) return { timezoneCoverage: 0 };

  const resolutions: string[] = [];
  const requestedTimezones: string[] = [];
  const cutoffs: Date[] = [];
  for (const timezone of timezones) {
    const cutoff = timezoneCoverageCutoffs(timezone, now);
    resolutions.push("hour", "day");
    requestedTimezones.push(timezone, timezone);
    cutoffs.push(cutoff.hour, cutoff.day);
  }
  const deleted = await pool.query(
    `DELETE FROM clickhouse_timezone_rollup_coverage AS coverage
     USING (
       SELECT *
       FROM unnest($1::text[], $2::text[], $3::timestamptz[])
         AS requested(resolution, timezone, cutoff)
     ) AS requested
     WHERE coverage.resolution = requested.resolution
       AND coverage.timezone = requested.timezone
       AND coverage.bucket < requested.cutoff`,
    [resolutions, requestedTimezones, cutoffs],
  );
  return { timezoneCoverage: deleted.rowCount ?? 0 };
}

function defaultDependencies(): UsageRetentionDependencies {
  return {
    prunePostgresRawEvents: (now) => prunePostgresRawEventsAt(getPool(), now),
    pruneTimezoneCoverage: (now) => pruneTimezoneCoverageAt(getPool(), now),
    pruneClickHouseUsageRetention,
    warn: (message) => console.warn(message),
  };
}

export async function runUsageRetentionAt(
  now = new Date(),
  dependencies: UsageRetentionDependencies = defaultDependencies(),
): Promise<UsageRetentionResult> {
  requireValidNow(now);
  const result: UsageRetentionResult = {
    postgresRawEvents: "completed",
    timezoneCoverage: "completed",
    clickhouseUsage: "completed",
  };
  const run = async (
    key: keyof UsageRetentionResult,
    cleanup: () => Promise<unknown>,
  ): Promise<void> => {
    try {
      await cleanup();
    } catch {
      result[key] = "failed";
      const retry = key === "postgresRawEvents" ? "retrying with backoff" : "retrying next daily tick";
      dependencies.warn(`[toard] ${key} retention cleanup failed — ${retry}`);
    }
  };

  await run("postgresRawEvents", () => dependencies.prunePostgresRawEvents(now));
  await run("timezoneCoverage", () => dependencies.pruneTimezoneCoverage(now));
  await run("clickhouseUsage", () => dependencies.pruneClickHouseUsageRetention(now));
  return result;
}

export function retentionSchedulerEligible(
  env: Record<string, string | undefined>,
): boolean {
  if (env.VERCEL) return false;
  return env.NODE_ENV === "production";
}

export function startUsageRetentionCleanup(): void {
  const globalState = globalThis as { __toardUsageRetentionStarted?: true };
  if (globalState.__toardUsageRetentionStarted) return;
  globalState.__toardUsageRetentionStarted = true;
  const dependencies = defaultDependencies();
  const rawDrain = createPostgresRawRetentionDrain({
    prunePostgresRawEvents: (now) => prunePostgresRawEventsAt(getPool(), now),
    now: () => new Date(),
    schedule: (callback, delayMs) => setTimeout(callback, delayMs),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    warn: dependencies.warn,
  });
  const scheduledDependencies: UsageRetentionDependencies = {
    ...dependencies,
    prunePostgresRawEvents: (now) => rawDrain.run(now),
  };
  const tick = () => void runUsageRetentionAt(new Date(), scheduledDependencies);
  setTimeout(tick, STARTUP_DELAY_MS).unref();
  setInterval(tick, DAILY_TICK_MS).unref();
}
