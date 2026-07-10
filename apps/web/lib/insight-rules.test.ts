import assert from "node:assert/strict";
import { test } from "node:test";
import type { UserInsightComparison } from "@toard/core";
import { generateInsightCandidates } from "./insight-rules";

const priced = { pricedEvents: 1, unpricedEvents: 0, legacyEvents: 0 };
const unpriced = { pricedEvents: 0, unpricedEvents: 1, legacyEvents: 0 };

type ComparisonOverrides = Omit<Partial<UserInsightComparison>, "current" | "previous"> & {
  current?: Partial<UserInsightComparison["current"]>;
  previous?: Partial<UserInsightComparison["previous"]>;
};

const base = (overrides: ComparisonOverrides = {}): UserInsightComparison => {
  const current = { costUsd: 110, sessions: 11, totalTokens: 109, costCoverage: priced };
  const previous = { costUsd: 100, sessions: 10, totalTokens: 100, costCoverage: priced };
  return {
    trend: [],
    byModel: [],
    byProvider: [],
    ...overrides,
    current: { ...current, ...overrides.current },
    previous: { ...previous, ...overrides.previous },
  };
};

test("어느 비교 기간이든 unpriced면 비용·효율·비용 구성 후보를 만들지 않는다", () => {
  for (const [currentCoverage, previousCoverage] of [[unpriced, priced], [priced, unpriced]] as const) {
    const keys = generateInsightCandidates(
      base({
        current: { costUsd: 110, sessions: 11, totalTokens: 109, costCoverage: currentCoverage },
        previous: { costUsd: 100, sessions: 10, totalTokens: 100, costCoverage: previousCoverage },
        byModel: [{
          key: "model-a",
          current: { costUsd: 80, totalTokens: 80, costCoverage: currentCoverage },
          previous: { costUsd: 20, totalTokens: 20, costCoverage: previousCoverage },
        }],
      }),
      "cost",
    ).map((candidate) => candidate.key);

    assert.equal(keys.includes("cost.increase"), false);
    assert.equal(keys.includes("cost.decrease"), false);
    assert.equal(keys.includes("efficiency.increase"), false);
    assert.equal(keys.includes("efficiency.decrease"), false);
    assert.equal(keys.some((key) => key.startsWith("composition.")), false);
  }
});

test("10% 수치 변화는 포함하고 10% 미만은 제외한다", () => {
  const keys = generateInsightCandidates(base(), "cost").map((value) => value.key);

  assert.equal(keys.includes("cost.increase"), true);
  assert.equal(keys.includes("tokens.increase"), false);
});

test("토큰 모드는 비용과 세션당 비용 후보를 제외한다", () => {
  const keys = generateInsightCandidates(
    base({
      current: { costUsd: 200, sessions: 10, totalTokens: 120 },
      previous: { costUsd: 100, sessions: 10, totalTokens: 100 },
    }),
    "tokens",
  ).map((value) => value.key);

  assert.deepEqual(keys, ["tokens.increase"]);
});

test("비용 모드는 토큰 후보를 제외하고 비용 효율 후보를 유지한다", () => {
  const keys = generateInsightCandidates(
    base({
      current: { costUsd: 110, sessions: 10, totalTokens: 200 },
      previous: { costUsd: 100, sessions: 10, totalTokens: 100 },
    }),
    "cost",
  ).map((value) => value.key);

  assert.equal(keys.includes("cost.increase"), true);
  assert.equal(keys.includes("efficiency.increase"), true);
  assert.equal(keys.includes("tokens.increase"), false);
});

test("0.10에서 0.11로 증가한 정확한 10% 비용 변화를 포함한다", () => {
  const result = generateInsightCandidates(
    base({
      current: { costUsd: 0.11, sessions: 10, totalTokens: 100 },
      previous: { costUsd: 0.1, sessions: 10, totalTokens: 100 },
    }),
    "cost",
  );

  assert.equal(result.some((value) => value.key === "cost.increase"), true);
});

test("5%p 구성 변화는 포함한다", () => {
  const result = generateInsightCandidates(
    base({
      byModel: [
        {
          key: "claude",
          current: { costUsd: 66, totalTokens: 66, costCoverage: priced },
          previous: { costUsd: 50, totalTokens: 50, costCoverage: priced },
        },
      ],
    }),
    "cost",
  );

  assert.equal(result.some((value) => value.key === "composition.increase"), true);
});

