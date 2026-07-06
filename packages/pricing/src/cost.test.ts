import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveCost } from "./cost";
import type { PricingMap } from "./types";

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
