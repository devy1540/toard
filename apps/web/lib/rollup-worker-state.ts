import type { Pool } from "pg";

const STALLED_AFTER_MS = 3 * 60 * 1_000;
const MIN_THROUGHPUT_WINDOW_MS = 60 * 1_000;

export type RollupWorkerName = "usage_15m_v2" | "timezone";

export type RollupWorkerState =
  | "not_applicable"
  | "disabled"
  | "paused"
  | "starting"
  | "catching_up"
  | "ready"
  | "stalled"
  | "error";

export type RollupWorkerRecord = {
  worker: RollupWorkerName;
  paused: boolean;
  activatedAt: Date;
  lastStartedAt: Date | null;
  lastFinishedAt: Date | null;
  lastSuccessAt: Date | null;
  lastProgressAt: Date | null;
  lastErrorAt: Date | null;
  lastError: string | null;
  lastDurationMs: number | null;
  lastProcessedUnits: number;
  lastProcessedRows: number;
  processedUnitsTotal: number;
  processedRowsTotal: number;
  throughputUnitsPerMinute: number | null;
};

export interface RollupWorkerRepository {
  get(worker: RollupWorkerName): Promise<RollupWorkerRecord>;
  setPaused(worker: RollupWorkerName, paused: boolean): Promise<RollupWorkerRecord>;
  markStarted(worker: RollupWorkerName, at: Date): Promise<void>;
  markSucceeded(
    worker: RollupWorkerName,
    startedAt: Date,
    finishedAt: Date,
    result: { units: number; rows: number },
  ): Promise<void>;
  markFailed(
    worker: RollupWorkerName,
    startedAt: Date,
    finishedAt: Date,
    error: string,
  ): Promise<void>;
}

export function shadowWorkerEnabled(
  env: Record<string, string | undefined>,
  key: "CLICKHOUSE_15M_V2_COMPACTOR" | "CLICKHOUSE_TIMEZONE_ROLLUP_COMPACTOR",
): boolean {
  const value = env[key]?.trim().toLowerCase();
  return value !== "0" && value !== "false" && value !== "off";
}

export function sanitizeRollupError(error: unknown): string {
  return String(error)
    .replace(/:\/\/[^\s/@]+:[^\s/@]+@/g, "://[redacted]@")
    .replace(/(password|token|secret)=([^\s&]+)/gi, "$1=[redacted]")
    .slice(0, 500);
}

export type DeriveWorkerStateInput = {
  applicable?: boolean;
  hardDisabled: boolean;
  paused: boolean;
  remaining: number;
  activatedAt: Date;
  lastStartedAt?: Date | null;
  lastSuccessAt?: Date | null;
  lastProgressAt?: Date | null;
  lastErrorAt?: Date | null;
  now: Date;
};

export function deriveWorkerState(input: DeriveWorkerStateInput): RollupWorkerState {
  if (input.applicable === false) return "not_applicable";
  if (input.hardDisabled) return "disabled";
  if (input.paused) return "paused";
  if (
    input.lastErrorAt &&
    (!input.lastSuccessAt || input.lastErrorAt.getTime() > input.lastSuccessAt.getTime())
  ) {
    return "error";
  }
  if (input.remaining <= 0) return "ready";

  const nowMs = input.now.getTime();
  if (input.lastProgressAt) {
    return nowMs - input.lastProgressAt.getTime() <= STALLED_AFTER_MS
      ? "catching_up"
      : "stalled";
  }
  if (!input.lastSuccessAt) {
    const startedOrActivatedAt = input.lastStartedAt ?? input.activatedAt;
    return nowMs - startedOrActivatedAt.getTime() <= STALLED_AFTER_MS
      ? "starting"
      : "stalled";
  }
  return "stalled";
}

type RollupWorkerRow = {
  worker: RollupWorkerName;
  paused: boolean;
  activated_at: Date;
  last_started_at: Date | null;
  last_finished_at: Date | null;
  last_success_at: Date | null;
  last_progress_at: Date | null;
  last_error_at: Date | null;
  last_error: string | null;
  last_duration_ms: string | number | null;
  last_processed_units: string | number;
  last_processed_rows: string | number;
  processed_units_total: string | number;
  processed_rows_total: string | number;
  throughput_units_per_minute: string | number | null;
};

