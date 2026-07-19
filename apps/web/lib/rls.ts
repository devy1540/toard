import type { PoolClient } from "pg";
import { getPool } from "./db";

/**
 * RLS 컨텍스트(app.current_user_id) 안에서 콜백을 실행한다.
 *
 * 전용 커넥션 + 트랜잭션 + set_config(local=true) 로 감싸므로, 풀 재사용 시
 * 컨텍스트가 다음 요청으로 새지 않는다. prompt_records 등 RLS 보호 테이블은
 * **반드시** 이 헬퍼 안에서만 쿼리한다(밖에서 쏘면 fail-closed 로 0건).
 *
 * 주의: RLS 는 앱이 비-superuser·비-BYPASSRLS 롤(예: toard_app)로 접속할 때만
 * 실제로 강제된다. superuser 접속이면 정책이 무시된다(= "DB 직접 접근" 탈출구).
 * 마이그레이션 파일 하단의 운영 부트스트랩 주석 참고.
 */
export async function withUserContext<T>(
  userId: string,
  fn: (tx: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // set_config(_, _, true) = 트랜잭션 로컬 → COMMIT/ROLLBACK 시 자동 해제
    await client.query("SELECT set_config('app.current_user_id', $1, true)", [userId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
