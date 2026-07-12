import { CLICKHOUSE_RAW_RETENTION_DAYS } from "@toard/core";
import { resolveClickHouseRollupReadFlag } from "@toard/storage-clickhouse";
import {
  PgRollupWorkerRepository,
  sanitizeRollupError,
  shadowWorkerEnabled,
  type RollupWorkerName,
  type RollupWorkerRepository,
} from "./rollup-worker-state";

const STARTUP_DELAY_MS = 15_000;
const TICK_MS = 30_000;
const COMPACTOR_TICK_MS = 60_000;
const DEFAULT_LIMIT = 10;
const DELIVERED_RETENTION_MS = CLICKHOUSE_RAW_RETENTION_DAYS * 24 * 60 * 60 * 1_000;
const COMPLETED_JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const TIMEZONE_ROLLUP_MAX_LAG_SECONDS = 30 * 60;
const TIMEZONE_ROLLUP_MAX_PENDING_JOBS = 10_000;
const ROLLUP_BUCKET_MS = 15 * 60 * 1_000;
const DEFAULT_ROLLUP_FINALIZE_DELAY_MS = 30 * 60 * 1_000;

export type ClickHouseUsageRetentionResult = {
  deliveredOutboxRows: number;
  deliveredBatches: number;
  completedTimezoneJobs: number;
};

type RetentionClient = {
  query(sql: string, params?: unknown[]): Promise<{ rowCount: number | null }>;
  release(): void;
};

type RetentionPool = {
  connect(): Promise<RetentionClient>;
};

type ReadyQueryable = {
  query(sql: string, params?: unknown[]): Promise<{
    rows: Array<Record<string, unknown>>;
  }>;
};

type ReadyEnvironment = Record<string, string | undefined>;

export type TimezoneRollupReadiness = {
  status: "disabled" | "healthy" | "fallback";
  watermark: string | null;
  lagSeconds: number | null;
  pendingJobs: number;
  legacyFlagMigration: "deprecated_alias" | null;
};

export type TimezoneRollupReadyPayload = {
  timezone: TimezoneRollupReadiness["status"];
  timezoneWatermark: string | null;
  timezoneLagSeconds: number | null;
  timezonePendingJobs: number;
  legacyFlagMigration: "deprecated_alias" | null;
};

export async function runObservedWorkerTick(options: {
  worker: RollupWorkerName;
  hardEnabled: boolean;
  repository: RollupWorkerRepository;
  run(): Promise<{ units: number; rows: number }>;
  now(): Date;
}): Promise<"disabled" | "paused" | "completed" | "failed"> {
  if (!options.hardEnabled) return "disabled";
  const record = await options.repository.get(options.worker);
  if (record.paused) return "paused";

  const warnObservationFailure = (error: unknown) => {
    console.warn(
      `[toard] ${options.worker} worker observation write failed — ${sanitizeRollupError(error)}`,
    );
  };
  const startedAt = options.now();
  await options.repository.markStarted(options.worker, startedAt).catch(warnObservationFailure);
  try {
    const result = await options.run();
    await options.repository
      .markSucceeded(options.worker, startedAt, options.now(), result)
      .catch(warnObservationFailure);
    return "completed";
  } catch (error) {
    await options.repository
      .markFailed(
        options.worker,
        startedAt,
        options.now(),
        sanitizeRollupError(error),
      )
      .catch(warnObservationFailure);
    return "failed";
  }
}

export function toTimezoneRollupReadyPayload(
  readiness: TimezoneRollupReadiness,
): TimezoneRollupReadyPayload {
  return {
    timezone: readiness.status,
    timezoneWatermark: readiness.watermark,
    timezoneLagSeconds: readiness.lagSeconds,
    timezonePendingJobs: readiness.pendingJobs,
    legacyFlagMigration: readiness.legacyFlagMigration,
  };
}

type FlushableStorage = {
  flushUsageOutbox(limit?: number): Promise<{ batches: number; rows: number }>;
};

type CompactableStorage = {
  compactUsage15mRollup(limitBuckets?: number): Promise<{ buckets: number; rows: number; watermark: string }>;
};

type V2CompactableStorage = {
  compactUsage15mV2(limitBuckets?: number): Promise<{ buckets: number; rows: number; watermark: string }>;
};

function isFlushable(storage: unknown): storage is FlushableStorage {
  return typeof (storage as { flushUsageOutbox?: unknown }).flushUsageOutbox === "function";
}

function isCompactable(storage: unknown): storage is CompactableStorage {
  return typeof (storage as { compactUsage15mRollup?: unknown }).compactUsage15mRollup === "function";
}

