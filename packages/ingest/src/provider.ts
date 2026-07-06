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
    // OTLP(/v1/logs) 는 collection_method='otel' provider 만 인정한다. logfile provider
    // (claude_code·codex 는 트랜스크립트 pull 로 전환 — design-usage-pull §5.2)의 OTLP 는
    // 여기서 미식별→드롭돼 pull 과 이중집계되지 않는다. enabled 는 pull(/v1/events)이
    // 여전히 필요로 하므로 유지(§5.2 자기검토).
    if (!p.enabled || p.collectionMethod !== "otel") continue;
    if (p.serviceNamePatterns.some((pat) => svc === pat)) {
      return p.key;
    }
  }
  return null;
}
