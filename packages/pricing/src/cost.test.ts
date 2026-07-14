import assert from "node:assert/strict";
import { test } from "node:test";
import { resolvePricingEntry } from "./aliases";
import { resolveCost, resolveCostAt } from "./cost";
import type { PricingMap, PricingSchedule } from "./types";

const pricing: PricingMap = new Map([
  ["claude-sonnet-4-6", { inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3, cacheCreatePerM: 3.75 }],
  ["claude-opus", { inputPerM: 15, outputPerM: 75, inputAbove200kPerM: 30, outputAbove200kPerM: 150 }],
]);

const base = { outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, pricing };

test("display 모드는 제공값 그대로", () => {
  const c = resolveCost({ ...base, model: "x", inputTokens: 0, providedCostUsd: 1.23, mode: "display" });
  assert.equal(c, 1.23);
});

test("auto 모드는 제공값 없으면 토큰으로 계산", () => {
  // 1M input @ $3/M = 3
  const c = resolveCost({ ...base, model: "claude-sonnet-4-6", inputTokens: 1_000_000 });
  assert.equal(c, 3);
});

test("calculate 모드는 제공값 무시", () => {
  const c = resolveCost({ ...base, model: "claude-sonnet-4-6", inputTokens: 1_000_000, providedCostUsd: 999, mode: "calculate" });
  assert.equal(c, 3);
});

test("캐시 fallback: 미제공 모델은 생성 input×1.25 / 읽기 input×0.1", () => {
  const m: PricingMap = new Map([["m", { inputPerM: 10, outputPerM: 20 }]]);
  // read: 1M×(10×0.1)/1e6=1, create: 1M×(10×1.25)/1e6=12.5
  const c = resolveCost({ model: "m", inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheCreationTokens: 1_000_000, pricing: m });
  assert.equal(c, 13.5);
});

test("캐시생성 5m/1h 차등: 1h=input×2, 5m=cacheCreate(§리스크 B)", () => {
  const m: PricingMap = new Map([["m", { inputPerM: 10, outputPerM: 20 }]]);
  const cc = (creation: number, oneH: number) =>
    resolveCost({ model: "m", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: creation, cacheCreation1hTokens: oneH, pricing: m });
  // 전량 1h: 1M×(10×2)/1e6 = 20
  assert.equal(cc(1_000_000, 1_000_000), 20);
  // 전량 5m: 1M×(10×1.25)/1e6 = 12.5
  assert.equal(cc(1_000_000, 0), 12.5);
  // 혼합 400k 1h + 600k 5m: 0.4M×20/1e6 + 0.6M×12.5/1e6 = 8 + 7.5 = 15.5
  assert.equal(cc(1_000_000, 400_000), 15.5);
  // 방어: 1h > total 이면 total 로 클램프(전량 1h)
  assert.equal(cc(1_000_000, 5_000_000), 20);
});

test("캐시생성 1h 미제공(구 클라·OTLP)이면 전량 5m — 종전 동작 불변", () => {
  const m: PricingMap = new Map([["m", { inputPerM: 10, outputPerM: 20 }]]);
  const withZero = resolveCost({ model: "m", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 1_000_000, cacheCreation1hTokens: 0, pricing: m });
  const without = resolveCost({ model: "m", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 1_000_000, pricing: m });
  assert.equal(withZero, without);
  assert.equal(without, 12.5); // 전량 5m = 1M×(10×1.25)/1e6
});

test("200k tiered: 처음 200k 기본가 + 초과분 차등가", () => {
  // 300k input: 200k×15 + 100k×30, /1e6 = 6
  const c = resolveCost({ ...base, model: "claude-opus", inputTokens: 300_000 });
  assert.equal(c, (200_000 * 15 + 100_000 * 30) / 1e6);
});

test("fast 배수 적용", () => {
  const m: PricingMap = new Map([["m", { inputPerM: 10, outputPerM: 20, fastMultiplier: 2 }]]);
  const c = resolveCost({ model: "m", inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, isFast: true, pricing: m });
  assert.equal(c, 20); // (1M×10/1e6=10) × 2
});

