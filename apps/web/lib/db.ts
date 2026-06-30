import { Pool } from "pg";

let pool: Pool | undefined;

/** 메타·인증 쿼리용 공유 Pool (어느 모드든 메타는 PG — ADR-003) */
export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  return pool;
}
