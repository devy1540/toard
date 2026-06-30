import { Pool } from "pg";

let pool: Pool | undefined;

/** 메타·인증 쿼리용 공유 Pool (어느 모드든 메타는 PG — ADR-003) */
export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.PG_POOL_MAX ?? 10),
      connectionTimeoutMillis: 5_000, // 고갈 시 무한 대기 방지(기본 0=무한)
      idleTimeoutMillis: 30_000,
    });
  }
  return pool;
}
