import { CLICKHOUSE_RAW_RETENTION_DAYS } from "@toard/core";
import type { RollupStorageStats } from "@toard/storage-clickhouse";
import { getPool } from "./db";
import {
  PgRollupCutoverRepository,
  type RollupCutoverLayer,
  type RollupCutoverRecord,
  type RollupCutoverState,
  type RollupFailureKind,
} from "./rollup-cutover-state";
import {
  deriveWorkerState,
  PgRollupWorkerRepository,
  shadowWorkerEnabled,
  type RollupWorkerName,
  type RollupWorkerRecord,
  type RollupWorkerState,
} from "./rollup-worker-state";
import { getStorage } from "./storage";

const FIFTEEN_MINUTES_MS = 15 * 60 * 1_000;
const DEFAULT_FINALIZE_DELAY_MS = 30 * 60 * 1_000;
const V2_RETENTION_MS = 400 * 24 * 60 * 60 * 1_000;
const STORAGE_CACHE_MS = 30 * 1_000;
const CONFIGURED_THROUGHPUT = {
  usage_15m_v2: 16,
  timezone: 8,
} as const;

export type { RollupStorageStats };

export type RollupProgress = {
  progressPercent: number;
  completedUnits: number;
  totalUnits: number;
  remainingUnits: number;
  etaMinutes: number | null;
  etaBasis: "recent" | "configured" | null;
};

export type DeriveRollupProgressInput = {
  targetFrom: Date;
  targetTo: Date;
  watermark: Date | null;
  dirtyBuckets: Date[];
  throughputPerMinute: number | null;
  bucketMs: number;
  etaBasis?: "recent" | "configured";
};

export type RollupWorkerStatusView = RollupProgress & {
  worker: RollupWorkerName;
  state: RollupWorkerState;
  hardEnabled: boolean;
  controlAvailable: boolean;
  paused: boolean | null;
  activatedAt: string | null;
  watermark: string | null;
  throughputUnitsPerMinute: number | null;
  adaptiveLimit: number | null;
  loadState: "normal" | "throttled" | null;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastSuccessAt: string | null;
  lastProgressAt: string | null;
  lastErrorAt: string | null;
  lastError: "Rollup worker execution failed" | "Rollup worker status unavailable" | null;
  lastBatch: {
    durationMs: number | null;
    units: number;
    rows: number;
  } | null;
  totals: { units: number; rows: number } | null;
};

export type RollupCutoverStatusView = {
  layer: RollupCutoverLayer;
  state: RollupCutoverState | "unavailable";
  targetWatermark: string | null;
  healthySeconds: number;
  requiredHealthySeconds: number;
  lastCheckedAt: string | null;
  lastValidationAt: string | null;
  lastFailureKind: RollupFailureKind | null;
  activatedAt: string | null;
};

export type RollupAdminStatus = {
  backend: "postgres" | "clickhouse";
  collectedAt: string;
  degraded: boolean;
  readSources: {
    usage15mV2: boolean;
    timezone: boolean;
  };
  cutover: {
    mode: "auto" | "forced_on" | "forced_off" | "mixed";
    usage15mV2: RollupCutoverStatusView;
    timezone: RollupCutoverStatusView;
  };
  normalizedRawTtl: {
    enabled: boolean;
    days: number;
  };
  workers: {
    usage15mV2: RollupWorkerStatusView;
    timezone: RollupWorkerStatusView;
  };
  activeTimezones: string[];
  coverage: { hour: number; day: number };
  jobs: { pending: number; inflight: number };
  postgresRawEvents: number;
  storage: RollupStorageStats | null;
};

export type RollupPostgresProgress = {
  watermark: Date | null;
  dirtyBuckets: Date[];
  pending: number;
  inflight: number;
  activeTimezones: string[];
  coverage: { hour: number; day: number };
  postgresRawEvents: number;
};

export type RollupStatusDependencies = {
  env: Record<string, string | undefined>;
  now(): Date;
  loadWorkerRecords(): Promise<RollupWorkerRecord[]>;
  loadCutoverRecords(): Promise<RollupCutoverRecord[]>;
  loadPostgresProgress(targetFrom: Date, targetTo: Date): Promise<RollupPostgresProgress>;
  loadStorageStats(): Promise<RollupStorageStats>;
};

export type RollupStatusPool = {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>> }>;
};

type StorageCacheEntry =
  | { expiresAt: number; value: RollupStorageStats; inFlight?: never }
  | { expiresAt?: never; value?: never; inFlight: Promise<RollupStorageStats> };
