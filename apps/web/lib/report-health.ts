import { assertCostReportScope, type CostReportScope } from "@toard/core";
import { getPool } from "./db";

export type ReportHealth = { checkedAt: string; connections: number; unconfirmed: number; noReport: number; errors: number; paused: number; stale: number; pendingEvents: number | null; outboxPending: number };

/** Current collection condition, not a historical weekly health claim. */
export async function getReportHealth(scope: CostReportScope, range: { from: Date; to: Date }, db: Pick<ReturnType<typeof getPool>, "query"> = getPool(), outboxBacked = process.env.STORAGE_BACKEND === "clickhouse"): Promise<ReportHealth> {
  assertCostReportScope(scope);
  const params = scope.kind === "user" ? [scope.userId] : scope.kind === "team" ? [scope.teamId] : [];
  const filter = scope.kind === "user" ? "t.user_id = $1" : scope.kind === "team" ? "u.team_id = $1" : "TRUE";
  const result = await db.query(
    `WITH tokens AS (
       SELECT t.* FROM ingest_tokens t JOIN users u ON u.id=t.user_id
       WHERE ${filter} AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now())
     ), health AS (
       SELECT h.* FROM collection_provider_health h JOIN tokens t ON t.id=h.token_id
     )
     SELECT (SELECT count(*) FROM tokens) AS connections,
       (SELECT count(*) FROM tokens WHERE first_usage_stored_at IS NULL) AS unconfirmed,
       (SELECT count(*) FROM tokens t WHERE NOT EXISTS (SELECT 1 FROM health h WHERE h.token_id=t.id AND h.last_scan_report_at IS NOT NULL)) AS no_report,
       count(*) FILTER (WHERE scan_state IN ('error','unsupported')) AS errors,
       count(*) FILTER (WHERE scan_state='paused') AS paused,
       count(*) FILTER (WHERE last_scan_report_at < now()-interval '20 minutes') AS stale,
       CASE WHEN count(*)=0 OR count(*) FILTER (WHERE pending_events IS NULL)>0 THEN NULL ELSE sum(pending_events) END AS pending_events
     FROM health`, params,
  );
  let outboxPending = 0;
  if (outboxBacked) {
    const condition = scope.kind === "user" ? "AND user_id=$3" : scope.kind === "team" ? "AND team_id=$3" : "";
    const pending = await db.query(`SELECT count(*) AS count FROM clickhouse_usage_outbox WHERE delivered_at IS NULL AND ts >= $1 AND ts < $2 ${condition}`, [range.from, range.to, ...params]);
    outboxPending = Number(pending.rows[0]?.count ?? 0);
  }
  const row = result.rows[0];
  return { checkedAt: new Date().toISOString(), connections: Number(row.connections), unconfirmed: Number(row.unconfirmed), noReport: Number(row.no_report),
    errors: Number(row.errors), paused: Number(row.paused), stale: Number(row.stale), pendingEvents: row.pending_events == null ? null : Number(row.pending_events), outboxPending };
}
