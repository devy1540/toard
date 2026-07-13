import { createHash, randomBytes } from "node:crypto";
import { getPool } from "./db";

// ingest 토큰: 평문은 발급 시 1회만 노출, DB 엔 sha256 해시만 저장(seed·ingest-auth 와 동일 방식).
export type TokenMeta = { createdAt: Date; lastUsedAt: Date | null };
export type IssuedIngestToken = { token: string; tokenId: string };
export type TokenConnectionStatus = {
  connected: boolean;
  lastUsedAt: Date | null;
  lastHost: string | null;
};
export type IngestTokenRow = {
  id: string;
  label: string | null;
  lastHost: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
};

type QueryResultLike = { rows: Record<string, unknown>[]; rowCount?: number | null };
type Queryable = {
  query(sql: string, params?: unknown[]): Promise<QueryResultLike | void>;
};

const TOKEN_LABEL_MAX_LEN = 80;

function genToken(): string {
  return `tk_${randomBytes(24).toString("hex")}`;
}

function hashToken(t: string): string {
  return createHash("sha256").update(t).digest("hex");
}

function normalizeLabel(label: string | null | undefined): string | null {
  const trimmed = label?.trim();
  return trimmed ? trimmed.slice(0, TOKEN_LABEL_MAX_LEN) : null;
}

/**
 * 새 설치용 ingest token 발급. 기존 활성 토큰은 유지한다.
 *
 * 같은 계정을 여러 머신에 설치하는 것이 정상 사용 흐름이므로, 발급은 additive 여야 한다.
 * 보안상 전체 토큰을 폐기해야 하는 경우에는 revokeActiveTokens 를 명시적으로 호출한다.
 * 평문 토큰은 오직 여기서만 반환된다(이후 조회 불가).
 */
export async function issueToken(userId: string, label?: string | null): Promise<string> {
  return issueTokenWithPool(userId, getPool(), label);
}

export async function issueTokenWithPool(
  userId: string,
  pool: Queryable,
  label?: string | null,
): Promise<string> {
  return (await createTokenWithPool(userId, pool, label)).token;
}

async function createTokenWithPool(
  userId: string,
  pool: Queryable,
  label?: string | null,
): Promise<IssuedIngestToken> {
  const token = genToken();
  const hash = hashToken(token);
  const result = await pool.query(
    "INSERT INTO ingest_tokens (user_id, token_hash, device_label) VALUES ($1, $2, $3) RETURNING id",
    [userId, hash, normalizeLabel(label)],
  );
  const tokenId = result?.rows[0]?.id;
  if (typeof tokenId !== "string") throw new Error("ingest token id missing");
  return { token, tokenId };
}

export async function issueDeviceToken(userId: string): Promise<IssuedIngestToken> {
  return issueDeviceTokenWithPool(userId, getPool());
}

export async function issueDeviceTokenWithPool(
  userId: string,
  pool: Queryable,
): Promise<IssuedIngestToken> {
  return createTokenWithPool(userId, pool, null);
}

export async function getTokenConnectionStatus(
  userId: string,
  tokenId: string,
): Promise<TokenConnectionStatus> {
  return getTokenConnectionStatusWithPool(userId, tokenId, getPool());
}

export async function getTokenConnectionStatusWithPool(
  userId: string,
  tokenId: string,
  pool: Queryable,
): Promise<TokenConnectionStatus> {
  const result = await pool.query(
    `SELECT last_used_at, last_host FROM ingest_tokens
     WHERE user_id = $1 AND id = $2 AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > now())`,
    [userId, tokenId],
  );
  const row = result?.rows[0] as
    | { last_used_at: Date | null; last_host: string | null }
    | undefined;
  return {
    connected: Boolean(row?.last_used_at),
    lastUsedAt: row?.last_used_at ?? null,
    lastHost: row?.last_host ?? null,
  };
}

export async function listActiveTokens(userId: string): Promise<IngestTokenRow[]> {
  return listActiveTokensWithPool(userId, getPool());
}

export async function listActiveTokensWithPool(
  userId: string,
  pool: Queryable,
): Promise<IngestTokenRow[]> {
  type TokenDbRow = {
    id: string;
    device_label: string | null;
    last_host: string | null;
    created_at: Date;
    last_used_at: Date | null;
    expires_at: Date | null;
    revoked_at: Date | null;
  };
  const r = await pool.query(
    `SELECT id, device_label, last_host, created_at, last_used_at, expires_at, revoked_at
     FROM ingest_tokens
     WHERE user_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
     ORDER BY created_at DESC`,
    [userId],
  );
  return ((r?.rows ?? []) as TokenDbRow[]).map((x) => ({
    id: x.id,
    label: x.device_label,
    lastHost: x.last_host,
    createdAt: x.created_at,
    lastUsedAt: x.last_used_at,
    expiresAt: x.expires_at,
    revokedAt: x.revoked_at,
  }));
}

export async function revokeToken(userId: string, tokenId: string): Promise<boolean> {
  return revokeTokenWithPool(userId, tokenId, getPool());
}

export async function revokeTokenWithPool(
  userId: string,
  tokenId: string,
  pool: Queryable,
): Promise<boolean> {
  const r = await pool.query(
    "UPDATE ingest_tokens SET revoked_at = now() WHERE user_id = $1 AND id = $2 AND revoked_at IS NULL",
    [userId, tokenId],
  );
  return Boolean(r?.rowCount);
}

export async function recordTokenHost(
  tokenId: string,
  hosts: Array<string | null | undefined>,
): Promise<void> {
  await recordTokenHostWithPool(tokenId, hosts, getPool());
}

export async function recordTokenHostWithPool(
  tokenId: string,
  hosts: Array<string | null | undefined>,
  pool: Queryable,
): Promise<void> {
  const host = hosts.find((h): h is string => typeof h === "string" && h.trim().length > 0)?.trim();
  if (!host) return;
  await pool.query("UPDATE ingest_tokens SET last_host = $2 WHERE id = $1 AND revoked_at IS NULL", [
    tokenId,
    host,
  ]);
}

/**
 * 활성 토큰 메타(평문 아님). 없으면 null.
 * 정책은 user 당 활성 1개지만 과거 seed 중복 발급 등으로 여러 개일 수 있다 — 최신 1개만 보면
 * 실제 수신 중인 옛 토큰을 놓쳐 "미설치"로 오판하므로(대시보드 설치 CTA·설정 연결 상태),
 * 활성 토큰 전체를 집계한다: lastUsedAt = 가장 최근 수신, createdAt = 가장 최근 발급.
 */
export async function getActiveTokenMeta(userId: string): Promise<TokenMeta | null> {
  const r = await getPool().query<{ created_at: Date | null; last_used_at: Date | null }>(
    `SELECT MAX(created_at) AS created_at, MAX(last_used_at) AS last_used_at FROM ingest_tokens
     WHERE user_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,
    [userId],
  );
  const row = r.rows[0];
  return row?.created_at ? { createdAt: row.created_at, lastUsedAt: row.last_used_at } : null;
}

export async function revokeActiveTokens(userId: string): Promise<void> {
  await getPool().query(
    "UPDATE ingest_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL",
    [userId],
  );
}
