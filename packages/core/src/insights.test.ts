import assert from "node:assert/strict";
import { test } from "node:test";
import { buildUserInsightComparison } from "./insights";

test("기간 행을 같은 position의 현재·이전 trend로 정렬한다", () => {
  const result = buildUserInsightComparison(
    [
      { kind: "summary", period: "current", position: null, costUsd: 12, sessions: 6, totalTokens: 120 },
      { kind: "summary", period: "previous", position: null, costUsd: 10, sessions: 5, totalTokens: 100 },
      { kind: "trend", period: "previous", position: 0, costUsd: 4, sessions: 2, totalTokens: 40 },
      { kind: "trend", period: "current", position: 0, costUsd: 6, sessions: 3, totalTokens: 60 },
    ],
    [],
  );

  assert.deepEqual(result.current, { costUsd: 12, sessions: 6, totalTokens: 120 });
  assert.deepEqual(result.previous, { costUsd: 10, sessions: 5, totalTokens: 100 });
  assert.deepEqual(result.trend[0], {
    position: 0,
    current: { costUsd: 6, sessions: 3, totalTokens: 60 },
    previous: { costUsd: 4, sessions: 2, totalTokens: 40 },
  });
});

test("빈 모델·provider 키를 unknown으로 정규화한다", () => {
  const result = buildUserInsightComparison([], [
    { dimension: "model", key: "", period: "current", costUsd: 1, totalTokens: 10 },
    { dimension: "provider", key: "codex", period: "previous", costUsd: 2, totalTokens: 20 },
  ]);

  assert.equal(result.byModel[0]?.key, "(unknown)");
  assert.equal(result.byProvider[0]?.key, "codex");
});

test("누락된 기간을 0으로 채우고 trend와 구성을 결정적으로 정렬한다", () => {
  const result = buildUserInsightComparison(
    [
      { kind: "trend", period: "current", position: 2, costUsd: 2, sessions: 1, totalTokens: 20 },
      { kind: "trend", period: "previous", position: 1, costUsd: 3, sessions: 2, totalTokens: 30 },
    ],
    [
      { dimension: "model", key: "small", period: "current", costUsd: 1, totalTokens: 10 },
      { dimension: "model", key: "large", period: "current", costUsd: 4, totalTokens: 40 },
      { dimension: "model", key: "large", period: "previous", costUsd: 5, totalTokens: 50 },
    ],
  );

  assert.deepEqual(result.current, { costUsd: 0, sessions: 0, totalTokens: 0 });
  assert.deepEqual(result.previous, { costUsd: 0, sessions: 0, totalTokens: 0 });
  assert.deepEqual(result.trend, [
    {
      position: 1,
      current: { costUsd: 0, sessions: 0, totalTokens: 0 },
      previous: { costUsd: 3, sessions: 2, totalTokens: 30 },
    },
    {
      position: 2,
      current: { costUsd: 2, sessions: 1, totalTokens: 20 },
      previous: { costUsd: 0, sessions: 0, totalTokens: 0 },
    },
  ]);
  assert.deepEqual(result.byModel, [
    {
      key: "large",
      current: { costUsd: 4, totalTokens: 40 },
      previous: { costUsd: 5, totalTokens: 50 },
    },
    {
      key: "small",
      current: { costUsd: 1, totalTokens: 10 },
      previous: { costUsd: 0, totalTokens: 0 },
    },
  ]);
});
