// UsageEvent 와이어 포맷 (shim pull 경로, 설계 §5.6).
// JSON 계약: UsageEvent 와 동일 필드, ts 는 ISO 8601 문자열.
// 계약 원본은 이 TS 가 SSOT 이고 shim(Rust) 이 미러한다 —
// 양쪽 모두 fixtures/usage-event.golden.json 으로 검증해 드리프트를 CI 에서 잡는다.

import type { UsageEvent } from "./storage";

export class WireParseError extends Error {
  constructor(
    message: string,
    /** 몇 번째 이벤트에서 실패했는지 (단건 파싱은 undefined) */
    public readonly index?: number,
  ) {
    super(index === undefined ? message : `events[${index}]: ${message}`);
    this.name = "WireParseError";
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nonEmptyString(v: unknown, field: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new WireParseError(`${field} 는 비어있지 않은 문자열이어야 합니다`);
  }
  return v;
}

function nullableString(v: unknown, field: string): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") throw new WireParseError(`${field} 는 문자열 또는 null 이어야 합니다`);
  return v;
}

function tokenCount(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
    throw new WireParseError(`${field} 는 0 이상의 정수여야 합니다`);
  }
  return v;
}

/** 선택적 토큰 카운트 — 없거나 null 이면 0 (구 클라/OTLP 호환 필드). */
function optTokenCount(v: unknown, field: string): number {
  if (v === undefined || v === null) return 0;
  return tokenCount(v, field);
}

/** 와이어 JSON(unknown) 1건 → UsageEvent. 실패 시 WireParseError. */
export function parseUsageEventWire(v: unknown): UsageEvent {
  if (!isRecord(v)) throw new WireParseError("이벤트는 객체여야 합니다");
  // 계약 필드 순서대로 검증 — 오류 메시지가 항상 첫 문제 필드를 가리킨다
  const dedupKey = nonEmptyString(v.dedupKey, "dedupKey");
  const providerKey = nonEmptyString(v.providerKey, "providerKey");
  const userId = nullableString(v.userId, "userId");
  const sessionId = nullableString(v.sessionId, "sessionId");
  const model = nullableString(v.model, "model");
  const tsRaw = nonEmptyString(v.ts, "ts");
  const ts = new Date(tsRaw);
  if (Number.isNaN(ts.getTime())) throw new WireParseError(`ts 가 유효한 ISO 8601 이 아닙니다: ${tsRaw}`);
  const costUsd = v.costUsd === undefined ? 0 : v.costUsd;
  if (typeof costUsd !== "number" || !Number.isFinite(costUsd) || costUsd < 0) {
    throw new WireParseError("costUsd 는 0 이상의 숫자여야 합니다");
  }
  return {
    dedupKey,
    providerKey,
    userId,
    sessionId,
    model,
    ts,
    inputTokens: tokenCount(v.inputTokens, "inputTokens"),
    outputTokens: tokenCount(v.outputTokens, "outputTokens"),
    cacheReadTokens: tokenCount(v.cacheReadTokens, "cacheReadTokens"),
    cacheCreationTokens: tokenCount(v.cacheCreationTokens, "cacheCreationTokens"),
    cacheCreation1hTokens: optTokenCount(v.cacheCreation1hTokens, "cacheCreation1hTokens"),
    costUsd,
    logAdapter: nullableString(v.logAdapter, "logAdapter"),
    host: nullableString(v.host, "host"),
  };
}

/** POST /api/v1/events 본문(UsageEvent[] JSON) 파싱. */
export function parseUsageEventsBody(body: unknown): UsageEvent[] {
  if (!Array.isArray(body)) throw new WireParseError("본문은 UsageEvent 배열이어야 합니다");
  return body.map((item, i) => {
    try {
      return parseUsageEventWire(item);
    } catch (e) {
      if (e instanceof WireParseError && e.index === undefined) {
        throw new WireParseError(e.message.replace(/^events\[\d+\]: /, ""), i);
      }
      throw e;
    }
  });
}
