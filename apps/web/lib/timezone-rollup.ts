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
export const TIMEZONE_ROLLUP_MAX_JOBS_PER_TICK = 32;
export const TIMEZONE_ROLLUP_DAY_PREWARM_DAYS = 400;
export const TIMEZONE_ROLLUP_HOUR_PREWARM_DAYS = 32;
export const TIMEZONE_ROLLUP_PREWARM_CHUNK_BUCKETS = 16;

export type TimezoneRollupResolution = "hour" | "day";
export type TimezoneRollupJobStatus = "pending" | "inflight" | "done";
export type TimezoneRollupRegistration = "created" | "existing" | "capacity";

export type TimezoneRollupWindow = {
  bucket: Date;
  sourceTo: Date;
};

export type TimezoneRollupJob = {
  id: string;
  resolution: TimezoneRollupResolution;
  timezone: string;
  bucket: Date;
  sourceTo: Date;
  generation: number;
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
    windows: readonly TimezoneRollupWindow[],
  ): Promise<number>;
  claimJobs(limit: number): Promise<TimezoneRollupJob[]>;
  countBacklog(): Promise<{ eligible: number; waitingForBase: number }>;
  withAdvisoryLock<T>(
    key: string,
    operation: () => Promise<T>,
  ): Promise<{ acquired: false } | { acquired: true; value: T }>;
  markDone(id: string, generation: number): Promise<boolean>;
  markPending(id: string, generation: number): Promise<void>;
  disableTimezone(timezone: string): Promise<void>;
};

function requireCanonicalTimezone(timezone: string): string {
  const canonical = canonicalTimezoneId(timezone);
  if (!canonical) {
    throw new Error(`유효한 IANA 시간대가 아님: ${timezone}`);
  }
  return canonical;
}

/** coverage retention과 prewarm이 공유하는 DST-safe local calendar 경계. */
export function timezoneCoverageCutoffs(
  timezone: string,
  now = new Date(),
): { hour: Date; day: Date } {
  if (!Number.isFinite(now.getTime())) throw new Error("유효한 coverage 기준 시각이 아님");
  const canonical = requireCanonicalTimezone(timezone);
  const today = localDateKey(now, canonical);
  return {
    hour: firstInstantOfLocalDate(
      addLocalCalendarDays(today, -(TIMEZONE_ROLLUP_HOUR_PREWARM_DAYS - 1)),
      canonical,
    ),
    day: firstInstantOfLocalDate(
      addLocalCalendarDays(today, -(TIMEZONE_ROLLUP_DAY_PREWARM_DAYS - 1)),
      canonical,
    ),
  };
}

function dailyPrewarmWindows(timezone: string, now: Date): TimezoneRollupWindow[] {
  const firstDate = localDateKey(timezoneCoverageCutoffs(timezone, now).day, timezone);
  return Array.from(
    { length: TIMEZONE_ROLLUP_DAY_PREWARM_DAYS },
    (_, index) => {
      const date = addLocalCalendarDays(firstDate, index);
      return {
        bucket: firstInstantOfLocalDate(date, timezone),
        sourceTo: firstInstantOfLocalDate(addLocalCalendarDays(date, 1), timezone),
      };
    },
  );
}

function hourlyPrewarmWindows(timezone: string, now: Date): TimezoneRollupWindow[] {
  const today = localDateKey(now, timezone);
  const from = timezoneCoverageCutoffs(timezone, now).hour;
  const to = firstInstantOfLocalDate(addLocalCalendarDays(today, 1), timezone);
  const windows: TimezoneRollupWindow[] = [];
  for (let cursor = from.getTime(); cursor < to.getTime(); cursor += 60 * 60 * 1_000) {
    windows.push({
      bucket: new Date(cursor),
      sourceTo: new Date(cursor + 60 * 60 * 1_000),
    });
  }
  return windows;
}

function timezoneRollupWindow(
  resolution: TimezoneRollupResolution,
  timezone: string,
  bucket: Date,
): TimezoneRollupWindow {
  if (resolution === "hour") {
    return { bucket, sourceTo: new Date(bucket.getTime() + 60 * 60 * 1_000) };
  }
  const date = localDateKey(bucket, timezone);
  return {
    bucket,
    sourceTo: firstInstantOfLocalDate(addLocalCalendarDays(date, 1), timezone),
  };
}

export function timezonePrewarmWindows(
  resolution: TimezoneRollupResolution,
  timezone: string,
  now: Date,
): TimezoneRollupWindow[] {
  const canonical = requireCanonicalTimezone(timezone);
  if (!Number.isFinite(now.getTime())) throw new Error("유효한 prewarm 기준 시각이 아님");
  return resolution === "day"
    ? dailyPrewarmWindows(canonical, now)
    : hourlyPrewarmWindows(canonical, now);
}