function isV2Compactable(storage: unknown): storage is V2CompactableStorage {
  return typeof (storage as { compactUsage15mV2?: unknown }).compactUsage15mV2 === "function";
}

function enabled(name: string): boolean {
  return enabledIn(process.env, name);
}

function enabledIn(env: ReadyEnvironment, name: string): boolean {
  const value = env[name];
  return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "on";
}

function rollupFinalizeDelayMs(env: ReadyEnvironment): number {
  const parsed = Number(env.CLICKHOUSE_ROLLUP_FINALIZE_DELAY_MS);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_ROLLUP_FINALIZE_DELAY_MS;
}

export async function getTimezoneRollupReadinessAt(
  pool: ReadyQueryable,
  env: ReadyEnvironment = process.env,
  now = new Date(),
): Promise<TimezoneRollupReadiness> {
  const rollupRead = resolveClickHouseRollupReadFlag(env);
  if (!rollupRead.enabled) {
    return {
      status: rollupRead.legacyFlagMigration ? "fallback" : "disabled",
      watermark: null,
      lagSeconds: null,
      pendingJobs: 0,
      legacyFlagMigration: rollupRead.legacyFlagMigration,
    };
  }
  const [watermarkResult, pendingResult] = await Promise.all([
    pool.query(
      "SELECT watermark FROM clickhouse_rollup_watermarks WHERE name = $1",
      ["usage_15m_v2"],
    ),
    pool.query(
      `SELECT count(*)::int AS pending_jobs
       FROM clickhouse_timezone_rollup_jobs
       WHERE status = 'pending'`,
    ),
  ]);
  const rawWatermark = watermarkResult.rows[0]?.watermark;
  const parsedWatermark = rawWatermark instanceof Date
    ? rawWatermark
    : typeof rawWatermark === "string"
      ? new Date(rawWatermark)
      : null;
  const watermark = parsedWatermark && Number.isFinite(parsedWatermark.getTime())
    ? parsedWatermark
    : null;
  const rawPendingJobs = pendingResult.rows[0]?.pending_jobs;
  const pendingJobs = Number.isFinite(Number(rawPendingJobs)) ? Number(rawPendingJobs) : 0;
  const eligibleWatermarkMs = Math.floor(
    (now.getTime() - rollupFinalizeDelayMs(env)) / ROLLUP_BUCKET_MS,
  ) * ROLLUP_BUCKET_MS;
  const lagSeconds = watermark
    ? Math.max(0, Math.floor((eligibleWatermarkMs - watermark.getTime()) / 1_000))
    : null;
  const fallback = rollupRead.legacyFlagMigration != null
    || lagSeconds == null
    || lagSeconds > TIMEZONE_ROLLUP_MAX_LAG_SECONDS
    || pendingJobs > TIMEZONE_ROLLUP_MAX_PENDING_JOBS;
  return {
    status: fallback ? "fallback" : "healthy",
    watermark: watermark?.toISOString() ?? null,
    lagSeconds,
    pendingJobs,
    legacyFlagMigration: rollupRead.legacyFlagMigration,
  };
}

export async function flushClickHouseOutbox(limit = DEFAULT_LIMIT): Promise<{ batches: number; rows: number }> {
  if (process.env.STORAGE_BACKEND !== "clickhouse") return { batches: 0, rows: 0 };
  const { getStorage } = await import("./storage");
  const storage = getStorage();
  if (!isFlushable(storage)) return { batches: 0, rows: 0 };
  return storage.flushUsageOutbox(limit);
}

export async function compactClickHouse15mRollup(limitBuckets?: number): Promise<{ buckets: number; rows: number; watermark: string }> {
  if (process.env.STORAGE_BACKEND !== "clickhouse") return { buckets: 0, rows: 0, watermark: "" };
  if (!enabled("CLICKHOUSE_15M_ROLLUP_COMPACTOR")) return { buckets: 0, rows: 0, watermark: "" };
  const { getStorage } = await import("./storage");
  const storage = getStorage();
  if (!isCompactable(storage)) return { buckets: 0, rows: 0, watermark: "" };
  return storage.compactUsage15mRollup(limitBuckets);
}

export async function compactClickHouse15mV2Rollup(limitBuckets?: number): Promise<{ buckets: number; rows: number; watermark: string }> {
  if (process.env.STORAGE_BACKEND !== "clickhouse") return { buckets: 0, rows: 0, watermark: "" };
  if (!shadowWorkerEnabled(process.env, "CLICKHOUSE_15M_V2_COMPACTOR")) return { buckets: 0, rows: 0, watermark: "" };
  const { getStorage } = await import("./storage");
  const storage = getStorage();
  if (!isV2Compactable(storage)) return { buckets: 0, rows: 0, watermark: "" };
  return storage.compactUsage15mV2(limitBuckets);
}

