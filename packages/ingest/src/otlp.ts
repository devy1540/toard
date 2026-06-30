import type { FlatLogRecord } from "./types";

// OTLP/JSON 페이로드 타입(필요 부분만). ADR-001: http/json 만 1급 지원.
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

interface OtlpLogsPayload {
  resourceLogs?: Array<{
    resource?: { attributes?: KeyValue[] };
    scopeLogs?: Array<{
      scope?: { name?: string };
      logRecords?: Array<{
        timeUnixNano?: string | number;
        observedTimeUnixNano?: string | number;
        eventName?: string;
        attributes?: KeyValue[];
      }>;
    }>;
  }>;
}

/** OTLP/JSON logs 페이로드 → flat 레코드 (설계 §5.2~§5.3) */
export function parseOtlpLogs(payload: unknown): FlatLogRecord[] {
  const p = payload as OtlpLogsPayload;
  const out: FlatLogRecord[] = [];
  for (const rl of p.resourceLogs ?? []) {
    const resourceAttrs = attrsToRecord(rl.resource?.attributes);
    for (const sl of rl.scopeLogs ?? []) {
      const scopeName = sl.scope?.name ?? null;
      for (const lr of sl.logRecords ?? []) {
        const attrs = attrsToRecord(lr.attributes);
        const nano = Number(lr.timeUnixNano ?? lr.observedTimeUnixNano ?? 0);
        // ts 없는 레코드는 epoch(1970) 버킷으로 마트를 오염시키므로 제외
        if (!Number.isFinite(nano) || nano <= 0) continue;
        const eventName =
          lr.eventName ?? (typeof attrs["event.name"] === "string" ? (attrs["event.name"] as string) : null);
        out.push({ resourceAttrs, scopeName, eventName, ts: new Date(nano / 1e6), attrs });
      }
    }
  }
  return out;
}