const storageCache = new WeakMap<RollupStatusDependencies["loadStorageStats"], StorageCacheEntry>();

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function percent(completed: number, total: number): number {
  if (total <= 0) return 100;
  return Math.round(Math.min(1, Math.max(0, completed / total)) * 10_000) / 100;
}

export function deriveRollupProgress(input: DeriveRollupProgressInput): RollupProgress {
  const bucketMs = Number.isFinite(input.bucketMs) && input.bucketMs > 0
    ? input.bucketMs
    : 1;
  const targetFromMs = input.targetFrom.getTime();
  const targetToMs = input.targetTo.getTime();
  const targetSpan = Math.max(0, targetToMs - targetFromMs);
  const totalUnits = Math.ceil(targetSpan / bucketMs);
  const watermarkMs = input.watermark?.getTime();
  const contiguousFromMs = watermarkMs == null || !Number.isFinite(watermarkMs)
    ? targetFromMs
    : Math.min(targetToMs, Math.max(targetFromMs, watermarkMs));
  const contiguousRemaining = Math.max(
    0,
    Math.floor((targetToMs - contiguousFromMs) / bucketMs),
  );
  const completedUnits = Math.max(0, totalUnits - contiguousRemaining);
  const uniqueDirtyBuckets = new Set<number>();
  for (const bucket of input.dirtyBuckets) {
    const dirtyBucketMs = bucket.getTime();
    if (Number.isFinite(dirtyBucketMs)
      && dirtyBucketMs >= targetFromMs
      && dirtyBucketMs < targetToMs) {
      uniqueDirtyBuckets.add(dirtyBucketMs);
    }
  }
  let dirtyOnlyRemaining = 0;
  for (const dirtyBucketMs of uniqueDirtyBuckets) {
    const contiguousIndex = (dirtyBucketMs - contiguousFromMs) / bucketMs;
    const duplicatesContiguous = Number.isInteger(contiguousIndex)
      && contiguousIndex >= 0
      && contiguousIndex < contiguousRemaining;
    if (!duplicatesContiguous) dirtyOnlyRemaining++;
  }
  const remainingUnits = contiguousRemaining + dirtyOnlyRemaining;
  const throughput = finiteNonNegative(input.throughputPerMinute ?? 0);
  return {
    progressPercent: percent(completedUnits, totalUnits),
    completedUnits,
    totalUnits,
    remainingUnits,
    etaMinutes: remainingUnits === 0 ? 0 : throughput > 0 ? Math.ceil(remainingUnits / throughput) : null,
    etaBasis: throughput > 0 ? (input.etaBasis ?? "recent") : null,
  };
}

function enabled(value: string | undefined): boolean {
  if (value == null || value.trim() === "") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "on";
}

type ReadOverride = "auto" | "forced_on" | "forced_off";

function readOverride(value: string | undefined): ReadOverride {
  return value == null || value.trim() === ""
    ? "auto"
    : enabled(value)
      ? "forced_on"
      : "forced_off";
}

function timezoneReadOverride(env: Record<string, string | undefined>): ReadOverride {
  const current = env.CLICKHOUSE_READ_TIMEZONE_ROLLUP;
  return current != null && current.trim() !== ""
    ? readOverride(current)
    : readOverride(env.CLICKHOUSE_READ_ROLLUP);
}

function effectiveRead(override: ReadOverride, record: RollupCutoverRecord | undefined): boolean {
  if (override === "forced_on") return true;
  if (override === "forced_off") return false;
  return record?.state === "active";
}

function combinedReadMode(a: ReadOverride, b: ReadOverride): RollupAdminStatus["cutover"]["mode"] {
  return a === b ? a : "mixed";
}

function iso(value: Date | null): string | null {
  return value && Number.isFinite(value.getTime()) ? value.toISOString() : null;
}

function cutoverView(
  layer: RollupCutoverLayer,
  record: RollupCutoverRecord | undefined,
): RollupCutoverStatusView {
  return {
    layer,
    state: record?.state ?? "unavailable",
    targetWatermark: iso(record?.targetWatermark ?? null),
    healthySeconds: record?.healthySeconds ?? 0,
    requiredHealthySeconds: 60 * 60,
    lastCheckedAt: iso(record?.lastCheckedAt ?? null),
    lastValidationAt: iso(record?.lastValidationAt ?? null),
    lastFailureKind: record?.lastFailureKind ?? null,
    activatedAt: iso(record?.activatedAt ?? null),
  };
}

