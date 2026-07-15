import type { Pool } from "pg";
import { sanitizeRollupError, type RollupWorkerName } from "./rollup-worker-state";

export type RollupSchedulerTask = RollupWorkerName | "pricing_repair" | "validation" | "idle";
export type RollupSchedulerOutcome = "success" | "failed" | "superseded" | "idle";

export type RollupSchedulerRecord = {
  singleton: true;
  lastHeartbeatAt: Date | null;
  lastSelectedTask: RollupSchedulerTask | null;
  lastTaskStartedAt: Date | null;
  lastTaskFinishedAt: Date | null;
  lastTaskOutcome: RollupSchedulerOutcome | null;
  lastError: string | null;
  updatedAt: Date;
};

type RollupSchedulerRow = {
  singleton: boolean;
  last_heartbeat_at: Date | null;
  last_selected_task: RollupSchedulerTask | null;
  last_task_started_at: Date | null;
  last_task_finished_at: Date | null;
  last_task_outcome: RollupSchedulerOutcome | null;
  last_error: string | null;
  updated_at: Date;
};

const SELECT_FIELDS = `
  singleton, last_heartbeat_at, last_selected_task, last_task_started_at,
  last_task_finished_at, last_task_outcome, last_error, updated_at`;

function mapRow(row: RollupSchedulerRow): RollupSchedulerRecord {
  return {
    singleton: true,
    lastHeartbeatAt: row.last_heartbeat_at,
    lastSelectedTask: row.last_selected_task,
    lastTaskStartedAt: row.last_task_started_at,
    lastTaskFinishedAt: row.last_task_finished_at,
    lastTaskOutcome: row.last_task_outcome,
    lastError: row.last_error,
    updatedAt: row.updated_at,
  };
}

export class PgRollupCoordinatorRepository {
  constructor(private readonly pool: Pool) {}

  async get(): Promise<RollupSchedulerRecord> {
    const result = await this.pool.query<RollupSchedulerRow>(
      `SELECT ${SELECT_FIELDS}
       FROM clickhouse_rollup_scheduler_status
       WHERE singleton = TRUE`,
    );
    const row = result.rows[0];
    if (!row) throw new Error("Rollup scheduler status not found");
    return mapRow(row);
  }

  async recordHeartbeat(at: Date): Promise<void> {
    await this.pool.query(
      `UPDATE clickhouse_rollup_scheduler_status
       SET last_heartbeat_at = $1, updated_at = $1
       WHERE singleton = TRUE`,
      [at],
    );
  }

  async recordStarted(task: RollupSchedulerTask, at: Date): Promise<void> {
    await this.pool.query(
      `UPDATE clickhouse_rollup_scheduler_status
       SET last_heartbeat_at = $2,
           last_selected_task = $1,
           last_task_started_at = $2,
           updated_at = $2
       WHERE singleton = TRUE`,
      [task, at],
    );
  }

  async recordFinished(
    task: RollupSchedulerTask,
    outcome: RollupSchedulerOutcome,
    at: Date,
    error?: string,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE clickhouse_rollup_scheduler_status
       SET last_selected_task = $1,
           last_task_outcome = $2,
           last_task_finished_at = $3,
           last_error = $4,
           last_heartbeat_at = $3,
           updated_at = $3
       WHERE singleton = TRUE`,
      [task, outcome, at, error == null ? null : sanitizeRollupError(error)],
    );
  }
}
