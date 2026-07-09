import { createHash } from "node:crypto";
import type { Provider } from "@toard/core";
import { getPool } from "./db";

export type IngestAuthResult = { userId: string; tokenId: string };

type QueryResultLike<T> = { rows: T[] };
type Queryable = {
  query(sql: string, params?: unknown[]): Promise<QueryResultLike<Record<string, unknown>>>;
};

/**
 * ingest 토큰 인증 (설계 §5.4, §10.1).
 * SHA-256 해시 조회 + 만료/폐기 체크. 반환 user_id 가 SSOT.
 */
export async function authenticateIngestToken(
  authHeader: string | null,
): Promise<IngestAuthResult | null> {
  return authenticateIngestTokenWithPool(authHeader, getPool());
}

export async function authenticateIngestTokenWithPool(
  authHeader: string | null,
  pool: Queryable,
): Promise<IngestAuthResult | null> {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice("Bearer ".length).trim();
  if (!token) return null;
  const hash = createHash("sha256").update(token).digest("hex");
  const res = await pool.query(
    `UPDATE ingest_tokens SET last_used_at = now()
     WHERE token_hash = $1
       AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > now())
     RETURNING id, user_id`,
    [hash],
  );
  const row = res.rows[0] as { id: string; user_id: string } | undefined;
  return row ? { tokenId: row.id, userId: row.user_id } : null;
}

/** enabled 프로바이더 로드 (service.name 매핑용 — 설계 §4.4) */
export async function loadProviders(): Promise<Provider[]> {
  const res = await getPool().query(
    `SELECT key, display_name, service_name_patterns, collection_method, enabled
     FROM providers WHERE enabled = true`,
  );
  return res.rows.map((r) => ({
    key: r.key,
    displayName: r.display_name,
    serviceNamePatterns: r.service_name_patterns,
    collectionMethod: r.collection_method,
    enabled: r.enabled,
  }));
}
