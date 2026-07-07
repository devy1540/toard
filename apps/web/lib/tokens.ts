import { createHash, randomBytes } from "node:crypto";
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
 * user 당 활성 토큰 1개 정책 — 재발급(회전) 시 기존 활성 토큰을 폐기하고 새로 발급.
 * 평문 토큰은 오직 여기서만 반환된다(이후 조회 불가).
 */
export async function issueToken(userId: string): Promise<string> {
  const token = genToken();
  const hash = hashToken(token);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "UPDATE ingest_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL",
      [userId],
    );
    await client.query("INSERT INTO ingest_tokens (user_id, token_hash) VALUES ($1, $2)", [
      userId,
      hash,
    ]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
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
