import type { FlatMetricPoint } from "./types";

// OTLP/JSON metrics 페이로드 타입(필요 부분만). Claude Code 2.x 는 토큰/비용을
// api_request 로그가 아니라 metrics(claude_code.token.usage·cost.usage)로 보낸다.
type AnyValue = {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
  boolValue?: boolean;
};
type KeyValue = { key: string; value?: AnyValue };
type Scalar = string | number | boolean;

function attrValue(v: AnyValue | undefined): Scalar {
  if (!v) return "";
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.intValue !== undefined) return typeof v.intValue === "string" ? Number(v.intValue) : v.intValue;
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.boolValue !== undefined) return v.boolValue;
  return "";
}

function attrsToRecord(kvs: KeyValue[] | undefined): Record<string, Scalar> {
  const out: Record<string, Scalar> = {};
  for (const kv of kvs ?? []) out[kv.key] = attrValue(kv.value);
  return out;
}

type NumberDataPoint = {
  attributes?: KeyValue[];
  startTimeUnixNano?: string | number;
  timeUnixNano?: string | number;
  asInt?: string | number;
  asDouble?: number;
};

interface OtlpMetricsPayload {
  resourceMetrics?: Array<{
    resource?: { attributes?: KeyValue[] };
    scopeMetrics?: Array<{
      scope?: { name?: string };
      metrics?: Array<{
        name?: string;
        sum?: { dataPoints?: NumberDataPoint[] };
        gauge?: { dataPoints?: NumberDataPoint[] };
      }>;
    }>;
  }>;
}

function pointValue(dp: NumberDataPoint): number {
  if (dp.asInt !== undefined) return typeof dp.asInt === "string" ? Number(dp.asInt) : dp.asInt;
  if (dp.asDouble !== undefined) return dp.asDouble;
  return 0;
}

/**
 * OTLP/JSON metrics 페이로드 → flat 데이터포인트 (Sum·Gauge 만).
 * 각 데이터포인트는 (metricName, 속성, 값)으로 평탄화된다. temporality 는 무시한다 —
 * Claude Code 는 export 마다 세션 누적값을 반복 전송하므로(관측), 정규화기가
 * (session, model)당 최신 누적으로 수렴시킨다(설계: metric upsert).
 */
export function parseOtlpMetrics(payload: unknown): FlatMetricPoint[] {
  const p = payload as OtlpMetricsPayload;
  const out: FlatMetricPoint[] = [];
  for (const rm of p.resourceMetrics ?? []) {
    const resourceAttrs = attrsToRecord(rm.resource?.attributes);
    for (const sm of rm.scopeMetrics ?? []) {
      const scopeName = sm.scope?.name ?? null;
      for (const m of sm.metrics ?? []) {
        const name = m.name;
        if (!name) continue;
        const dps = m.sum?.dataPoints ?? m.gauge?.dataPoints ?? [];
        for (const dp of dps) {
          const nano = Number(dp.startTimeUnixNano ?? dp.timeUnixNano ?? 0);
          // ts 없는 포인트는 epoch(1970) 버킷으로 마트를 오염시키므로 제외
          if (!Number.isFinite(nano) || nano <= 0) continue;
          out.push({
            resourceAttrs,
            scopeName,
            metricName: name,
            ts: new Date(nano / 1e6),
            attrs: attrsToRecord(dp.attributes),
            value: pointValue(dp),
          });
        }
      }
    }
  }
  return out;
}
