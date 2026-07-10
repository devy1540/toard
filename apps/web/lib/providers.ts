import { getPool } from "./db";

export interface ProviderOption {
  key: string;
  label: string;
}

export function resolveInsightProvider(
  requested: string | undefined,
  providers: ProviderOption[],
): string | undefined {
  if (!requested || requested === "all") return undefined;
  return providers.some((provider) => provider.key === requested) ? requested : undefined;
}

/** 필터에 노출할 프로바이더 목록 — providers 테이블(enabled)에서 로드. */
export async function getEnabledProviders(): Promise<ProviderOption[]> {
  const r = await getPool().query<{ key: string; display_name: string }>(
    "SELECT key, display_name FROM providers WHERE enabled ORDER BY display_name",
  );
  return r.rows.map((row) => ({ key: row.key, label: row.display_name }));
}