async function prewarmMissingBuckets(
  repository: TimezoneRollupRepository,
  resolution: TimezoneRollupResolution,
  timezone: string,
  windows: readonly TimezoneRollupWindow[],
): Promise<number> {
  let inserted = 0;
  for (let offset = 0; offset < windows.length; offset += TIMEZONE_ROLLUP_PREWARM_CHUNK_BUCKETS) {
    inserted += await repository.prewarmMissingJobs(
      resolution,
      timezone,
      windows.slice(offset, offset + TIMEZONE_ROLLUP_PREWARM_CHUNK_BUCKETS),
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
  await repository.prewarmMissingJobs(
    resolution,
    canonical,
    [timezoneRollupWindow(resolution, canonical, bucket)],
  );
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
    timezonePrewarmWindows("day", canonical, now),
  );
  const hour = await prewarmMissingBuckets(
    repository,
    "hour",
    canonical,
    timezonePrewarmWindows("hour", canonical, now),
  );
  return { registration, prewarmed: { day, hour } };
}

export async function runTimezoneRollupWorkerWith(
  repository: TimezoneRollupRepository,
  compactor: TimezoneRollupCompactor,
  limit = TIMEZONE_ROLLUP_JOBS_PER_TICK,
): Promise<{ jobs: number; rows: number }> {
  const claimed = await repository.claimJobs(limit);
  let jobs = 0;
  let rows = 0;
  let failure: unknown;

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
        await repository.markPending(job.id, job.generation);
        continue;
      }
      const accepted = await repository.markDone(job.id, job.generation);
      if (!accepted) {
        await repository.markPending(job.id, job.generation);
        continue;
      }
      jobs++;
      rows += result.value;
    } catch (error) {
      try {
        await repository.markPending(job.id, job.generation);
      } catch (markPendingError) {
        failure ??= markPendingError;
        continue;
      }
      failure ??= error;
    }
  }

  if (failure) throw failure;
  return { jobs, rows };
}