function countProgress(
  completedUnits: number,
  remainingUnits: number,
  throughputUnitsPerMinute: number,
  etaBasis: "recent" | "configured",
): RollupProgress {
  const completed = Math.floor(finiteNonNegative(completedUnits));
  const remaining = Math.floor(finiteNonNegative(remainingUnits));
  const total = completed + remaining;
  return {
    progressPercent: percent(completed, total),
    completedUnits: completed,
    totalUnits: total,
    remainingUnits: remaining,
    etaMinutes: remaining === 0 ? 0 : Math.ceil(remaining / throughputUnitsPerMinute),
    etaBasis,
  };
}

function unavailableWorker(
  worker: RollupWorkerName,
  applicable: boolean,
  hardEnabled: boolean,
): RollupWorkerStatusView {
  return {
    worker,
    state: !applicable ? "not_applicable" : !hardEnabled ? "disabled" : "error",
    hardEnabled,
    controlAvailable: false,
    paused: null,
    activatedAt: null,
    watermark: null,
    throughputUnitsPerMinute: null,
    adaptiveLimit: null,
    loadState: null,
    progressPercent: 0,
    completedUnits: 0,
    totalUnits: 0,
    remainingUnits: 0,
    etaMinutes: null,
    etaBasis: null,
    lastStartedAt: null,
    lastFinishedAt: null,
    lastSuccessAt: null,
    lastProgressAt: null,
    lastErrorAt: null,
    lastError: "Rollup worker status unavailable",
    lastBatch: null,
    totals: null,
  };
}

function workerView(input: {
  record: RollupWorkerRecord;
  applicable: boolean;
  hardEnabled: boolean;
  now: Date;
  watermark: Date | null;
  progress: RollupProgress;
  throughput: number;
}): RollupWorkerStatusView {
  const { record } = input;
  return {
    worker: record.worker,
    state: deriveWorkerState({
      applicable: input.applicable,
      hardDisabled: !input.hardEnabled,
      paused: record.paused,
      remaining: input.progress.remainingUnits,
      activatedAt: record.activatedAt,
      lastStartedAt: record.lastStartedAt,
      lastSuccessAt: record.lastSuccessAt,
      lastProgressAt: record.lastProgressAt,
      lastErrorAt: record.lastErrorAt,
      now: input.now,
    }),
    hardEnabled: input.hardEnabled,
    controlAvailable: input.applicable,
    paused: record.paused,
    activatedAt: iso(record.activatedAt),
    watermark: iso(input.watermark),
    throughputUnitsPerMinute: input.throughput,
    adaptiveLimit: record.adaptiveLimit,
    loadState: record.loadState,
    ...input.progress,
    lastStartedAt: iso(record.lastStartedAt),
    lastFinishedAt: iso(record.lastFinishedAt),
    lastSuccessAt: iso(record.lastSuccessAt),
    lastProgressAt: iso(record.lastProgressAt),
    lastErrorAt: iso(record.lastErrorAt),
    lastError: record.lastError ? "Rollup worker execution failed" : null,
    lastBatch: {
      durationMs: record.lastDurationMs,
      units: record.lastProcessedUnits,
      rows: record.lastProcessedRows,
    },
    totals: {
      units: record.processedUnitsTotal,
      rows: record.processedRowsTotal,
    },
  };
}

async function cachedStorageStats(
  load: RollupStatusDependencies["loadStorageStats"],
  now: Date,
): Promise<RollupStorageStats> {
  const cached = storageCache.get(load);
  if (cached?.inFlight) return cached.inFlight;
  if (cached?.value && now.getTime() < cached.expiresAt) return cached.value;

  let inFlight: Promise<RollupStorageStats>;
  inFlight = load().then(
    (value) => {
      storageCache.set(load, { expiresAt: now.getTime() + STORAGE_CACHE_MS, value });
      return value;
    },
    (error: unknown) => {
      if (storageCache.get(load)?.inFlight === inFlight) storageCache.delete(load);
      throw error;
    },
  );
  storageCache.set(load, { inFlight });
  return inFlight;
}

const EMPTY_PROGRESS: RollupPostgresProgress = {
  watermark: null,
  dirtyBuckets: [],
  pending: 0,
  inflight: 0,
  activeTimezones: [],
  coverage: { hour: 0, day: 0 },
  postgresRawEvents: 0,
};

