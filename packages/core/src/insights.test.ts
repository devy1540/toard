import assert from "node:assert/strict";
import { test } from "node:test";
import { buildUserInsightComparison } from "./insights";

const priced = { pricedEvents: 1, unpricedEvents: 0, legacyEvents: 0 };
const unpriced = { pricedEvents: 0, unpricedEvents: 1, legacyEvents: 0 };
const empty = { pricedEvents: 0, unpricedEvents: 0, legacyEvents: 0 };

test("기간 행을 같은 position의 현재·이전 trend로 정렬한다", () => {
  const result = buildUserInsightComparison(
    [
      { kind: "summary", period: "current", position: null, costUsd: 12, sessions: 6, totalTokens: 120, costCoverage: unpriced },
      { kind: "summary", period: "previous", position: null, costUsd: 10, sessions: 5, totalTokens: 100, costCoverage: priced },
      { kind: "trend", period: "previous", position: 0, costUsd: 4, sessions: 2, totalTokens: 40, costCoverage: priced },
      { kind: "trend", period: "current", position: 0, costUsd: 6, sessions: 3, totalTokens: 60, costCoverage: unpriced },
    ],
    [],
  );

  assert.deepEqual(result.current, { costUsd: 12, sessions: 6, totalTokens: 120, costCoverage: unpriced });
  assert.deepEqual(result.previous, { costUsd: 10, sessions: 5, totalTokens: 100, costCoverage: priced });
  assert.deepEqual(result.trend[0], {
    position: 0,
    current: { costUsd: 6, sessions: 3, totalTokens: 60, costCoverage: unpriced },
    previous: { costUsd: 4, sessions: 2, totalTokens: 40, costCoverage: priced },
  });
});

test("빈 모델·provider 키를 unknown으로 정규화한다", () => {
  const result = buildUserInsightComparison([], [
    { dimension: "model", key: "", period: "current", costUsd: 1, totalTokens: 10, costCoverage: unpriced },
    { dimension: "provider", key: "codex", period: "previous", costUsd: 2, totalTokens: 20, costCoverage: priced },
  ]);

  assert.equal(result.byModel[0]?.key, "(unknown)");
  assert.equal(result.byProvider[0]?.key, "codex");
});

test("누락된 기간을 0으로 채우고 trend와 구성을 결정적으로 정렬한다", () => {
  const result = buildUserInsightComparison(
    [
      { kind: "trend", period: "current", position: 2, costUsd: 2, sessions: 1, totalTokens: 20, costCoverage: priced },
      { kind: "trend", period: "previous", position: 1, costUsd: 3, sessions: 2, totalTokens: 30, costCoverage: priced },
    ],
    [
      { dimension: "model", key: "small", period: "current", costUsd: 1, totalTokens: 10, costCoverage: priced },
      { dimension: "model", key: "large", period: "current", costUsd: 4, totalTokens: 40, costCoverage: priced },
      { dimension: "model", key: "large", period: "previous", costUsd: 5, totalTokens: 50, costCoverage: priced },
    ],
  );

  assert.deepEqual(result.current, { costUsd: 0, sessions: 0, totalTokens: 0, costCoverage: empty });
  assert.deepEqual(result.previous, { costUsd: 0, sessions: 0, totalTokens: 0, costCoverage: empty });
  assert.deepEqual(result.trend, [
    {
      position: 1,
      current: { costUsd: 0, sessions: 0, totalTokens: 0, costCoverage: empty },
      previous: { costUsd: 3, sessions: 2, totalTokens: 30, costCoverage: priced },
    },
    {
      position: 2,
      current: { costUsd: 2, sessions: 1, totalTokens: 20, costCoverage: priced },
      previous: { costUsd: 0, sessions: 0, totalTokens: 0, costCoverage: empty },
    },
  ]);
  assert.deepEqual(result.byModel, [
    {
      key: "large",
      current: { costUsd: 4, totalTokens: 40, costCoverage: priced },
      previous: { costUsd: 5, totalTokens: 50, costCoverage: priced },
    },
    {
      key: "small",
      current: { costUsd: 1, totalTokens: 10, costCoverage: priced },
      previous: { costUsd: 0, totalTokens: 0, costCoverage: empty },
    },
  ]);
});