test("resolveCostAt은 사용 시각 이하의 마지막 revision을 선택한다", () => {
  const schedule: PricingSchedule = new Map([["model-a", [
    { id: "old", modelId: "model-a", effectiveAt: new Date("2026-07-01T00:00:00Z"), pricing: { inputPerM: 1, outputPerM: 1 } },
    { id: "new", modelId: "model-a", effectiveAt: new Date("2026-07-11T00:00:00Z"), pricing: { inputPerM: 2, outputPerM: 2 } },
  ]] ]);

  assert.deepEqual(resolveCostAt({
    model: "model-a",
    occurredAt: new Date("2026-07-10T23:59:59Z"),
    inputTokens: 1_000_000,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    schedule,
    mode: "calculate",
  }), { costUsd: 1, pricingRevisionId: "old", status: "priced" });
});

test("resolveCostAt은 일치 가격이 없으면 unpriced를 돌려준다", () => {
  assert.deepEqual(resolveCostAt({
    model: "missing",
    occurredAt: new Date("2026-07-10T00:00:00Z"),
    inputTokens: 1,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    schedule: new Map(),
    mode: "calculate",
  }), { costUsd: 0, pricingRevisionId: null, status: "unpriced" });
});

test("resolveCostAt은 기존 모델 alias 정규화를 사용한다", () => {
  const schedule: PricingSchedule = new Map([["model-a", [
    { id: "aliased", modelId: "model-a", effectiveAt: new Date("2026-07-01T00:00:00Z"), pricing: { inputPerM: 3, outputPerM: 1 } },
  ]] ]);

  assert.deepEqual(resolveCostAt({
    model: "anthropic.model-a-20260710",
    occurredAt: new Date("2026-07-10T00:00:00Z"),
    inputTokens: 1_000_000,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    schedule,
    mode: "calculate",
  }), { costUsd: 3, pricingRevisionId: "aliased", status: "priced" });
});

test("resolveCostAt은 auto 모드에서도 제공 비용 대신 revision 가격을 확정한다", () => {
  const schedule: PricingSchedule = new Map([["model-a", [
    { id: "rev-1", modelId: "model-a", effectiveAt: new Date("2026-07-01T00:00:00Z"), pricing: { inputPerM: 1, outputPerM: 1 } },
  ]] ]);

  assert.deepEqual(resolveCostAt({
    model: "model-a",
    occurredAt: new Date("2026-07-10T00:00:00Z"),
    inputTokens: 1_000_000,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    providedCostUsd: 99,
    schedule,
    mode: "auto",
  }), { costUsd: 1, pricingRevisionId: "rev-1", status: "priced" });
});

test("resolveCostAt은 historical revision의 반열린 유효 구간만 사용한다", () => {
  const schedule: PricingSchedule = new Map([["model-a", [{
    id: "history-1",
    modelId: "model-a",
    effectiveAt: new Date("2026-06-01T00:00:00Z"),
    validUntil: new Date("2026-06-11T00:00:00Z"),
    pricing: { inputPerM: 5, outputPerM: 25 },
  }]]]);
  const resolveAt = (occurredAt: string) => resolveCostAt({
    model: "model-a",
    occurredAt: new Date(occurredAt),
    inputTokens: 1_000_000,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    schedule,
    mode: "calculate",
  });

  assert.deepEqual(resolveAt("2026-06-10T23:59:59.999Z"), {
    costUsd: 5,
    pricingRevisionId: "history-1",
    status: "priced",
  });
  assert.deepEqual(resolveAt("2026-06-11T00:00:00Z"), {
    costUsd: 0,
    pricingRevisionId: null,
    status: "unpriced",
  });
});

test("가격 alias resolver는 실제로 매칭한 LiteLLM source key를 반환한다", () => {
  const pricingMap: PricingMap = new Map([
    ["claude-opus-4-8", { inputPerM: 5, outputPerM: 25 }],
  ]);

  assert.deepEqual(resolvePricingEntry("anthropic.claude-opus-4-8", pricingMap), {
    modelId: "claude-opus-4-8",
    pricing: { inputPerM: 5, outputPerM: 25 },
  });
  assert.equal(resolvePricingEntry("missing", pricingMap), undefined);
});
