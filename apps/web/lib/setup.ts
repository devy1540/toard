import { getPool } from "./db";

/** 사용자가 한 명이라도 있으면 true. 첫 실행(/setup) 게이팅용. */
export async function hasAnyUser(): Promise<boolean> {
  const r = await getPool().query("SELECT 1 FROM users LIMIT 1");
  return (r.rowCount ?? 0) > 0;
}
