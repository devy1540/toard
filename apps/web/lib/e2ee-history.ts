import type { PoolClient } from "pg";
import { withUserContext } from "./rls";
import type { E2eePromptRecordWire } from "./e2ee-contract";

export const E2EE_DETAIL_TURN_LIMIT = 500;

type QueryResultLike = { rows: Record<string, unknown>[] };
export type E2eeHistoryDb = {
  query(sql: string, params?: unknown[]): Promise<QueryResultLike>;
};

export type E2eeHistorySessionSummary = {
  key: string;
  providerKey: string;
  turnCount: number;
  firstTs: string;
  latestTs: string;
  previewRecord: E2eePromptRecordWire | null;
};

export type E2eeHistoryPage = {
  sessions: E2eeHistorySessionSummary[];
  totalSessions: number;
};

export type E2eeHistoryDetail = {
  key: string;
  turns: E2eePromptRecordWire[];
  truncated: boolean;
};

export type E2eeContentStatus = {
  state: "off" | "pending" | "active";
  keyVersion: number | null;
  approvedDeviceCount: number;
  recoveryConfirmedAt: string | null;
};

type HistoryOptions = { limit?: number; offset?: number };

export async function getE2eeHistorySessions(
  userId: string,
  options: HistoryOptions = {},
  db?: E2eeHistoryDb,
): Promise<E2eeHistoryPage> {
  const limit = clampInteger(options.limit, 1, 100, 20);
  const offset = clampInteger(options.offset, 0, 100_000, 0);
  const result = await runInContext(userId, db, (tx) =>
    tx.query(
      `WITH scoped AS (
         SELECT *, COALESCE(session_id, dedup_key) AS gkey,
                ROW_NUMBER() OVER (
                  PARTITION BY COALESCE(session_id, dedup_key)
                  ORDER BY (turn_role = 'user') DESC, ts ASC
                ) AS preview_rank
         FROM prompt_records
         WHERE user_id = $1 AND encryption_scheme = 'e2ee_v1'
       ), grouped AS (
         SELECT gkey, MIN(provider_key) AS provider_key, COUNT(*) AS turn_count,
                MIN(ts) AS first_ts, MAX(ts) AS latest_ts
         FROM scoped
         GROUP BY gkey
       ), page AS (
         SELECT *, COUNT(*) OVER () AS total_groups
         FROM grouped
         ORDER BY latest_ts DESC
         LIMIT $2 OFFSET $3
       )
       SELECT page.*, scoped.dedup_key, scoped.session_id, scoped.turn_role, scoped.ts,
              scoped.content_owner_id, scoped.content_key_version, scoped.wrapped_dek,
              scoped.dek_wrap_iv, scoped.dek_wrap_auth_tag, scoped.iv, scoped.ciphertext,
              scoped.auth_tag, scoped.aad_version
       FROM page
       LEFT JOIN scoped ON scoped.gkey = page.gkey AND scoped.preview_rank = 1
       ORDER BY page.latest_ts DESC`,
      [userId, limit, offset],
    ),
  );

  return {
    totalSessions: result.rows.length > 0 ? asNumber(result.rows[0]!.total_groups) : 0,
    sessions: result.rows.map((row) => ({
      key: asString(row.gkey),
      providerKey: asString(row.provider_key),
      turnCount: asNumber(row.turn_count),
      firstTs: asDate(row.first_ts).toISOString(),
      latestTs: asDate(row.latest_ts).toISOString(),
      previewRecord: row.dedup_key == null ? null : toWireRecord(row),
    })),
  };
}

export async function getE2eeHistorySession(
  userId: string,
  key: string,
  db?: E2eeHistoryDb,
): Promise<E2eeHistoryDetail | null> {
  if (!key || key.length > 255) return null;
  const result = await runInContext(userId, db, (tx) =>
    tx.query(
      `SELECT dedup_key, session_id, provider_key, turn_role, ts, content_owner_id,
              content_key_version, wrapped_dek, dek_wrap_iv, dek_wrap_auth_tag, iv,
              ciphertext, auth_tag, aad_version
       FROM prompt_records
       WHERE user_id = $1
         AND encryption_scheme = 'e2ee_v1'
         AND (session_id = $2 OR (session_id IS NULL AND dedup_key = $2))
       ORDER BY ts ASC
       LIMIT $3`,
      [userId, key, E2EE_DETAIL_TURN_LIMIT + 1],
    ),
  );
  if (result.rows.length === 0) return null;
  return {
    key,
    turns: result.rows.slice(0, E2EE_DETAIL_TURN_LIMIT).map(toWireRecord),
    truncated: result.rows.length > E2EE_DETAIL_TURN_LIMIT,
  };
}

