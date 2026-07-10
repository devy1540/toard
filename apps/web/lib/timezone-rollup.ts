import {
  addLocalCalendarDays,
  canonicalTimezoneId,
  firstInstantOfLocalDate,
  localDateKey,
} from "@toard/core";
import type { Pool } from "pg";
import { getPool } from "./db";
import { getOrgTimezone } from "./org-time";

export const MAX_ACTIVE_ROLLUP_TIMEZONES = 64;
export const TIMEZONE_ROLLUP_JOBS_PER_TICK = 8;
export const TIMEZONE_ROLLUP_DAY_PREWARM_DAYS = 400;
export const TIMEZONE_ROLLUP_HOUR_PREWARM_DAYS = 32;
export const TIMEZONE_ROLLUP_PREWARM_CHUNK_BUCKETS = 16;

export type TimezoneRollupResolution = "hour" | "day";
export type TimezoneRollupJobStatus = "pending" | "inflight" | "done";
export type TimezoneRollupRegistration = "created" | "existing" | "capacity";

export type TimezoneRollupJob = {
  id: string;
  resolution: TimezoneRollupResolution;
  timezone: string;
  bucket: Date;
  status: TimezoneRollupJobStatus;
};

export type TimezoneRollupCompactor = {
  supportsTimezone(timezone: string): Promise<boolean>;
  compactTimezoneRollup(
    resolution: TimezoneRollupResolution,
    timezone: string,
    bucket: Date,
  ): Promise<number>;
};

type TimezoneCapability = {
  supportsTimezone(timezone: string): Promise<boolean>;
};

export type TimezoneRollupRepository = {
  ensureRegisteredTimezone(timezone: string, maximum: number): Promise<TimezoneRollupRegistration>;
  prewarmMissingJobs(
    resolution: TimezoneRollupResolution,
    timezone: string,
    buckets: readonly Date[],
  ): Promise<number>;
  claimJobs(limit: number): Promise<TimezoneRollupJob[]>;
  withAdvisoryLock<T>(
    key: string,
    operation: () => Promise<T>,
  ): Promise<{ acquired: false } | { acquired: true; value: T }>;
  markDone(id: string): Promise<void>;
  markPending(id: string): Promise<void>;
  disableTimezone(timezone: string): Promise<void>;
};

function requireCanonicalTimezone(timezone: string): string {
  const canonical = canonicalTimezoneId(timezone);
  if (!canonical) {
    throw new Error(`유효한 IANA 시간대가 아님: ${timezone}`);
  }
  return canonical;
}

function dailyPrewarmBuckets(timezone: string, now: Date): Date[] {
  const today = localDateKey(now, timezone);
  return Array.from(
    { length: TIMEZONE_ROLLUP_DAY_PREWARM_DAYS },
    (_, index) => firstInstantOfLocalDate(
      addLocalCalendarDays(today, index - TIMEZONE_ROLLUP_DAY_PREWARM_DAYS + 1),
      timezone,
    ),
  );
}

function hourlyPrewarmBuckets(timezone: string, now: Date): Date[] {
  const today = localDateKey(now, timezone);
  const from = firstInstantOfLocalDate(
    addLocalCalendarDays(today, -TIMEZONE_ROLLUP_HOUR_PREWARM_DAYS + 1),
    timezone,
  );
  const to = firstInstantOfLocalDate(addLocalCalendarDays(today, 1), timezone);
  const buckets: Date[] = [];
  for (let cursor = from.getTime(); cursor < to.getTime(); cursor += 60 * 60 * 1_000) {
    buckets.push(new Date(cursor));
  }
  return buckets;
}

async function prewarmMissingBuckets(
  repository: TimezoneRollupRepository,
  resolution: TimezoneRollupResolution,
  timezone: string,
  buckets: readonly Date[],
): Promise<number> {
  let inserted = 0;
  for (let offset = 0; offset < buckets.length; offset += TIMEZONE_ROLLUP_PREWARM_CHUNK_BUCKETS) {
    inserted += await repository.prewarmMissingJobs(
      resolution,
      timezone,
      buckets.slice(offset, offset + TIMEZONE_ROLLUP_PREWARM_CHUNK_BUCKETS),
    );
  }
  return inserted;
}

export async function enqueueTimezoneRollupWith(
  repository: TimezoneRollupRepository,
  resolution: TimezoneRollupResolution,
  timezone: string,
  bucket: Date,
): Promise<void> {
  const canonical = requireCanonicalTimezone(timezone);
  if (!Number.isFinite(bucket.getTime())) throw new Error("유효한 시간대 rollup bucket이 아님");
  await repository.prewarmMissingJobs(resolution, canonical, [bucket]);
}

