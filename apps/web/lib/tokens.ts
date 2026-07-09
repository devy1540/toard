import { createHash, randomBytes } from "node:crypto";
import type { QueryResult } from "pg";
import { getPool } from "./db";

// ingest 토큰: 평문은 발급 시 1회만 노출, DB 엔 sha256 해시만 저장(seed·ingest-auth 와 동일 방식).
export type TokenMeta = { createdAt: Date; lastUsedAt: Date | null };

function genToken(): string {
  return `tk_${randomBytes(24).toString("hex")}`;
}

function hashToken(t: string): string {
  return createHash("sha256").update(t).digest("hex");
}

/**
 * 새 설치용 ingest token 발급. 기존 활성 토큰은 유지한다.
 *
 * 같은 계정을 여러 머신에 설치하는 것이 정상 사용 흐름이므로, 발급은 additive 여야 한다.
 * 보안상 전체 토큰을 폐기해야 하는 경우에는 revokeActiveTokens 를 명시적으로 호출한다.
 * 평문 토큰은 오직 여기서만 반환된다(이후 조회 불가).
 */
export async function issueToken(userId: string): Promise<string> {
  return issueTokenWithPool(userId, getPool());
}

export async function issueTokenWithPool(
  userId: string,
  pool: { query(sql: string, params?: unknown[]): Promise<QueryResult | void> },
): Promise<string> {
  const token = genToken();
  const hash = hashToken(token);
  await pool.query("INSERT INTO ingest_tokens (user_id, token_hash) VALUES ($1, $2)", [userId, hash]);
  return token;
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
