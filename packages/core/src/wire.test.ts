import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseUsageEventsBody, parseUsageEventWire, WireParseError } from "./wire";

// 계약 골든 fixture — shim(Rust) 미러 테스트와 동일 파일을 읽는다 (§5.6 드리프트 방지)
const golden = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../../fixtures/usage-event.golden.json"), "utf8"),
) as unknown;

test("골든 fixture 전체가 파싱된다", () => {
  const events = parseUsageEventsBody(golden);
  assert.equal(events.length, 3);
  const [full, minimal, cached] = events;
  assert.equal(full!.providerKey, "gemini");
  assert.equal(full!.ts.toISOString(), "2026-07-01T12:00:00.000Z");
  assert.equal(full!.cacheReadTokens, 500);
  assert.equal(full!.logAdapter, "gemini");
  assert.equal(minimal!.sessionId, null);
  assert.equal(minimal!.model, null);
  assert.equal(minimal!.logAdapter, null, "logAdapter 는 선택적 — 없으면 null");
  assert.equal(cached!.cacheCreationTokens, 4096);
  // host — 값 / 부재(→null) / 명시적 null 세 케이스 (§design-host-breakdown)
  assert.equal(full!.host, "alice-macbook", "host 값 파싱");
  assert.equal(minimal!.host, null, "host 는 선택적 — 없으면 null");
  assert.equal(cached!.host, null, "host 명시적 null");
  // shim 은 cost 를 계산하지 않는다 — 서버 권위 (§5.6)
  for (const e of events) assert.equal(e.costUsd, 0);
});

test("필수 필드 누락·형식 오류는 인덱스와 함께 거부", () => {
  assert.throws(
    () => parseUsageEventsBody([{ providerKey: "x" }]),
    (e: unknown) => e instanceof WireParseError && e.index === 0 && /dedupKey/.test(e.message),
  );
  assert.throws(
    () => parseUsageEventWire({ dedupKey: "d", providerKey: "p", ts: "not-a-date", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }),
    /ISO 8601/,
  );
  assert.throws(
    () => parseUsageEventWire({ dedupKey: "d", providerKey: "p", ts: "2026-07-01T00:00:00Z", inputTokens: -1, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }),
    /inputTokens/,
  );
  assert.throws(
    () => parseUsageEventWire({ dedupKey: "d", providerKey: "p", ts: "2026-07-01T00:00:00Z", inputTokens: 1.5, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }),
    /inputTokens/,
  );
  assert.throws(() => parseUsageEventsBody({ events: [] }), /배열/);
});

test("userId·costUsd 는 와이어에서 선택적 (서버가 덮어씀)", () => {
  const e = parseUsageEventWire({
    dedupKey: "d",
    providerKey: "p",
    ts: "2026-07-01T00:00:00Z",
    inputTokens: 1,
    outputTokens: 2,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  });
  assert.equal(e.userId, null);
  assert.equal(e.costUsd, 0);
});
