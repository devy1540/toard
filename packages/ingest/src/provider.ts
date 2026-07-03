import type { Provider } from "@toard/core";
import type { FlatLogRecord, FlatMetricPoint } from "./types";

/**
 * resourceAttrs 의 service.name → provider_key 도출 (설계 §4.4).
 * providers 는 DB(`providers.service_name_patterns`)에서 로드해 전달.
 */
export function identifyProviderByResource(
  resourceAttrs: Record<string, string | number | boolean>,
  providers: Provider[],
): string | null {
  const svc = resourceAttrs["service.name"];
  if (typeof svc !== "string") return null;
  for (const p of providers) {
    if (!p.enabled) continue;
    if (p.serviceNamePatterns.some((pat) => svc === pat)) {
      return p.key;
    }
  }
  return null;
}

/** logs·metrics 공통 — 레코드/포인트의 resourceAttrs 로 provider 식별. */
export function identifyProvider(
  record: FlatLogRecord | FlatMetricPoint,
  providers: Provider[],
): string | null {
  return identifyProviderByResource(record.resourceAttrs, providers);
}
