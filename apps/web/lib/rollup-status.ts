import { CLICKHOUSE_RAW_RETENTION_DAYS } from "@toard/core";
import type { RollupStorageStats } from "@toard/storage-clickhouse";
import { getPool } from "./db";
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
  dirty: number;
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

export type RollupAdminStatus = {
  backend: "postgres" | "clickhouse";
  collectedAt: string;
  degraded: boolean;
  readSources: {
    usage15mV2: boolean;
    timezone: boolean;
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
  dirty: number;
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
  loadPostgresProgress(): Promise<RollupPostgresProgress>;
  loadStorageStats(): Promise<RollupStorageStats>;
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
  const targetSpan = Math.max(0, input.targetTo.getTime() - input.targetFrom.getTime());
  const totalUnits = Math.ceil(targetSpan / bucketMs);
  const watermarkMs = input.watermark?.getTime();
  const completedUnits = watermarkMs == null || !Number.isFinite(watermarkMs)
    ? 0
    : Math.min(
      totalUnits,
      Math.max(0, Math.floor((watermarkMs - input.targetFrom.getTime()) / bucketMs)),
    );
  const remainingUnits = Math.max(0, totalUnits - completedUnits) + Math.floor(finiteNonNegative(input.dirty));
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

function timezoneReadEnabled(env: Record<string, string | undefined>): boolean {
  const current = env.CLICKHOUSE_READ_TIMEZONE_ROLLUP;
  return current != null && current.trim() !== ""
    ? enabled(current)
    : enabled(env.CLICKHOUSE_READ_ROLLUP);
}

function iso(value: Date | null): string | null {
  return value && Number.isFinite(value.getTime()) ? value.toISOString() : null;
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
  dirty: 0,
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
  const [workersResult, progressResult, storageResult] = await Promise.allSettled([
    dependencies.loadWorkerRecords(),
    dependencies.loadPostgresProgress(),
    applicable ? cachedStorageStats(dependencies.loadStorageStats, now) : Promise.resolve(null),
  ]);
  const degraded = workersResult.status === "rejected"
    || progressResult.status === "rejected"
    || storageResult.status === "rejected";
  const progress = progressResult.status === "fulfilled" ? progressResult.value : EMPTY_PROGRESS;
  const records = workersResult.status === "fulfilled"
    ? new Map(workersResult.value.map((record) => [record.worker, record]))
    : new Map<RollupWorkerName, RollupWorkerRecord>();
  const hardEnabled = {
    usage_15m_v2: shadowWorkerEnabled(dependencies.env, "CLICKHOUSE_15M_V2_COMPACTOR"),
    timezone: shadowWorkerEnabled(dependencies.env, "CLICKHOUSE_TIMEZONE_ROLLUP_COMPACTOR"),
  };
  const finalizeDelay = Number(dependencies.env.CLICKHOUSE_ROLLUP_FINALIZE_DELAY_MS);
  const finalizeDelayMs = Number.isFinite(finalizeDelay) && finalizeDelay > 0
    ? Math.floor(finalizeDelay)
    : DEFAULT_FINALIZE_DELAY_MS;
  const targetTo = new Date(
    Math.floor((now.getTime() - finalizeDelayMs) / FIFTEEN_MINUTES_MS) * FIFTEEN_MINUTES_MS,
  );
  const v2Record = records.get("usage_15m_v2");
  const v2Throughput = v2Record?.throughputUnitsPerMinute && v2Record.throughputUnitsPerMinute > 0
    ? v2Record.throughputUnitsPerMinute
    : CONFIGURED_THROUGHPUT.usage_15m_v2;
  const v2Progress = deriveRollupProgress({
    targetFrom: new Date(targetTo.getTime() - V2_RETENTION_MS),
    targetTo,
    watermark: progress.watermark,
    dirty: progress.dirty,
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
      usage15mV2: enabled(dependencies.env.CLICKHOUSE_READ_15M_V2_ROLLUP),
      timezone: timezoneReadEnabled(dependencies.env),
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

async function loadDefaultPostgresProgress(): Promise<RollupPostgresProgress> {
  const pool = getPool();
  const [watermark, dirty, jobs, timezones, coverage, rawEvents] = await Promise.all([
    pool.query<{ watermark: Date | null }>(
      "SELECT watermark FROM clickhouse_rollup_watermarks WHERE name = $1",
      ["usage_15m_v2"],
    ),
    pool.query<{ count: string | number }>(
      "SELECT count(*) AS count FROM clickhouse_rollup_dirty_buckets WHERE name = $1",
      ["usage_15m_v2"],
    ),
    pool.query<{ status: "pending" | "inflight"; count: string | number }>(
      `SELECT status, count(*) AS count
       FROM clickhouse_timezone_rollup_jobs
       WHERE status IN ('pending', 'inflight')
       GROUP BY status`,
    ),
    pool.query<{ timezone: string }>(
      "SELECT timezone FROM clickhouse_rollup_timezones ORDER BY activated_at, timezone",
    ),
    pool.query<{ resolution: "hour" | "day"; count: string | number }>(
      `SELECT resolution, count(*) AS count
       FROM clickhouse_timezone_rollup_coverage
       GROUP BY resolution`,
    ),
    pool.query<{ count: string | number }>("SELECT count(*) AS count FROM raw_events"),
  ]);
  const jobCounts = new Map(jobs.rows.map((row) => [row.status, Number(row.count)]));
  const coverageCounts = new Map(coverage.rows.map((row) => [row.resolution, Number(row.count)]));
  return {
    watermark: watermark.rows[0]?.watermark ?? null,
    dirty: Number(dirty.rows[0]?.count ?? 0),
    pending: jobCounts.get("pending") ?? 0,
    inflight: jobCounts.get("inflight") ?? 0,
    activeTimezones: timezones.rows.map(({ timezone }) => timezone),
    coverage: {
      hour: coverageCounts.get("hour") ?? 0,
      day: coverageCounts.get("day") ?? 0,
    },
    postgresRawEvents: Number(rawEvents.rows[0]?.count ?? 0),
  };
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
    loadPostgresProgress: loadDefaultPostgresProgress,
    loadStorageStats: loadDefaultStorageStats,
  });
}