export async function getRollupAdminStatusWith(
  dependencies: RollupStatusDependencies,
): Promise<RollupAdminStatus> {
  const now = dependencies.now();
  const backend = dependencies.env.STORAGE_BACKEND === "clickhouse" ? "clickhouse" : "postgres";
  const applicable = backend === "clickhouse";
  const finalizeDelay = Number(dependencies.env.CLICKHOUSE_ROLLUP_FINALIZE_DELAY_MS);
  const finalizeDelayMs = Number.isFinite(finalizeDelay) && finalizeDelay > 0
    ? Math.floor(finalizeDelay)
    : DEFAULT_FINALIZE_DELAY_MS;
  const targetTo = new Date(
    Math.floor((now.getTime() - finalizeDelayMs) / FIFTEEN_MINUTES_MS) * FIFTEEN_MINUTES_MS,
  );
  const targetFrom = new Date(targetTo.getTime() - V2_RETENTION_MS);
  const [workersResult, cutoverResult, progressResult, storageResult] = await Promise.allSettled([
    dependencies.loadWorkerRecords(),
    dependencies.loadCutoverRecords(),
    dependencies.loadPostgresProgress(targetFrom, targetTo),
    applicable ? cachedStorageStats(dependencies.loadStorageStats, now) : Promise.resolve(null),
  ]);
  const degraded = workersResult.status === "rejected"
    || cutoverResult.status === "rejected"
    || progressResult.status === "rejected"
    || storageResult.status === "rejected";
  const progress = progressResult.status === "fulfilled" ? progressResult.value : EMPTY_PROGRESS;
  const records = workersResult.status === "fulfilled"
    ? new Map(workersResult.value.map((record) => [record.worker, record]))
    : new Map<RollupWorkerName, RollupWorkerRecord>();
  const cutoverRecords = cutoverResult.status === "fulfilled"
    ? new Map(cutoverResult.value.map((record) => [record.layer, record]))
    : new Map<RollupCutoverLayer, RollupCutoverRecord>();
  const usageReadOverride = readOverride(dependencies.env.CLICKHOUSE_READ_15M_V2_ROLLUP);
  const timezoneOverride = timezoneReadOverride(dependencies.env);
  const hardEnabled = {
    usage_15m_v2: shadowWorkerEnabled(dependencies.env, "CLICKHOUSE_15M_V2_COMPACTOR"),
    timezone: shadowWorkerEnabled(dependencies.env, "CLICKHOUSE_TIMEZONE_ROLLUP_COMPACTOR"),
  };
  const v2Record = records.get("usage_15m_v2");
  const v2Throughput = v2Record?.throughputUnitsPerMinute && v2Record.throughputUnitsPerMinute > 0
    ? v2Record.throughputUnitsPerMinute
    : CONFIGURED_THROUGHPUT.usage_15m_v2;
  const v2Progress = deriveRollupProgress({
    targetFrom,
    targetTo,
    watermark: progress.watermark,
    dirtyBuckets: progress.dirtyBuckets,
    throughputPerMinute: v2Throughput,
    bucketMs: FIFTEEN_MINUTES_MS,
    etaBasis: v2Record?.throughputUnitsPerMinute && v2Record.throughputUnitsPerMinute > 0
      ? "recent"
      : "configured",
  });
  const timezoneRecord = records.get("timezone");
  const timezoneThroughput = timezoneRecord?.throughputUnitsPerMinute && timezoneRecord.throughputUnitsPerMinute > 0
    ? timezoneRecord.throughputUnitsPerMinute
    : CONFIGURED_THROUGHPUT.timezone;
  const timezoneProgress = countProgress(
    progress.coverage.hour + progress.coverage.day,
    progress.pending + progress.inflight,
    timezoneThroughput,
    timezoneRecord?.throughputUnitsPerMinute && timezoneRecord.throughputUnitsPerMinute > 0
      ? "recent"
      : "configured",
  );
  const view = (
    worker: RollupWorkerName,
    record: RollupWorkerRecord | undefined,
    workerProgress: RollupProgress,
    throughput: number,
    watermark: Date | null,
  ) => record
    ? workerView({
      record,
      applicable,
      hardEnabled: hardEnabled[worker],
      now,
      watermark,
      progress: progressResult.status === "fulfilled" ? workerProgress : {
        progressPercent: 0,
        completedUnits: 0,
        totalUnits: 1,
        remainingUnits: 1,
        etaMinutes: null,
        etaBasis: null,
      },
      throughput,
    })
    : unavailableWorker(worker, applicable, hardEnabled[worker]);

  return {
    backend,
    collectedAt: now.toISOString(),
    degraded,
    readSources: {
      usage15mV2: effectiveRead(usageReadOverride, cutoverRecords.get("usage_15m_v2")),
      timezone: effectiveRead(timezoneOverride, cutoverRecords.get("timezone")),
    },
    cutover: {
      mode: combinedReadMode(usageReadOverride, timezoneOverride),
      usage15mV2: cutoverView("usage_15m_v2", cutoverRecords.get("usage_15m_v2")),
      timezone: cutoverView("timezone", cutoverRecords.get("timezone")),
    },
    normalizedRawTtl: {
      enabled: enabled(dependencies.env.CLICKHOUSE_ENFORCE_RETENTION_TTL),
      days: CLICKHOUSE_RAW_RETENTION_DAYS,
    },
    workers: {
      usage15mV2: view("usage_15m_v2", v2Record, v2Progress, v2Throughput, progress.watermark),
      timezone: view("timezone", timezoneRecord, timezoneProgress, timezoneThroughput, progress.watermark),
    },
    activeTimezones: progress.activeTimezones,
    coverage: progress.coverage,
    jobs: { pending: progress.pending, inflight: progress.inflight },
    postgresRawEvents: progress.postgresRawEvents,
    storage: storageResult.status === "fulfilled" ? storageResult.value : null,
  };
}

