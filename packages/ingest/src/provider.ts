import type { Provider } from "@toard/core";
import type { FlatLogRecord } from "./types";

/**
 * OTLP service.name → provider_key 도출 (설계 §4.4).
 * providers 는 DB(`providers.service_name_patterns`)에서 로드해 전달.
 */
export function identifyProvider(
  record: FlatLogRecord,
  providers: Provider[],
): string | null {
  const svc = record.resourceAttrs["service.name"];
  if (typeof svc !== "string") return null;
  for (const p of providers) {
    if (!p.enabled) continue;
    if (p.serviceNamePatterns.some((pat) => svc === pat)) {
      return p.key;
    }
  }
  return null;
}
