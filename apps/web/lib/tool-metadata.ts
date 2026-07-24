import {
  TOOL_OUTCOME_PROVIDER_KEYS,
  type DeviceToolInventory,
  type PeriodQuery,
  type ToolActivityEvent,
  type ToolActivityRow,
  type ToolActivitySummary,
  type ToolInventorySnapshot,
  type UtilizationToolDay,
} from "@toard/core";
import { getPool } from "./db";

export type ToolIngestOwner = { userId: string; tokenId: string };
type QueryResult<T = Record<string, unknown>> = { rows: T[]; rowCount?: number | null };
export type ToolMetadataDb = {
  query(sql: string, params?: unknown[]): Promise<QueryResult>;
};

export type PersonalToolActivity = { summary: ToolActivitySummary; rows: ToolActivityRow[] };

const num = (value: unknown): number => Number(value ?? 0);

export async function insertToolActivityWithDb(
  db: ToolMetadataDb,
  owner: ToolIngestOwner,
  events: ToolActivityEvent[],
): Promise<{ inserted: number; deduped: number }> {
  let inserted = 0;
  for (const event of events) {
    const result = await db.query(
      `INSERT INTO tool_activity_events
         (user_id, ingest_token_id, dedup_key, provider_key, session_id, host, ts,
          activity_kind, item_key, display_name, plugin_key, outcome, detection)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (dedup_key) DO NOTHING
       RETURNING id`,
      [
        owner.userId,
        owner.tokenId,
        event.dedupKey,
        event.providerKey,
        event.sessionId,
        event.host,
        event.ts,
        event.activityKind,
        event.itemKey,
        event.displayName,
        event.pluginKey,
        event.outcome,
        event.detection,
      ],
    );
    inserted += result.rowCount ?? result.rows.length;
  }
  return { inserted, deduped: events.length - inserted };
}

export function insertToolActivity(
  owner: ToolIngestOwner,
  events: ToolActivityEvent[],
): Promise<{ inserted: number; deduped: number }> {
  return insertToolActivityWithDb(getPool(), owner, events);
}

