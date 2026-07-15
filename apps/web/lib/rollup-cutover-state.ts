import type { Pool } from "pg";
import { sanitizeRollupError } from "./rollup-worker-state";

export type RollupCutoverLayer = "usage_15m_v2" | "timezone";
export type RollupCutoverState = "backfilling" | "observing" | "active" | "fallback";
export type RollupFailureKind = "mismatch" | "lag" | "unavailable";

export type RollupCutoverRecord = {
  layer: RollupCutoverLayer;
  state: RollupCutoverState;
  targetWatermark: Date | null;
  healthySeconds: number;
  lastCheckedAt: Date | null;
  lastValidationAt: Date | null;
  consecutiveFailures: number;
  lastFailureKind: RollupFailureKind | null;
  lastFailure: string | null;
  activatedAt: Date | null;
  updatedAt: Date;
};

export type RollupCutoverUpdate = Omit<RollupCutoverRecord, "layer" | "updatedAt">;

export interface RollupCutoverRepository {
  get(layer: RollupCutoverLayer): Promise<RollupCutoverRecord>;
  getAll(): Promise<RollupCutoverRecord[]>;
  save(layer: RollupCutoverLayer, update: RollupCutoverUpdate): Promise<RollupCutoverRecord>;
}

type RollupCutoverRow = {
  layer: RollupCutoverLayer;
  state: RollupCutoverState;
  target_watermark: Date | null;
  healthy_seconds: string | number;
  last_checked_at: Date | null;
  last_validation_at: Date | null;
  consecutive_failures: string | number;
  last_failure_kind: RollupFailureKind | null;
  last_failure: string | null;
  activated_at: Date | null;
  updated_at: Date;
};

const SELECT_FIELDS = `
  layer, state, target_watermark, healthy_seconds, last_checked_at,
  last_validation_at, consecutive_failures, last_failure_kind, last_failure,
  activated_at, updated_at`;

function mapRow(row: RollupCutoverRow): RollupCutoverRecord {
  return {
    layer: row.layer,
    state: row.state,
    targetWatermark: row.target_watermark,
    healthySeconds: Number(row.healthy_seconds),
    lastCheckedAt: row.last_checked_at,
    lastValidationAt: row.last_validation_at,
    consecutiveFailures: Number(row.consecutive_failures),
    lastFailureKind: row.last_failure_kind,
    lastFailure: row.last_failure,
    activatedAt: row.activated_at,
    updatedAt: row.updated_at,
  };
}

function requireRow(layer: RollupCutoverLayer, row: RollupCutoverRow | undefined): RollupCutoverRecord {
  if (!row) throw new Error(`Rollup cutover status not found: ${layer}`);
  return mapRow(row);
}

export class PgRollupCutoverRepository implements RollupCutoverRepository {
  constructor(private readonly pool: Pool) {}

  async get(layer: RollupCutoverLayer): Promise<RollupCutoverRecord> {
    const result = await this.pool.query<RollupCutoverRow>(
      `SELECT ${SELECT_FIELDS}
       FROM clickhouse_rollup_cutover_status
       WHERE layer = $1`,
      [layer],
    );
    return requireRow(layer, result.rows[0]);
  }

  async getAll(): Promise<RollupCutoverRecord[]> {
    const result = await this.pool.query<RollupCutoverRow>(
      `SELECT ${SELECT_FIELDS}
       FROM clickhouse_rollup_cutover_status
       ORDER BY layer`,
    );
    return result.rows.map(mapRow);
  }

  async save(layer: RollupCutoverLayer, update: RollupCutoverUpdate): Promise<RollupCutoverRecord> {
    const result = await this.pool.query<RollupCutoverRow>(
      `UPDATE clickhouse_rollup_cutover_status
       SET state = $2,
           target_watermark = $3,
           healthy_seconds = $4,
           last_checked_at = $5,
           last_validation_at = $6,
           consecutive_failures = $7,
           last_failure_kind = $8,
           last_failure = $9,
           activated_at = $10,
           updated_at = now()
       WHERE layer = $1
       RETURNING ${SELECT_FIELDS}`,
      [
        layer,
        update.state,
        update.targetWatermark,
        Math.max(0, Math.floor(update.healthySeconds)),
        update.lastCheckedAt,
        update.lastValidationAt,
        Math.max(0, Math.floor(update.consecutiveFailures)),
        update.lastFailureKind,
        update.lastFailure == null ? null : sanitizeRollupError(update.lastFailure),
        update.activatedAt,
      ],
    );
    return requireRow(layer, result.rows[0]);
  }
}
