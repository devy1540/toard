import type { Pool } from "pg";
import { getPool } from "./db";
import { dayStartUtc, isValidTimezone } from "./org-time";

export const MAX_ACTIVE_ROLLUP_TIMEZONES = 64;
export const TIMEZONE_ROLLUP_JOBS_PER_TICK = 8;

const TIMEZONE_ROLLUP_PREWARM_DAYS = 400;
const TIMEZONE_ROLLUP_PREWARM_CHUNK_DAYS = 16;

export type TimezoneRollupResolution = "hour" | "day";
export type TimezoneRollupJobStatus = "pending" | "inflight" | "done";

export type TimezoneRollupJob = {
  id: string;
  resolution: TimezoneRollupResolution;
  timezone: string;
  bucket: Date;
  status: TimezoneRollupJobStatus;
};

export type TimezoneRollupCompactor = {
  compactTimezoneRollup(
    resolution: TimezoneRollupResolution,
    timezone: string,
    bucket: Date,
  ): Promise<number>;
};

export type TimezoneRollupRepository = {
  activateTimezone(timezone: string, maximum: number): Promise<boolean>;
  enqueueJobs(
    resolution: TimezoneRollupResolution,
    timezone: string,
    buckets: readonly Date[],
  ): Promise<void>;
  claimJobs(limit: number): Promise<TimezoneRollupJob[]>;
  withAdvisoryLock<T>(
    key: string,
    operation: () => Promise<T>,
  ): Promise<{ acquired: false } | { acquired: true; value: T }>;
  markDone(id: string): Promise<void>;
  markPending(id: string): Promise<void>;
};

export function isValidRollupTimezone(timezone: string): boolean {
  const hasIanaNameShape = timezone === "UTC"
    || /^[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)+$/.test(timezone);
  return hasIanaNameShape && isValidTimezone(timezone);
}

function assertIanaTimezone(timezone: string): void {
  if (!isValidRollupTimezone(timezone)) {
    throw new Error(`유효한 IANA 시간대가 아님: ${timezone}`);
  }
}

function localDateKey(at: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

function addCalendarDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
}

function dailyPrewarmBuckets(timezone: string, now: Date): Date[] {
  const today = localDateKey(now, timezone);
  return Array.from(
    { length: TIMEZONE_ROLLUP_PREWARM_DAYS },
    (_, index) => dayStartUtc(addCalendarDays(today, index - TIMEZONE_ROLLUP_PREWARM_DAYS + 1), timezone),
  );
}

export async function enqueueTimezoneRollupWith(
  repository: TimezoneRollupRepository,
  resolution: TimezoneRollupResolution,
  timezone: string,
  bucket: Date,
): Promise<void> {
  assertIanaTimezone(timezone);
  if (!Number.isFinite(bucket.getTime())) throw new Error("유효한 시간대 rollup bucket이 아님");
  await repository.enqueueJobs(resolution, timezone, [bucket]);
}

export async function activateTimezoneRollupWith(
  repository: TimezoneRollupRepository,
  timezone: string,
  now = new Date(),
): Promise<void> {
  assertIanaTimezone(timezone);
  const active = await repository.activateTimezone(timezone, MAX_ACTIVE_ROLLUP_TIMEZONES);
  if (!active) {
    throw new Error(`활성 시간대는 최대 ${MAX_ACTIVE_ROLLUP_TIMEZONES}개까지 등록할 수 있음`);
  }

  const buckets = dailyPrewarmBuckets(timezone, now);
  for (let offset = 0; offset < buckets.length; offset += TIMEZONE_ROLLUP_PREWARM_CHUNK_DAYS) {
    await repository.enqueueJobs(
      "day",
      timezone,
      buckets.slice(offset, offset + TIMEZONE_ROLLUP_PREWARM_CHUNK_DAYS),
    );
  }
}

export async function runTimezoneRollupWorkerWith(
  repository: TimezoneRollupRepository,
  compactor: TimezoneRollupCompactor,
): Promise<{ jobs: number; rows: number }> {
  const claimed = await repository.claimJobs(TIMEZONE_ROLLUP_JOBS_PER_TICK);
  let jobs = 0;
  let rows = 0;

  for (const job of claimed) {
    try {
      const result = await repository.withAdvisoryLock(
        `timezone-rollup:${job.resolution}:${job.timezone}`,
        () => compactor.compactTimezoneRollup(job.resolution, job.timezone, job.bucket),
      );
      if (!result.acquired) {
        await repository.markPending(job.id);
        continue;
      }
      await repository.markDone(job.id);
      jobs++;
      rows += result.value;
    } catch {
      await repository.markPending(job.id);
    }
  }

  return { jobs, rows };
}

class PgTimezoneRollupRepository implements TimezoneRollupRepository {
  constructor(private readonly pool: Pool) {}

