import { evaluateRollout, type RolloutEvaluation, type ToolRolloutPhase } from "@toard/core";
import type { Pool, PoolClient } from "pg";
import { getPool } from "./db";

export type OpenToolRollout = RolloutEvaluation & { id: string };

export type ToolRolloutRepository = {
  tryLease(): Promise<boolean>;
  releaseLease(): Promise<void>;
  listOpenRollouts(): Promise<OpenToolRollout[]>;
  advance(id: string, phase: "canary" | "expand" | "active", percent: 10 | 50 | 100, now: Date): Promise<void>;
  rollbackToLastKnownGood(id: string, now: Date, reason: "failure_threshold"): Promise<void>;
};

export async function runToolRolloutCoordinator(repository: ToolRolloutRepository, now: Date): Promise<void> {
  if (!(await repository.tryLease())) return;
  try {
    for (const rollout of await repository.listOpenRollouts()) {
      if (rollout.phase === "preflight") {
        await repository.advance(rollout.id, "canary", 10, now);
        continue;
      }
      const decision = evaluateRollout(rollout, now);
      if (decision.action === "advance") {
        await repository.advance(rollout.id, decision.nextPhase, decision.percent, now);
      } else if (decision.action === "rollback") {
        await repository.rollbackToLastKnownGood(rollout.id, now, decision.reason);
      }
    }
  } finally {
    await repository.releaseLease();
  }
}

export function createToolRolloutRepository(pool: Pool): ToolRolloutRepository {
  let leaseClient: PoolClient | null = null;
  return {
    async tryLease() {
      if (leaseClient) return true;
      const client = await pool.connect();
      const result = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock(81726354) AS acquired",
      );
      if (!result.rows[0]?.acquired) {
        client.release();
        return false;
      }
      leaseClient = client;
      return true;
    },
    async releaseLease() {
      const client = leaseClient;
      leaseClient = null;
      if (!client) return;
      try { await client.query("SELECT pg_advisory_unlock(81726354)"); } finally { client.release(); }
    },
    async listOpenRollouts() {
      const result = await pool.query<{
        id: string;
        rollout_phase: ToolRolloutPhase;
        eligible: string;
        attempted: string;
        failed: string;
        phase_started_at: Date;
      }>(
        `SELECT p.id, p.rollout_phase, p.phase_started_at,
                COUNT(DISTINCT s.id) AS eligible,
                COUNT(DISTINCT r.id) FILTER (WHERE r.last_attempted_at IS NOT NULL) AS attempted,
                COUNT(DISTINCT r.id) FILTER (WHERE r.status IN ('failed', 'rolled_back')) AS failed
         FROM team_tool_policies p
         JOIN users u ON u.team_id = p.team_id
         LEFT JOIN device_tool_inventory_snapshots s ON s.user_id = u.id
         LEFT JOIN tool_deployment_reports r
           ON r.rollout_id = p.rollout_seed
          AND r.desired_version_id = p.target_version_id
          AND r.last_attempted_at >= p.phase_started_at
         WHERE p.enabled = true AND p.rollout_phase IN ('preflight', 'canary', 'expand')
         GROUP BY p.id`,
      );
      return result.rows.map((row) => ({
        id: row.id,
        phase: row.rollout_phase,
        eligible: Number(row.eligible),
        attempted: Number(row.attempted),
        failed: Number(row.failed),
        phaseStartedAt: new Date(row.phase_started_at),
      }));
    },
    async advance(id, phase, percent, now) {
      await pool.query(
        `WITH changed AS (
           UPDATE team_tool_policies SET rollout_phase = $2, rollout_percent = $3,
             phase_started_at = $4,
             last_known_good_version_id = CASE WHEN $2 = 'active' THEN target_version_id ELSE last_known_good_version_id END,
             updated_at = now()
           WHERE id = $1 AND rollout_phase IN ('preflight', 'canary', 'expand')
           RETURNING updated_by, team_id, catalog_item_id
         )
         INSERT INTO tool_deployment_audit (actor_user_id, action, team_id, catalog_item_id, after_value)
         SELECT updated_by, 'team_rollout_advanced', team_id, catalog_item_id,
                jsonb_build_object('phase', $2::text, 'percent', $3::int)
         FROM changed`,
        [id, phase, percent, now],
      );
    },
    async rollbackToLastKnownGood(id, now, reason) {
      await pool.query(
        `WITH changed AS (
           UPDATE team_tool_policies SET
             target_version_id = COALESCE(last_known_good_version_id, target_version_id),
             rollout_phase = CASE WHEN last_known_good_version_id IS NULL THEN 'paused' ELSE 'rollback' END,
             rollout_percent = CASE WHEN last_known_good_version_id IS NULL THEN 0 ELSE 100 END,
             enabled = last_known_good_version_id IS NOT NULL,
             phase_started_at = $2, updated_at = now()
           WHERE id = $1 AND rollout_phase IN ('canary', 'expand')
           RETURNING updated_by, team_id, catalog_item_id, rollout_phase, rollout_percent
         )
         INSERT INTO tool_deployment_audit (actor_user_id, action, team_id, catalog_item_id, after_value)
         SELECT updated_by, 'team_rollout_rolled_back', team_id, catalog_item_id,
                jsonb_build_object('phase', rollout_phase, 'percent', rollout_percent, 'reason', $3::text)
         FROM changed`,
        [id, now, reason],
      );
    },
  };
}

const SCHEDULER_KEY = Symbol.for("toard.tool-rollout-coordinator");

export function startToolRolloutCoordinator(): void {
  const runtime = globalThis as typeof globalThis & { [SCHEDULER_KEY]?: ReturnType<typeof setInterval> };
  if (runtime[SCHEDULER_KEY] || process.env.TOARD_TOOL_ROLLOUT_COORDINATOR === "0") return;
  const repository = createToolRolloutRepository(getPool());
  const tick = () => void runToolRolloutCoordinator(repository, new Date()).catch((error: unknown) => {
    console.error("tool rollout coordinator tick failed", error);
  });
  tick();
  const timer = setInterval(tick, 60_000);
  timer.unref();
  runtime[SCHEDULER_KEY] = timer;
}
