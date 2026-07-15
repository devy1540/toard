import assert from "node:assert/strict";
import test from "node:test";
import type { ModelPricing, PricingMap } from "@toard/pricing";
import {
  applyPricingSnapshot,
  closePricingIntervals,
  createPricingIntervalState,
  type PricingHistorySnapshot,
} from "./pricing-history-intervals";

function snapshot(
  char: string,
  committedAt: string,
  entries: Record<string, ModelPricing>,
): PricingHistorySnapshot {
  return {
    ref: { sha: char.repeat(40), committedAt },
    pricing: new Map(Object.entries(entries)) as PricingMap,
  };
}

test("가격 추가·변경·삭제는 source commit 근거의 반열린 구간을 만든다", () => {
  let state = createPricingIntervalState({
    rangeFrom: new Date("2026-06-01T00:00:00Z"),
    models: ["anthropic.claude-opus"],
  });
  state = applyPricingSnapshot(state, snapshot("a", "2026-05-31T23:00:00Z", {
    "claude-opus": { inputPerM: 5, outputPerM: 25 },
  }));
  state = applyPricingSnapshot(state, snapshot("b", "2026-06-15T00:00:00Z", {
    "claude-opus": { inputPerM: 6, outputPerM: 30 },
  }));
  state = applyPricingSnapshot(state, snapshot("c", "2026-06-20T00:00:00Z", {}));

  assert.deepEqual(closePricingIntervals(state, new Date("2026-07-01T00:00:00Z")), [
    {
      modelId: "anthropic.claude-opus",
      sourceModelId: "claude-opus",
      effectiveAt: new Date("2026-06-01T00:00:00Z"),
      validUntil: new Date("2026-06-15T00:00:00Z"),
      pricing: { inputPerM: 5, outputPerM: 25 },
      sourceCommitSha: "a".repeat(40),
      sourceCommittedAt: new Date("2026-05-31T23:00:00Z"),
    },
    {
      modelId: "anthropic.claude-opus",
      sourceModelId: "claude-opus",
      effectiveAt: new Date("2026-06-15T00:00:00Z"),
      validUntil: new Date("2026-06-20T00:00:00Z"),
      pricing: { inputPerM: 6, outputPerM: 30 },
      sourceCommitSha: "b".repeat(40),
      sourceCommittedAt: new Date("2026-06-15T00:00:00Z"),
    },
  ]);
});

test("동일 가격 snapshot은 구간을 나누지 않고 마지막 검증 시각까지 닫는다", () => {
  let state = createPricingIntervalState({
    rangeFrom: new Date("2026-06-01T00:00:00Z"),
    models: ["model-a"],
  });
  state = applyPricingSnapshot(state, snapshot("a", "2026-05-31T00:00:00Z", {
    "model-a": { inputPerM: 1, outputPerM: 2, fastMultiplier: 1 },
  }));
  state = applyPricingSnapshot(state, snapshot("b", "2026-06-10T00:00:00Z", {
    "model-a": { inputPerM: 1, outputPerM: 2 },
  }));

  const candidates = closePricingIntervals(state, new Date("2026-07-01T00:00:00Z"));
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.effectiveAt.toISOString(), "2026-06-01T00:00:00.000Z");
  assert.equal(candidates[0]?.validUntil.toISOString(), "2026-07-01T00:00:00.000Z");
  assert.equal(candidates[0]?.sourceCommitSha, "a".repeat(40));
});

test("baseline에 없던 모델은 처음 확인된 commit 시각부터만 유효하다", () => {
  let state = createPricingIntervalState({
    rangeFrom: new Date("2026-06-01T00:00:00Z"),
    models: ["model-a"],
  });
  state = applyPricingSnapshot(state, snapshot("a", "2026-05-31T00:00:00Z", {}));
  state = applyPricingSnapshot(state, snapshot("b", "2026-06-07T03:00:00Z", {
    "model-a": { inputPerM: 5, outputPerM: 25 },
  }));

  const candidates = closePricingIntervals(state, new Date("2026-06-08T00:00:00Z"));
  assert.equal(candidates[0]?.effectiveAt.toISOString(), "2026-06-07T03:00:00.000Z");
});

test("역순 commit과 rangeFrom 이하가 아닌 첫 snapshot 누락은 거부한다", () => {
  let state = createPricingIntervalState({
    rangeFrom: new Date("2026-06-01T00:00:00Z"),
    models: ["model-a"],
  });
  assert.throws(
    () => applyPricingSnapshot(state, snapshot("b", "2026-06-02T00:00:00Z", {
      "model-a": { inputPerM: 1, outputPerM: 2 },
    })),
    /baseline snapshot must not be after range start/,
  );

  state = applyPricingSnapshot(state, snapshot("a", "2026-05-31T00:00:00Z", {}));
  state = applyPricingSnapshot(state, snapshot("c", "2026-06-03T00:00:00Z", {}));
  assert.throws(
    () => applyPricingSnapshot(state, snapshot("b", "2026-06-02T00:00:00Z", {})),
    /pricing snapshots must be chronological/,
  );
});

test("닫는 시각이 시작보다 늦지 않은 후보는 만들지 않는다", () => {
  let state = createPricingIntervalState({
    rangeFrom: new Date("2026-06-01T00:00:00Z"),
    models: ["model-a"],
  });
  state = applyPricingSnapshot(state, snapshot("a", "2026-05-31T00:00:00Z", {
    "model-a": { inputPerM: 1, outputPerM: 2 },
  }));

  assert.deepEqual(closePricingIntervals(state, new Date("2026-06-01T00:00:00Z")), []);
});