/** 활성 시간대 queue에서 bounded batch를 처리한다. */
export async function compactClickHouseTimezoneRollups(): Promise<{ jobs: number; rows: number }> {
  if (process.env.STORAGE_BACKEND !== "clickhouse") return { jobs: 0, rows: 0 };
  if (!shadowWorkerEnabled(process.env, "CLICKHOUSE_TIMEZONE_ROLLUP_COMPACTOR")) return { jobs: 0, rows: 0 };
  const { runTimezoneRollupWorker } = await import("./timezone-rollup");
  return runTimezoneRollupWorker();
}

export async function pruneClickHouseUsageRetentionAt(
  pool: RetentionPool,
  now = new Date(),
): Promise<ClickHouseUsageRetentionResult> {
  if (!Number.isFinite(now.getTime())) throw new Error("유효한 retention 기준 시각이 아님");
  const deliveredCutoff = new Date(now.getTime() - DELIVERED_RETENTION_MS);
  const completedJobCutoff = new Date(now.getTime() - COMPLETED_JOB_RETENTION_MS);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const outbox = await client.query(
      `DELETE FROM clickhouse_usage_outbox AS outbox
       USING clickhouse_usage_batches AS batch
       WHERE outbox.batch_id = batch.id
         AND outbox.delivered_at IS NOT NULL
         AND outbox.delivered_at < $1
         AND batch.status = 'delivered'
         AND batch.delivered_at IS NOT NULL
         AND batch.delivered_at < $1`,
      [deliveredCutoff],
    );
    const batches = await client.query(
      `DELETE FROM clickhouse_usage_batches AS batch
       WHERE status = 'delivered'
         AND delivered_at IS NOT NULL
         AND delivered_at < $1
         AND NOT EXISTS (
           SELECT 1
           FROM clickhouse_usage_outbox AS outbox
           WHERE outbox.batch_id = batch.id
         )`,
      [deliveredCutoff],
    );
    const timezoneJobs = await client.query(
      `DELETE FROM clickhouse_timezone_rollup_jobs
       WHERE status = 'done'
         AND updated_at < $1`,
      [completedJobCutoff],
    );
    await client.query("COMMIT");
    return {
      deliveredOutboxRows: outbox.rowCount ?? 0,
      deliveredBatches: batches.rowCount ?? 0,
      completedTimezoneJobs: timezoneJobs.rowCount ?? 0,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function pruneClickHouseUsageRetention(now = new Date()): Promise<ClickHouseUsageRetentionResult> {
  if (process.env.STORAGE_BACKEND !== "clickhouse") {
    return { deliveredOutboxRows: 0, deliveredBatches: 0, completedTimezoneJobs: 0 };
  }
  const { getPool } = await import("./db");
  return pruneClickHouseUsageRetentionAt(getPool(), now);
}

async function tick(): Promise<void> {
  try {
    const r = await flushClickHouseOutbox();
    if (r.rows > 0) console.log(`[toard] ClickHouse outbox flushed — ${r.rows} rows in ${r.batches} batches`);
  } catch (e) {
    console.warn(`[toard] ClickHouse outbox flush failed — ${String(e)} — retrying later`);
  }
}

async function compactTick(): Promise<void> {
  try {
    const r = await compactClickHouse15mRollup();
    if (r.buckets > 0) {
      console.log(`[toard] ClickHouse 15m rollup compacted — ${r.buckets} buckets, ${r.rows} rows, watermark ${r.watermark}`);
    }
  } catch (e) {
    console.warn(`[toard] ClickHouse 15m rollup compaction failed — ${String(e)} — retrying later`);
  }
}

async function compactV2Tick(): Promise<void> {
  try {
    const { getPool } = await import("./db");
    const repository = new PgRollupWorkerRepository(getPool());
    let r = { buckets: 0, rows: 0, watermark: "" };
    const outcome = await runObservedWorkerTick({
      worker: "usage_15m_v2",
      hardEnabled: shadowWorkerEnabled(process.env, "CLICKHOUSE_15M_V2_COMPACTOR"),
      repository,
      run: async () => {
        r = await compactClickHouse15mV2Rollup();
        return { units: r.buckets, rows: r.rows };
      },
      now: () => new Date(),
    });
    if (outcome === "completed" && r.buckets > 0) {
      console.log(`[toard] ClickHouse 15m v2 rollup compacted — ${r.buckets} buckets, ${r.rows} rows, watermark ${r.watermark}`);
    }
  } catch (e) {
    console.warn(`[toard] ClickHouse 15m v2 rollup compaction failed — ${String(e)} — retrying later`);
  }
}

async function compactTimezoneTick(): Promise<void> {
  try {
    const { getPool } = await import("./db");
    const repository = new PgRollupWorkerRepository(getPool());
    let r = { jobs: 0, rows: 0 };
    const outcome = await runObservedWorkerTick({
      worker: "timezone",
      hardEnabled: shadowWorkerEnabled(process.env, "CLICKHOUSE_TIMEZONE_ROLLUP_COMPACTOR"),
      repository,
      run: async () => {
        r = await compactClickHouseTimezoneRollups();
        return { units: r.jobs, rows: r.rows };
      },
      now: () => new Date(),
    });
    if (outcome === "completed" && r.jobs > 0) {
      console.log(`[toard] ClickHouse timezone rollup compacted — ${r.jobs} jobs, ${r.rows} rows`);
    }
  } catch (e) {
    console.warn(`[toard] ClickHouse timezone rollup compaction failed — ${String(e)} — retrying later`);
  }
}

export function startClickHouseOutboxFlush(): void {
  if (process.env.STORAGE_BACKEND !== "clickhouse") return;
  const g = globalThis as {
    __toardClickHouseOutboxFlush?: true;
    __toardClickHouseOutboxRunning?: true;
    __toardClickHouse15mRollupRunning?: true;
  };
  if (g.__toardClickHouseOutboxFlush) return;
  g.__toardClickHouseOutboxFlush = true;
  const guardedTick = () => {
    if (g.__toardClickHouseOutboxRunning) return;
    g.__toardClickHouseOutboxRunning = true;
    tick().finally(() => {
      g.__toardClickHouseOutboxRunning = undefined;
    });
  };
  setTimeout(guardedTick, STARTUP_DELAY_MS).unref();
  setInterval(guardedTick, TICK_MS).unref();
  const guardedCompactTick = () => {
    if (!enabled("CLICKHOUSE_15M_ROLLUP_COMPACTOR")) return;
    if (g.__toardClickHouse15mRollupRunning) return;
    g.__toardClickHouse15mRollupRunning = true;
    compactTick().finally(() => {
      g.__toardClickHouse15mRollupRunning = undefined;
    });
  };
  setTimeout(guardedCompactTick, STARTUP_DELAY_MS + 5_000).unref();
  setInterval(guardedCompactTick, COMPACTOR_TICK_MS).unref();
}

export function startClickHouse15mV2Compaction(): void {
  if (process.env.STORAGE_BACKEND !== "clickhouse") return;
  if (!shadowWorkerEnabled(process.env, "CLICKHOUSE_15M_V2_COMPACTOR")) return;
  const g = globalThis as {
    __toardClickHouse15mV2RollupFlush?: true;
    __toardClickHouse15mV2RollupRunning?: true;
  };
  if (g.__toardClickHouse15mV2RollupFlush) return;
  g.__toardClickHouse15mV2RollupFlush = true;
  const guardedCompactV2Tick = () => {
    if (g.__toardClickHouse15mV2RollupRunning) return;
    g.__toardClickHouse15mV2RollupRunning = true;
    compactV2Tick().finally(() => {
      g.__toardClickHouse15mV2RollupRunning = undefined;
    });
  };
  setTimeout(guardedCompactV2Tick, STARTUP_DELAY_MS + 10_000).unref();
  setInterval(guardedCompactV2Tick, COMPACTOR_TICK_MS).unref();
}

export function startClickHouseTimezoneRollupCompaction(): void {
  if (process.env.STORAGE_BACKEND !== "clickhouse") return;
  if (!shadowWorkerEnabled(process.env, "CLICKHOUSE_TIMEZONE_ROLLUP_COMPACTOR")) return;
  const g = globalThis as {
    __toardClickHouseTimezoneRollupFlush?: true;
    __toardClickHouseTimezoneRollupRunning?: true;
  };
  if (g.__toardClickHouseTimezoneRollupFlush) return;
  g.__toardClickHouseTimezoneRollupFlush = true;
  const guardedCompactTimezoneTick = () => {
    if (g.__toardClickHouseTimezoneRollupRunning) return;
    g.__toardClickHouseTimezoneRollupRunning = true;
    compactTimezoneTick().finally(() => {
      g.__toardClickHouseTimezoneRollupRunning = undefined;
    });
  };
  setTimeout(guardedCompactTimezoneTick, STARTUP_DELAY_MS + 20_000).unref();
  setInterval(guardedCompactTimezoneTick, COMPACTOR_TICK_MS).unref();
}
