import { getPool } from "./db";

/** 서버 전역 설정(app_settings) 조회 — 없으면 undefined. */
export async function getAppSetting<T>(key: string): Promise<T | undefined> {
  const r = await getPool().query<{ value: T }>("SELECT value FROM app_settings WHERE key = $1", [
    key,
  ]);
  return r.rows[0]?.value;
}

/** 서버 전역 설정 저장 (UPSERT) — 재시작 없이 바꿔야 하는 운영 설정용. */
export async function setAppSetting(key: string, value: unknown): Promise<void> {
  await getPool().query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}
