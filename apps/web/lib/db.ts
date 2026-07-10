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

/** 일회성 CLI 전용 종료 경로. 서버 startup/viewer에서는 호출하지 않는다. */
export async function closePool(): Promise<void> {
  const current = pool;
  pool = undefined;
  if (current) await current.end();
}