  async activateTimezone(timezone: string, maximum: number): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["timezone-rollup-registry"]);
      const existing = await client.query("SELECT 1 FROM clickhouse_rollup_timezones WHERE timezone = $1", [timezone]);
      if (existing.rowCount === 0) {
        const count = await client.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM clickhouse_rollup_timezones",
        );
        if ((count.rows[0]?.count ?? 0) >= maximum) {
          await client.query("COMMIT");
          return false;
        }
      }
      await client.query(
        `INSERT INTO clickhouse_rollup_timezones (timezone)
         VALUES ($1)
         ON CONFLICT (timezone) DO UPDATE
         SET last_requested_at = now()`,
        [timezone],
      );
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async enqueueJobs(
    resolution: TimezoneRollupResolution,
    timezone: string,
    buckets: readonly Date[],
  ): Promise<void> {
    if (buckets.length === 0) return;
    await this.pool.query(
      `INSERT INTO clickhouse_timezone_rollup_jobs (resolution, timezone, bucket)
       SELECT $1, $2, bucket
       FROM unnest($3::timestamptz[]) AS bucket
       ON CONFLICT (resolution, timezone, bucket) DO UPDATE
       SET status = 'pending', updated_at = now()`,
      [resolution, timezone, buckets],
    );
  }

  async claimJobs(limit: number): Promise<TimezoneRollupJob[]> {
    const claimed = await this.pool.query<{
      id: string;
      resolution: TimezoneRollupResolution;
      timezone: string;
      bucket: Date;
    }>(
      `WITH candidate AS (
         SELECT id
         FROM clickhouse_timezone_rollup_jobs
         WHERE status = 'pending'
            OR (status = 'inflight' AND updated_at < now() - interval '5 minutes')
         ORDER BY created_at, id
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE clickhouse_timezone_rollup_jobs AS job
       SET status = 'inflight', updated_at = now()
       FROM candidate
       WHERE job.id = candidate.id
       RETURNING job.id::text, job.resolution, job.timezone, job.bucket`,
      [Math.min(TIMEZONE_ROLLUP_JOBS_PER_TICK, Math.max(0, Math.floor(limit)))],
    );
    return claimed.rows.map((job) => ({ ...job, status: "inflight" }));
  }

  async withAdvisoryLock<T>(
    key: string,
    operation: () => Promise<T>,
  ): Promise<{ acquired: false } | { acquired: true; value: T }> {
    const client = await this.pool.connect();
    try {
      const locked = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
        [key],
      );
      if (!locked.rows[0]?.locked) return { acquired: false };
      return { acquired: true, value: await operation() };
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [key]).catch(() => undefined);
      client.release();
    }
  }

  async markDone(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE clickhouse_timezone_rollup_jobs
       SET status = 'done', updated_at = now()
       WHERE id = $1
         AND status = 'inflight'`,
      [id],
    );
  }

  async markPending(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE clickhouse_timezone_rollup_jobs
       SET status = 'pending', updated_at = now()
       WHERE id = $1`,
      [id],
    );
  }
}

function isTimezoneRollupCompactor(storage: unknown): storage is TimezoneRollupCompactor {
  return typeof (storage as { compactTimezoneRollup?: unknown }).compactTimezoneRollup === "function";
}

export async function activateTimezoneRollup(timezone: string): Promise<void> {
  assertIanaTimezone(timezone);
  if (process.env.STORAGE_BACKEND !== "clickhouse") return;
  await activateTimezoneRollupWith(new PgTimezoneRollupRepository(getPool()), timezone);
}

export async function enqueueTimezoneRollup(
  resolution: TimezoneRollupResolution,
  timezone: string,
  bucket: Date,
): Promise<void> {
  assertIanaTimezone(timezone);
  if (!Number.isFinite(bucket.getTime())) throw new Error("유효한 시간대 rollup bucket이 아님");
  if (process.env.STORAGE_BACKEND !== "clickhouse") return;
  await enqueueTimezoneRollupWith(new PgTimezoneRollupRepository(getPool()), resolution, timezone, bucket);
}

export async function runTimezoneRollupWorker(): Promise<{ jobs: number; rows: number }> {
  if (process.env.STORAGE_BACKEND !== "clickhouse") return { jobs: 0, rows: 0 };
  const { getStorage } = await import("./storage");
  const storage = getStorage();
  if (!isTimezoneRollupCompactor(storage)) return { jobs: 0, rows: 0 };
  return runTimezoneRollupWorkerWith(new PgTimezoneRollupRepository(getPool()), storage);
}

export function createTimezoneRollupActivationGate(
  activate: (timezone: string) => Promise<void>,
): (timezone: string) => void {
  const activated = new Set<string>();
  return (timezone) => {
    if (activated.has(timezone)) return;
    activated.add(timezone);
    void activate(timezone).catch(() => {
      activated.delete(timezone);
    });
  };
}

export const activateTimezoneRollupNonBlocking = createTimezoneRollupActivationGate(
  activateTimezoneRollup,
);