const SELECT_FIELDS = `
  worker, paused, activated_at, last_started_at, last_finished_at, last_success_at,
  last_progress_at, last_error_at, last_error, last_duration_ms,
  last_processed_units, last_processed_rows, processed_units_total,
  processed_rows_total, throughput_units_per_minute`;

function nullableNumber(value: string | number | null): number | null {
  return value == null ? null : Number(value);
}

function mapWorkerRow(row: RollupWorkerRow): RollupWorkerRecord {
  return {
    worker: row.worker,
    paused: row.paused,
    activatedAt: row.activated_at,
    lastStartedAt: row.last_started_at,
    lastFinishedAt: row.last_finished_at,
    lastSuccessAt: row.last_success_at,
    lastProgressAt: row.last_progress_at,
    lastErrorAt: row.last_error_at,
    lastError: row.last_error,
    lastDurationMs: nullableNumber(row.last_duration_ms),
    lastProcessedUnits: Number(row.last_processed_units),
    lastProcessedRows: Number(row.last_processed_rows),
    processedUnitsTotal: Number(row.processed_units_total),
    processedRowsTotal: Number(row.processed_rows_total),
    throughputUnitsPerMinute: nullableNumber(row.throughput_units_per_minute),
  };
}

function requireWorkerRow(
  worker: RollupWorkerName,
  row: RollupWorkerRow | undefined,
): RollupWorkerRecord {
  if (!row) throw new Error(`Rollup worker status not found: ${worker}`);
  return mapWorkerRow(row);
}

export class PgRollupWorkerRepository implements RollupWorkerRepository {
  constructor(private readonly pool: Pool) {}

  async get(worker: RollupWorkerName): Promise<RollupWorkerRecord> {
    const result = await this.pool.query<RollupWorkerRow>(
      `SELECT ${SELECT_FIELDS}
       FROM clickhouse_rollup_worker_status
       WHERE worker = $1`,
      [worker],
    );
    return requireWorkerRow(worker, result.rows[0]);
  }

  async setPaused(worker: RollupWorkerName, paused: boolean): Promise<RollupWorkerRecord> {
    const result = await this.pool.query<RollupWorkerRow>(
      `UPDATE clickhouse_rollup_worker_status
       SET paused = $2, updated_at = now()
       WHERE worker = $1
       RETURNING ${SELECT_FIELDS}`,
      [worker, paused],
    );
    return requireWorkerRow(worker, result.rows[0]);
  }

  async markStarted(worker: RollupWorkerName, at: Date): Promise<void> {
    await this.pool.query(
      `UPDATE clickhouse_rollup_worker_status
       SET last_started_at = $2, updated_at = $2
       WHERE worker = $1`,
      [worker, at],
    );
  }

  async markSucceeded(
    worker: RollupWorkerName,
    startedAt: Date,
    finishedAt: Date,
    result: { units: number; rows: number },
  ): Promise<void> {
    const durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());
    const throughputSample = result.units /
      (Math.max(durationMs, MIN_THROUGHPUT_WINDOW_MS) / MIN_THROUGHPUT_WINDOW_MS);
    await this.pool.query(
      `UPDATE clickhouse_rollup_worker_status
       SET last_started_at = $2,
           last_finished_at = $3,
           last_success_at = $3,
           last_progress_at = CASE WHEN $4 > 0 THEN $3 ELSE last_progress_at END,
           last_duration_ms = $7,
           last_processed_units = $4,
           last_processed_rows = $5,
           processed_units_total = processed_units_total + $4,
           processed_rows_total = processed_rows_total + $5,
           throughput_units_per_minute = CASE
             WHEN $4 <= 0 THEN throughput_units_per_minute
             WHEN throughput_units_per_minute IS NULL THEN $6::double precision
             ELSE throughput_units_per_minute * 0.7 + $6::double precision * 0.3
           END,
           updated_at = $3
       WHERE worker = $1`,
      [worker, startedAt, finishedAt, result.units, result.rows, throughputSample, durationMs],
    );
  }

  async markFailed(
    worker: RollupWorkerName,
    startedAt: Date,
    finishedAt: Date,
    error: string,
  ): Promise<void> {
    const durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());
    await this.pool.query(
      `UPDATE clickhouse_rollup_worker_status
       SET last_started_at = $2,
           last_finished_at = $3,
           last_error_at = $3,
           last_error = $4,
           last_duration_ms = $5,
           updated_at = $3
       WHERE worker = $1`,
      [worker, startedAt, finishedAt, sanitizeRollupError(error), durationMs],
    );
  }
}