export class PgTimezoneRollupRepository implements TimezoneRollupRepository {
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
    windows: readonly TimezoneRollupWindow[],
  ): Promise<number> {
    if (windows.length === 0) return 0;
    const inserted = await this.pool.query(
      `WITH requested(bucket, source_to) AS (
         SELECT *
         FROM unnest($3::timestamptz[], $4::timestamptz[])
       ), missing AS (
         SELECT requested.bucket, requested.source_to
         FROM requested
         WHERE NOT EXISTS (
           SELECT 1
           FROM clickhouse_timezone_rollup_coverage AS coverage
           WHERE coverage.resolution = $1
             AND coverage.timezone = $2
             AND coverage.bucket = requested.bucket
         )
       )
       INSERT INTO clickhouse_timezone_rollup_jobs (resolution, timezone, bucket, source_to)
       SELECT $1, $2, bucket, source_to
       FROM missing
       ON CONFLICT (resolution, timezone, bucket) DO NOTHING`,
      [
        resolution,
        timezone,
        windows.map(({ bucket }) => bucket),
        windows.map(({ sourceTo }) => sourceTo),
      ],
    );
    return inserted.rowCount ?? 0;
  }

  async claimJobs(limit: number): Promise<TimezoneRollupJob[]> {
    const claimed = await this.pool.query<{
      id: string;
      resolution: TimezoneRollupResolution;
      timezone: string;
      bucket: Date;
      source_to: Date;
      generation: string | number;
    }>(
      `WITH candidate AS (
         SELECT job.id
         FROM clickhouse_timezone_rollup_jobs AS job
         JOIN clickhouse_rollup_watermarks AS watermark
           ON watermark.name = 'usage_15m_v2'
         WHERE (
             job.status = 'pending'
             OR (job.status = 'inflight' AND job.updated_at < now() - interval '5 minutes')
           )
           AND job.source_to <= watermark.watermark
           AND NOT EXISTS (
             SELECT 1
             FROM clickhouse_rollup_dirty_buckets AS dirty
             WHERE dirty.name = 'usage_15m_v2'
               AND dirty.bucket >= job.bucket
               AND dirty.bucket < job.source_to
           )
         ORDER BY job.created_at, job.id
         LIMIT $1
         FOR UPDATE OF job SKIP LOCKED
       )
       UPDATE clickhouse_timezone_rollup_jobs AS job
       SET status = 'inflight', updated_at = now()
       FROM candidate
       WHERE job.id = candidate.id
       RETURNING job.id::text, job.resolution, job.timezone, job.bucket,
                 job.source_to, job.generation`,
      [Math.min(TIMEZONE_ROLLUP_MAX_JOBS_PER_TICK, Math.max(0, Math.floor(limit)))],
    );
    return claimed.rows.map((job) => ({
      id: job.id,
      resolution: job.resolution,
      timezone: job.timezone,
      bucket: job.bucket,
      sourceTo: job.source_to,
      generation: Number(job.generation),
      status: "inflight",
    }));
  }

  async countBacklog(): Promise<{ eligible: number; waitingForBase: number }> {
    const result = await this.pool.query<{
      eligible: string | number;
      waiting_for_base: string | number;
    }>(
      `WITH backlog AS (
         SELECT watermark.watermark IS NOT NULL
           AND job.source_to <= watermark.watermark
           AND NOT EXISTS (
             SELECT 1
             FROM clickhouse_rollup_dirty_buckets AS dirty
             WHERE dirty.name = 'usage_15m_v2'
               AND dirty.bucket >= job.bucket
               AND dirty.bucket < job.source_to
           ) AS eligible
         FROM clickhouse_timezone_rollup_jobs AS job
         LEFT JOIN clickhouse_rollup_watermarks AS watermark
           ON watermark.name = 'usage_15m_v2'
         WHERE job.status = 'pending'
            OR (job.status = 'inflight' AND job.updated_at < now() - interval '5 minutes')
       )
       SELECT count(*) FILTER (WHERE eligible)::int AS eligible,
              count(*) FILTER (WHERE NOT eligible)::int AS waiting_for_base
       FROM backlog`,
    );
    return {
      eligible: Number(result.rows[0]?.eligible ?? 0),
      waitingForBase: Number(result.rows[0]?.waiting_for_base ?? 0),
    };
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

  async markDone(id: string, generation: number): Promise<boolean> {
    const result = await this.pool.query<{ completed: string | number }>(
      `WITH eligible AS (
         SELECT job.id
         FROM clickhouse_timezone_rollup_jobs AS job
         JOIN clickhouse_rollup_watermarks AS watermark
           ON watermark.name = 'usage_15m_v2'
         WHERE job.id = $1
           AND job.generation = $2
           AND job.status = 'inflight'
           AND job.source_to <= watermark.watermark
           AND NOT EXISTS (
             SELECT 1
             FROM clickhouse_rollup_dirty_buckets AS dirty
             WHERE dirty.name = 'usage_15m_v2'
               AND dirty.bucket >= job.bucket
               AND dirty.bucket < job.source_to
           )
         FOR UPDATE OF job
       ), completed AS (
         UPDATE clickhouse_timezone_rollup_jobs AS job
         SET status = 'done', updated_at = now()
         FROM eligible
         WHERE job.id = eligible.id
         RETURNING job.resolution, job.timezone, job.bucket
       ), covered AS (
         INSERT INTO clickhouse_timezone_rollup_coverage (resolution, timezone, bucket)
         SELECT resolution, timezone, bucket
         FROM completed
         ON CONFLICT (resolution, timezone, bucket) DO UPDATE
         SET updated_at = now()
         RETURNING 1
       )
       SELECT (SELECT count(*) FROM completed)::int AS completed,
              (SELECT count(*) FROM covered)::int AS covered`,
      [id, generation],
    );
    return Number(result.rows[0]?.completed ?? 0) > 0;
  }

  async markPending(id: string, generation: number): Promise<void> {
    await this.pool.query(
      `UPDATE clickhouse_timezone_rollup_jobs
       SET status = 'pending', updated_at = now()
       WHERE id = $1
         AND generation = $2
         AND status = 'inflight'`,
      [id, generation],
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

export async function countTimezoneRollupBacklog(): Promise<{
  eligible: number;
  waitingForBase: number;
}> {
  return new PgTimezoneRollupRepository(getPool()).countBacklog();
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

export async function runTimezoneRollupWorker(limit?: number): Promise<{ jobs: number; rows: number }> {
  if (process.env.STORAGE_BACKEND !== "clickhouse") return { jobs: 0, rows: 0 };
  const { getStorage } = await import("./storage");
  const storage = getStorage();
  if (!isTimezoneRollupCompactor(storage) || !isTimezoneCapability(storage)) return { jobs: 0, rows: 0 };
  return runTimezoneRollupWorkerWith(new PgTimezoneRollupRepository(getPool()), storage, limit);
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