export async function activateTimezoneRollupWith(
  repository: TimezoneRollupRepository,
  timezone: string,
  now = new Date(),
  supportsTimezone: (timezone: string) => Promise<boolean> = async () => true,
): Promise<{
  registration: Exclude<TimezoneRollupRegistration, "capacity">;
  prewarmed: Record<TimezoneRollupResolution, number>;
}> {
  const canonical = requireCanonicalTimezone(timezone);
  if (!(await supportsTimezone(canonical))) {
    throw new Error(`ClickHouse가 지원하지 않는 IANA 시간대: ${canonical}`);
  }
  const registration = await repository.ensureRegisteredTimezone(
    canonical,
    MAX_ACTIVE_ROLLUP_TIMEZONES,
  );
  if (registration === "capacity") {
    throw new Error(`활성 시간대는 최대 ${MAX_ACTIVE_ROLLUP_TIMEZONES}개까지 등록할 수 있음`);
  }

  const day = await prewarmMissingBuckets(
    repository,
    "day",
    canonical,
    dailyPrewarmBuckets(canonical, now),
  );
  const hour = await prewarmMissingBuckets(
    repository,
    "hour",
    canonical,
    hourlyPrewarmBuckets(canonical, now),
  );
  return { registration, prewarmed: { day, hour } };
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
      if (!(await compactor.supportsTimezone(job.timezone))) {
        await repository.disableTimezone(job.timezone);
        continue;
      }
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

  async ensureRegisteredTimezone(
    timezone: string,
    maximum: number,
  ): Promise<TimezoneRollupRegistration> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["timezone-rollup-registry"]);
      const existing = await client.query("SELECT 1 FROM clickhouse_rollup_timezones WHERE timezone = $1", [timezone]);
      const registration = existing.rowCount === 0 ? "created" : "existing";
      if (registration === "created") {
        const count = await client.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM clickhouse_rollup_timezones",
        );
        if ((count.rows[0]?.count ?? 0) >= maximum) {
          await client.query("COMMIT");
          return "capacity";
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
      return registration;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async prewarmMissingJobs(
    resolution: TimezoneRollupResolution,
    timezone: string,
    buckets: readonly Date[],
  ): Promise<number> {
    if (buckets.length === 0) return 0;
    const inserted = await this.pool.query(
      `WITH requested(bucket) AS (
         SELECT unnest($3::timestamptz[])
       ), missing AS (
         SELECT requested.bucket
         FROM requested
         WHERE NOT EXISTS (
           SELECT 1
           FROM clickhouse_timezone_rollup_coverage AS coverage
           WHERE coverage.resolution = $1
             AND coverage.timezone = $2
             AND coverage.bucket = requested.bucket
         )
       )
       INSERT INTO clickhouse_timezone_rollup_jobs (resolution, timezone, bucket)
       SELECT $1, $2, bucket
       FROM missing
       ON CONFLICT (resolution, timezone, bucket) DO NOTHING`,
      [resolution, timezone, buckets],
    );
    return inserted.rowCount ?? 0;
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
      `WITH completed AS (
         UPDATE clickhouse_timezone_rollup_jobs
         SET status = 'done', updated_at = now()
         WHERE id = $1
           AND status = 'inflight'
         RETURNING resolution, timezone, bucket
       )
       INSERT INTO clickhouse_timezone_rollup_coverage (resolution, timezone, bucket)
       SELECT resolution, timezone, bucket
       FROM completed
       ON CONFLICT (resolution, timezone, bucket) DO UPDATE
       SET updated_at = now()`,
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

  async disableTimezone(timezone: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE clickhouse_timezone_rollup_jobs
         SET status = 'done', updated_at = now()
         WHERE timezone = $1 AND status != 'done'`,
        [timezone],
      );
      await client.query("DELETE FROM clickhouse_rollup_timezones WHERE timezone = $1", [timezone]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

export function createPgTimezoneRollupRepository(pool: Pool): TimezoneRollupRepository {
  return new PgTimezoneRollupRepository(pool);
}

function isTimezoneRollupCompactor(storage: unknown): storage is TimezoneRollupCompactor {
  return typeof (storage as { compactTimezoneRollup?: unknown }).compactTimezoneRollup === "function";
}

function isTimezoneCapability(storage: unknown): storage is TimezoneCapability {
  return typeof (storage as { supportsTimezone?: unknown }).supportsTimezone === "function";
}

const timezoneCapabilityCache = new Map<string, Promise<boolean>>();

async function productionSupportsTimezone(timezone: string): Promise<boolean> {
  if (process.env.STORAGE_BACKEND !== "clickhouse") return true;
  let check = timezoneCapabilityCache.get(timezone);
  if (!check) {
    check = import("./storage")
      .then(({ getStorage }) => {
        const storage = getStorage();
        return isTimezoneCapability(storage) ? storage.supportsTimezone(timezone) : false;
      })
      .catch((error) => {
        timezoneCapabilityCache.delete(timezone);
        throw error;
      });
    timezoneCapabilityCache.set(timezone, check);
  }
  return check;
}

export async function resolveSupportedRollupTimezone(
  timezone: string,
  supportsTimezone: (timezone: string) => Promise<boolean> = productionSupportsTimezone,
): Promise<string | null> {
  const canonical = canonicalTimezoneId(timezone);
  if (!canonical) return null;
  return (await supportsTimezone(canonical)) ? canonical : null;
}

export type PersistedTimezoneRollupActivationResult = {
  activated: string[];
  skipped: string[];
  failed: string[];
};

export async function activatePersistedTimezoneRollupsWith(
  inputs: {
    orgTimezone: string;
    savedTimezones: readonly (string | null)[];
  },
  supportsTimezone: (timezone: string) => Promise<boolean> = productionSupportsTimezone,
  activate: (timezone: string) => Promise<void> = activateTimezoneRollup,
): Promise<PersistedTimezoneRollupActivationResult> {
  const result: PersistedTimezoneRollupActivationResult = {
    activated: [],
    skipped: [],
    failed: [],
  };
  const canonicalTimezones = new Set<string>();
  for (const raw of [inputs.orgTimezone, ...inputs.savedTimezones]) {
    if (!raw?.trim()) continue;
    try {
      const canonical = await resolveSupportedRollupTimezone(raw, supportsTimezone);
      if (!canonical) {
        result.skipped.push(raw);
        continue;
      }
      canonicalTimezones.add(canonical);
    } catch {
      result.failed.push(raw);
    }
  }

  for (const timezone of canonicalTimezones) {
    try {
      await activate(timezone);
      result.activated.push(timezone);
    } catch {
      result.failed.push(timezone);
    }
  }
  return result;
}

export async function activatePersistedTimezoneRollups(): Promise<PersistedTimezoneRollupActivationResult> {
  if (process.env.STORAGE_BACKEND !== "clickhouse") {
    return { activated: [], skipped: [], failed: [] };
  }
  const saved = await getPool().query<{ timezone: string }>(
    `SELECT DISTINCT timezone
     FROM users
     WHERE timezone IS NOT NULL
       AND btrim(timezone) != ''
     ORDER BY timezone`,
  );
  return activatePersistedTimezoneRollupsWith({
    orgTimezone: getOrgTimezone(),
    savedTimezones: saved.rows.map(({ timezone }) => timezone),
  });
}

export function activatePersistedTimezoneRollupsNonBlocking(): void {
  void activatePersistedTimezoneRollups()
    .then((result) => {
      if (result.failed.length > 0) {
        console.warn(
          `[toard] timezone rollup startup activation incomplete — retry on next startup/read: ${result.failed.join(", ")}`,
        );
      }
    })
    .catch((error) => {
      console.warn(`[toard] timezone rollup startup activation failed — retrying on next startup: ${String(error)}`);
    });
}

export async function activateTimezoneRollup(timezone: string): Promise<void> {
  const canonical = await resolveSupportedRollupTimezone(timezone);
  if (!canonical) throw new Error(`지원하지 않는 IANA 시간대: ${timezone}`);
  if (process.env.STORAGE_BACKEND !== "clickhouse") return;
  await activateTimezoneRollupWith(
    new PgTimezoneRollupRepository(getPool()),
    canonical,
    new Date(),
    async () => true,
  );
}

export async function enqueueTimezoneRollup(
  resolution: TimezoneRollupResolution,
  timezone: string,
  bucket: Date,
): Promise<void> {
  const canonical = await resolveSupportedRollupTimezone(timezone);
  if (!canonical) throw new Error(`지원하지 않는 IANA 시간대: ${timezone}`);
  if (!Number.isFinite(bucket.getTime())) throw new Error("유효한 시간대 rollup bucket이 아님");
  if (process.env.STORAGE_BACKEND !== "clickhouse") return;
  await enqueueTimezoneRollupWith(new PgTimezoneRollupRepository(getPool()), resolution, canonical, bucket);
}

export async function runTimezoneRollupWorker(): Promise<{ jobs: number; rows: number }> {
  if (process.env.STORAGE_BACKEND !== "clickhouse") return { jobs: 0, rows: 0 };
  const { getStorage } = await import("./storage");
  const storage = getStorage();
  if (!isTimezoneRollupCompactor(storage) || !isTimezoneCapability(storage)) return { jobs: 0, rows: 0 };
  return runTimezoneRollupWorkerWith(new PgTimezoneRollupRepository(getPool()), storage);
}

export function createTimezoneRollupActivationGate(
  activate: (timezone: string) => Promise<void>,
): (timezone: string) => void {
  const activated = new Set<string>();
  return (timezone) => {
    const canonical = canonicalTimezoneId(timezone);
    if (!canonical || activated.has(canonical)) return;
    activated.add(canonical);
    void activate(canonical).catch(() => {
      activated.delete(canonical);
    });
  };
}

export const activateTimezoneRollupNonBlocking = createTimezoneRollupActivationGate(
  async (timezone) => { await activateTimezoneRollup(timezone); },
);
