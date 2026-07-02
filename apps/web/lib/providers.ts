import { getPool } from "./db";

export interface ProviderOption {
  key: string;
  label: string;
}

/** 필터에 노출할 프로바이더 목록 — providers 테이블(enabled)에서 로드. */
export async function getEnabledProviders(): Promise<ProviderOption[]> {
  const r = await getPool().query<{ key: string; display_name: string }>(
    "SELECT key, display_name FROM providers WHERE enabled ORDER BY display_name",
  );
  return r.rows.map((row) => ({ key: row.key, label: row.display_name }));
}