async function loadDefaultWorkerRecords(): Promise<RollupWorkerRecord[]> {
  const repository = new PgRollupWorkerRepository(getPool());
  return Promise.all([
    repository.get("usage_15m_v2"),
    repository.get("timezone"),
  ]);
}

async function loadDefaultCutoverRecords(): Promise<RollupCutoverRecord[]> {
  return new PgRollupCutoverRepository(getPool()).getAll();
}

export async function loadPostgresProgressWith(
  pool: RollupStatusPool,
  targetFrom: Date,
  targetTo: Date,
): Promise<RollupPostgresProgress> {
  const [watermark, dirty, jobs, timezones, coverage, rawEvents] = await Promise.all([
    pool.query(
      "SELECT watermark FROM clickhouse_rollup_watermarks WHERE name = $1",
      ["usage_15m_v2"],
    ),
    pool.query(
      `SELECT bucket
       FROM clickhouse_rollup_dirty_buckets
       WHERE name = $1 AND bucket >= $2 AND bucket < $3
       ORDER BY bucket`,
      ["usage_15m_v2", targetFrom, targetTo],
    ),
    pool.query(
      `SELECT status, count(*) AS count
       FROM clickhouse_timezone_rollup_jobs
       WHERE status IN ('pending', 'inflight')
       GROUP BY status`,
    ),
    pool.query(
      "SELECT timezone FROM clickhouse_rollup_timezones ORDER BY activated_at, timezone",
    ),
    pool.query(
      `SELECT resolution, count(*) AS count
       FROM clickhouse_timezone_rollup_coverage
       GROUP BY resolution`,
    ),
    pool.query("SELECT count(*) AS count FROM raw_events"),
  ]);
  const jobCounts = new Map(jobs.rows.map((row) => [String(row.status), Number(row.count)]));
  const coverageCounts = new Map(coverage.rows.map((row) => [String(row.resolution), Number(row.count)]));
  return {
    watermark: watermark.rows[0]?.watermark instanceof Date ? watermark.rows[0].watermark : null,
    dirtyBuckets: dirty.rows
      .map(({ bucket }) => bucket)
      .filter((bucket): bucket is Date => bucket instanceof Date && Number.isFinite(bucket.getTime())),
    pending: jobCounts.get("pending") ?? 0,
    inflight: jobCounts.get("inflight") ?? 0,
    activeTimezones: timezones.rows
      .map(({ timezone }) => timezone)
      .filter((timezone): timezone is string => typeof timezone === "string"),
    coverage: {
      hour: coverageCounts.get("hour") ?? 0,
      day: coverageCounts.get("day") ?? 0,
    },
    postgresRawEvents: Number(rawEvents.rows[0]?.count ?? 0),
  };
}

async function loadDefaultPostgresProgress(
  targetFrom: Date,
  targetTo: Date,
): Promise<RollupPostgresProgress> {
  return loadPostgresProgressWith(getPool(), targetFrom, targetTo);
}

async function loadDefaultStorageStats(): Promise<RollupStorageStats> {
  const storage = getStorage() as unknown as {
    getRollupStorageStats?: () => Promise<RollupStorageStats>;
  };
  if (!storage.getRollupStorageStats) throw new Error("Rollup storage stats unavailable");
  return storage.getRollupStorageStats();
}

export function getRollupAdminStatus(): Promise<RollupAdminStatus> {
  return getRollupAdminStatusWith({
    env: process.env,
    now: () => new Date(),
    loadWorkerRecords: loadDefaultWorkerRecords,
    loadCutoverRecords: loadDefaultCutoverRecords,
    loadPostgresProgress: loadDefaultPostgresProgress,
    loadStorageStats: loadDefaultStorageStats,
  });
}