test("전체 20에서 2에서 3으로 증가한 정확한 5%p 구성 변화를 포함한다", () => {
  const result = generateInsightCandidates(
    base({
      current: { costUsd: 20, sessions: 10, totalTokens: 20 },
      previous: { costUsd: 20, sessions: 10, totalTokens: 20 },
      byModel: [
        {
          key: "claude",
          current: { costUsd: 3, totalTokens: 3, costCoverage: priced },
          previous: { costUsd: 2, totalTokens: 2, costCoverage: priced },
        },
      ],
    }),
    "cost",
  );

  assert.equal(result.some((value) => value.key === "composition.increase"), true);
});

test("양쪽 세션이 5개 미만이면 모든 비율 기반 문장을 만들지 않는다", () => {
  const result = generateInsightCandidates(
    base({
      current: { costUsd: 100, sessions: 4, totalTokens: 1_000 },
      previous: { costUsd: 10, sessions: 4, totalTokens: 100 },
      byModel: [
        {
          key: "claude",
          current: { costUsd: 90, totalTokens: 900, costCoverage: priced },
          previous: { costUsd: 1, totalTokens: 10, costCoverage: priced },
        },
      ],
    }),
    "cost",
  );

  assert.deepEqual(result, []);
});

test("세션이 5개 미만이어도 새 구성 항목이라는 절대 변화는 유지한다", () => {
  const result = generateInsightCandidates(
    base({
      current: { costUsd: 10, sessions: 4, totalTokens: 100 },
      previous: { costUsd: 10, sessions: 4, totalTokens: 100 },
      byModel: [
        {
          key: "new-model",
          current: { costUsd: 1, totalTokens: 10, costCoverage: priced },
          previous: { costUsd: 0, totalTokens: 0, costCoverage: priced },
        },
      ],
    }),
    "cost",
  );

  assert.deepEqual(
    result.map((candidate) => candidate.key),
    ["composition.new"],
  );
});

test("이전 세션이 0이고 현재 세션이 있으면 새 사용 후보 하나를 만든다", () => {
  const result = generateInsightCandidates(
    base({
      current: { costUsd: 20, sessions: 6, totalTokens: 200 },
      previous: { costUsd: 0, sessions: 0, totalTokens: 0 },
      byProvider: [
        {
          key: "codex",
          current: { costUsd: 20, totalTokens: 200, costCoverage: priced },
          previous: { costUsd: 0, totalTokens: 0, costCoverage: priced },
        },
      ],
    }),
    "cost",
  );

  assert.deepEqual(
    result.map((candidate) => candidate.key),
    ["usage.new"],
  );
});

test("현재와 이전 세션이 모두 0이면 새 사용 후보를 만들지 않는다", () => {
  const result = generateInsightCandidates(
    base({
      current: { costUsd: 0, sessions: 0, totalTokens: 0 },
      previous: { costUsd: 0, sessions: 0, totalTokens: 0 },
    }),
    "cost",
  );

  assert.deepEqual(result, []);
});

test("현재 비용과 토큰이 0이어도 세션만 생기면 새 사용 후보를 만든다", () => {
  const result = generateInsightCandidates(
    base({
      current: { costUsd: 0, sessions: 1, totalTokens: 0 },
      previous: { costUsd: 0, sessions: 0, totalTokens: 0 },
    }),
    "tokens",
  );

  assert.deepEqual(
    result.map((candidate) => candidate.key),
    ["usage.new"],
  );
});

test("후보는 점수순 최대 3개다", () => {
  const result = generateInsightCandidates(
    base({
      current: { costUsd: 200, sessions: 20, totalTokens: 200 },
      previous: { costUsd: 100, sessions: 10, totalTokens: 100 },
      byProvider: [
        {
          key: "codex",
          current: { costUsd: 180, totalTokens: 180, costCoverage: priced },
          previous: { costUsd: 20, totalTokens: 20, costCoverage: priced },
        },
      ],
    }),
    "cost",
  );

  assert.equal(result.length, 3);
  assert.deepEqual([...result].sort((a, b) => b.score - a.score), result);
});