export async function replaceDeviceInventoryWithDb(
  db: ToolMetadataDb,
  owner: ToolIngestOwner,
  snapshot: ToolInventorySnapshot,
): Promise<{ unchanged: boolean; items: number }> {
  const host = snapshot.host ?? "";
  const saved = await db.query(
    `INSERT INTO device_tool_inventory_snapshots
       (user_id, ingest_token_id, host, fingerprint, observed_at, received_at)
     VALUES ($1,$2,$3,$4,$5,now())
     ON CONFLICT (ingest_token_id, fingerprint) DO UPDATE SET
       user_id = EXCLUDED.user_id,
       host = EXCLUDED.host,
       observed_at = EXCLUDED.observed_at,
       received_at = now()
     RETURNING id`,
    [owner.userId, owner.tokenId, host, snapshot.fingerprint, snapshot.observedAt],
  );
  const snapshotId = saved.rows[0]?.id;
  if (!snapshotId) throw new Error("inventory snapshot id missing");
  await db.query("DELETE FROM device_tool_inventory_items WHERE snapshot_id = $1", [snapshotId]);
  for (const item of snapshot.items) {
    await db.query(
      `INSERT INTO device_tool_inventory_items
         (snapshot_id, kind, item_key, display_name, source_provider, plugin_key, version, enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [snapshotId, item.kind, item.itemKey, item.displayName, item.sourceProvider, item.pluginKey, item.version, item.enabled],
    );
  }
  return { unchanged: false, items: snapshot.items.length };
}

export async function replaceDeviceInventory(
  owner: ToolIngestOwner,
  snapshot: ToolInventorySnapshot,
): Promise<{ unchanged: boolean; items: number }> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await replaceDeviceInventoryWithDb(client, owner, snapshot);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function filterSql(query: PeriodQuery, userId?: string): { where: string; params: unknown[] } {
  const params: unknown[] = [query.from, query.to];
  const clauses = ["ts >= $1", "ts < $2"];
  if (userId) {
    params.push(userId);
    clauses.push(`user_id = $${params.length}`);
  }
  if (query.providerKey) {
    params.push(query.providerKey);
    clauses.push(`provider_key = $${params.length}`);
  }
  return { where: clauses.join(" AND "), params };
}

export async function getMyToolActivityWithDb(
  db: ToolMetadataDb,
  userId: string,
  query: PeriodQuery,
): Promise<PersonalToolActivity> {
  const { where, params } = filterSql(query, userId);
  const [summaryResult, rowsResult] = await Promise.all([
    db.query(
      `SELECT
         COUNT(*) FILTER (WHERE activity_kind = 'mcp') AS mcp_calls,
         COUNT(DISTINCT item_key) FILTER (WHERE activity_kind = 'skill') AS distinct_skills,
         COUNT(DISTINCT plugin_key) FILTER (WHERE plugin_key IS NOT NULL) AS distinct_plugins,
         COUNT(*) FILTER (WHERE outcome = 'failure') AS failures
       FROM tool_activity_events WHERE ${where}`,
      params,
    ),
    db.query(
      `SELECT activity_kind, item_key, display_name, plugin_key, detection,
              COUNT(*) AS calls,
              COUNT(*) FILTER (WHERE outcome = 'success') AS successes,
              COUNT(*) FILTER (WHERE outcome = 'failure') AS failures,
              COUNT(*) FILTER (WHERE outcome = 'unknown') AS unknown,
              MAX(ts) AS last_activity_at,
              ARRAY_REMOVE(ARRAY_AGG(DISTINCT host), NULL) AS hosts
       FROM tool_activity_events WHERE ${where}
       GROUP BY activity_kind, item_key, display_name, plugin_key, detection
       ORDER BY calls DESC, last_activity_at DESC`,
      params,
    ),
  ]);
  const summary = summaryResult.rows[0] ?? {};
  return {
    summary: {
      mcpCalls: num(summary.mcp_calls),
      distinctSkills: num(summary.distinct_skills),
      distinctPlugins: num(summary.distinct_plugins),
      failures: num(summary.failures),
    },
    rows: rowsResult.rows.map((row) => ({
      activityKind: row.activity_kind as ToolActivityRow["activityKind"],
      itemKey: String(row.item_key),
      displayName: String(row.display_name),
      pluginKey: row.plugin_key == null ? null : String(row.plugin_key),
      detection: row.detection as ToolActivityRow["detection"],
      calls: num(row.calls),
      successes: num(row.successes),
      failures: num(row.failures),
      unknown: num(row.unknown),
      lastActivityAt: new Date(String(row.last_activity_at)),
      hosts: Array.isArray(row.hosts) ? row.hosts.map(String) : [],
    })),
  };
}

export function getMyToolActivity(userId: string, query: PeriodQuery): Promise<PersonalToolActivity> {
  return getMyToolActivityWithDb(getPool(), userId, query);
}

export async function getOrgToolSummaryWithDb(
  db: ToolMetadataDb,
  query: PeriodQuery,
): Promise<ToolActivitySummary> {
  const { where, params } = filterSql(query);
  const result = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE activity_kind = 'mcp') AS mcp_calls,
       COUNT(DISTINCT item_key) FILTER (WHERE activity_kind = 'skill') AS distinct_skills,
       COUNT(DISTINCT plugin_key) FILTER (WHERE plugin_key IS NOT NULL) AS distinct_plugins,
       COUNT(*) FILTER (WHERE outcome = 'failure') AS failures,
       COUNT(DISTINCT user_id) AS active_users,
       COUNT(DISTINCT (ingest_token_id, COALESCE(host, ''))) AS active_devices
     FROM tool_activity_events WHERE ${where}`,
    params,
  );
  const row = result.rows[0] ?? {};
  return {
    mcpCalls: num(row.mcp_calls),
    distinctSkills: num(row.distinct_skills),
    distinctPlugins: num(row.distinct_plugins),
    failures: num(row.failures),
    activeUsers: num(row.active_users),
    activeDevices: num(row.active_devices),
  };
}

export function getOrgToolSummary(query: PeriodQuery): Promise<ToolActivitySummary> {
  return getOrgToolSummaryWithDb(getPool(), query);
}

export async function getUtilizationToolDaysWithDb(
  db: ToolMetadataDb,
  query: PeriodQuery,
  timezone: string,
  userId?: string,
): Promise<UtilizationToolDay[]> {
  const params: unknown[] = [query.from, query.to, timezone, [...TOOL_OUTCOME_PROVIDER_KEYS]];
  const userClause = userId ? `AND user_id = $${params.push(userId)}` : "";
  const result = await db.query(
    `WITH ordered AS (
       SELECT user_id, session_id, activity_kind, item_key, outcome, ts, dedup_key,
              LAG(outcome) OVER (
                PARTITION BY user_id, session_id, activity_kind, item_key
                ORDER BY ts, dedup_key
              ) AS previous_outcome,
              LAG(ts) OVER (
                PARTITION BY user_id, session_id, activity_kind, item_key
                ORDER BY ts, dedup_key
              ) AS previous_ts
       FROM tool_activity_events
       WHERE ts >= $1 AND ts < $2
         AND provider_key = ANY($4::text[])
         ${userClause}
     ), tagged AS (
       SELECT *, to_char((ts AT TIME ZONE $3::text)::date, 'YYYY-MM-DD') AS day
       FROM ordered
     )
     SELECT user_id, day,
            COUNT(*) FILTER (WHERE outcome = 'success') AS successes,
            COUNT(*) FILTER (WHERE outcome = 'failure') AS failures,
            COUNT(*) FILTER (WHERE outcome = 'unknown') AS unknown,
            COUNT(*) FILTER (
              WHERE session_id IS NOT NULL
                AND outcome = 'failure'
                AND previous_outcome = 'failure'
                AND ts - previous_ts <= INTERVAL '30 minutes'
            ) AS repeated_failures,
            COUNT(*) FILTER (
              WHERE session_id IS NOT NULL
                AND outcome <> 'unknown'
                AND previous_outcome = 'failure'
                AND ts - previous_ts <= INTERVAL '30 minutes'
            ) AS recovery_attempts,
            COUNT(*) FILTER (
              WHERE session_id IS NOT NULL
                AND outcome = 'success'
                AND previous_outcome = 'failure'
                AND ts - previous_ts <= INTERVAL '30 minutes'
            ) AS successful_recoveries,
            COUNT(*) FILTER (
              WHERE outcome <> 'unknown' AND session_id IS NOT NULL
            ) AS session_tool_known_calls,
            COUNT(DISTINCT session_id) FILTER (
              WHERE session_id IS NOT NULL
            ) AS tool_active_sessions,
            COUNT(DISTINCT (activity_kind, item_key)) AS distinct_tools
     FROM tagged
     GROUP BY user_id, day
     ORDER BY day, user_id`,
    params,
  );
  return result.rows.map((row) => ({
    userId: String(row.user_id),
    day: String(row.day),
    successes: num(row.successes),
    failures: num(row.failures),
    unknown: num(row.unknown),
    repeatedFailures: num(row.repeated_failures),
    recoveryAttempts: num(row.recovery_attempts),
    successfulRecoveries: num(row.successful_recoveries),
    sessionToolKnownCalls: num(row.session_tool_known_calls),
    toolActiveSessions: num(row.tool_active_sessions),
    distinctTools: num(row.distinct_tools),
  }));
}

export function getUserUtilizationToolDays(
  userId: string,
  query: PeriodQuery,
  timezone: string,
): Promise<UtilizationToolDay[]> {
  return getUtilizationToolDaysWithDb(getPool(), query, timezone, userId);
}

export function getOrganizationUtilizationToolDays(
  query: PeriodQuery,
  timezone: string,
): Promise<UtilizationToolDay[]> {
  return getUtilizationToolDaysWithDb(getPool(), query, timezone);
}

export async function getMyDeviceInventoriesWithDb(
  db: ToolMetadataDb,
  userId: string,
): Promise<DeviceToolInventory[]> {
  const result = await db.query(
    `SELECT s.id, s.ingest_token_id, NULLIF(s.host, '') AS host, s.fingerprint,
            s.observed_at, s.received_at, i.kind, i.item_key, i.display_name,
            i.source_provider, i.plugin_key, i.version, i.enabled
     FROM device_tool_inventory_snapshots s
     LEFT JOIN device_tool_inventory_items i ON i.snapshot_id = s.id
     WHERE s.user_id = $1
     ORDER BY s.received_at DESC, i.kind, i.display_name`,
    [userId],
  );
  const grouped = new Map<string, DeviceToolInventory>();
  for (const row of result.rows) {
    const key = String(row.id);
    let inventory = grouped.get(key);
    if (!inventory) {
      inventory = {
        tokenId: String(row.ingest_token_id),
        host: row.host == null ? null : String(row.host),
        fingerprint: String(row.fingerprint),
        observedAt: new Date(String(row.observed_at)),
        receivedAt: new Date(String(row.received_at)),
        items: [],
      };
      grouped.set(key, inventory);
    }
    if (row.kind != null) {
      inventory.items.push({
        kind: row.kind as DeviceToolInventory["items"][number]["kind"],
        itemKey: String(row.item_key),
        displayName: String(row.display_name),
        sourceProvider: String(row.source_provider),
        pluginKey: row.plugin_key == null ? null : String(row.plugin_key),
        version: row.version == null ? null : String(row.version),
        enabled: Boolean(row.enabled),
      });
    }
  }
  return [...grouped.values()];
}

export function getMyDeviceInventories(userId: string): Promise<DeviceToolInventory[]> {
  return getMyDeviceInventoriesWithDb(getPool(), userId);
}