export async function getE2eeContentStatus(
  userId: string,
  db?: E2eeHistoryDb,
): Promise<E2eeContentStatus> {
  const result = await runInContext(userId, db, (tx) =>
    tx.query(
      `SELECT account.state, account.active_key_version, account.recovery_confirmed_at,
              COUNT(device.id) FILTER (
                WHERE device.approved_at IS NOT NULL AND device.revoked_at IS NULL
              ) AS approved_device_count
       FROM content_accounts account
       LEFT JOIN content_devices device ON device.user_id = account.user_id
       WHERE account.user_id = $1
       GROUP BY account.user_id, account.state, account.active_key_version,
                account.recovery_confirmed_at`,
      [userId],
    ),
  );
  const row = result.rows[0];
  if (!row) {
    return { state: "off", keyVersion: null, approvedDeviceCount: 0, recoveryConfirmedAt: null };
  }
  if (row.state !== "pending" && row.state !== "active") throw new Error("INVALID_CONTENT_STATE");
  return {
    state: row.state,
    keyVersion: asNumber(row.active_key_version),
    approvedDeviceCount: asNumber(row.approved_device_count),
    recoveryConfirmedAt: row.recovery_confirmed_at == null
      ? null
      : asDate(row.recovery_confirmed_at).toISOString(),
  };
}

function toWireRecord(row: Record<string, unknown>): E2eePromptRecordWire {
  const role = row.turn_role;
  if (role !== "user" && role !== "assistant") throw new Error("INVALID_CONTENT_ROLE");
  const aadVersion = asNumber(row.aad_version);
  if (aadVersion !== 1) throw new Error("INVALID_AAD_VERSION");
  return {
    schema: "e2ee_v1",
    algorithm: "AES-256-GCM",
    aadVersion: 1,
    contentOwnerId: asString(row.content_owner_id),
    contentKeyVersion: asNumber(row.content_key_version),
    dedupKey: asString(row.dedup_key),
    sessionId: row.session_id == null ? null : asString(row.session_id),
    providerKey: asString(row.provider_key),
    turnRole: role,
    ts: asDate(row.ts).toISOString(),
    wrappedDek: asBuffer(row.wrapped_dek).toString("base64url"),
    dekWrapIv: asBuffer(row.dek_wrap_iv).toString("base64url"),
    dekWrapAuthTag: asBuffer(row.dek_wrap_auth_tag).toString("base64url"),
    iv: asBuffer(row.iv).toString("base64url"),
    ciphertext: asBuffer(row.ciphertext).toString("base64url"),
    authTag: asBuffer(row.auth_tag).toString("base64url"),
  };
}

async function runInContext<T>(
  userId: string,
  db: E2eeHistoryDb | undefined,
  fn: (tx: E2eeHistoryDb) => Promise<T>,
): Promise<T> {
  if (!userId) throw new Error("INVALID_USER_ID");
  if (db) return fn(db);
  return withUserContext(userId, (tx: PoolClient) => fn(tx));
}

function clampInteger(value: number | undefined, min: number, max: number, fallback: number): number {
  return Number.isInteger(value) ? Math.min(max, Math.max(min, value!)) : fallback;
}

function asString(value: unknown): string {
  if (typeof value !== "string") throw new Error("INVALID_CONTENT_ROW");
  return value;
}

function asNumber(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("INVALID_CONTENT_ROW");
  return parsed;
}

function asDate(value: unknown): Date {
  const parsed = value instanceof Date ? value : new Date(asString(value));
  if (Number.isNaN(parsed.getTime())) throw new Error("INVALID_CONTENT_ROW");
  return parsed;
}

function asBuffer(value: unknown): Buffer {
  if (!Buffer.isBuffer(value)) throw new Error("INVALID_CONTENT_ROW");
  return value;
}
