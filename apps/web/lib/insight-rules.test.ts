import assert from "node:assert/strict";
import { test } from "node:test";
import type { UserInsightComparison } from "@toard/core";
import { generateInsightCandidates } from "./insight-rules";

const base = (overrides: Partial<UserInsightComparison> = {}): UserInsightComparison => ({
  current: { costUsd: 110, sessions: 11, totalTokens: 109 },
  previous: { costUsd: 100, sessions: 10, totalTokens: 100 },
  trend: [],
  byModel: [],
  byProvider: [],
  ...overrides,
});

test("10% 수치 변화는 포함하고 10% 미만은 제외한다", () => {
  const keys = generateInsightCandidates(base(), "cost").map((value) => value.key);

  assert.equal(keys.includes("cost.increase"), true);
  assert.equal(keys.includes("tokens.increase"), false);
});

test("5%p 구성 변화는 포함한다", () => {
  const result = generateInsightCandidates(
    base({
      byModel: [
        {
          key: "claude",
          current: { costUsd: 66, totalTokens: 66 },
          previous: { costUsd: 50, totalTokens: 50 },
        },
      ],
    }),
    "cost",
  );

  assert.equal(result.some((value) => value.key === "composition.increase"), true);
});

test("세션이 5개 미만이면 비율 기반 문장을 만들지 않는다", () => {
  const result = generateInsightCandidates(
    base({
      current: { costUsd: 20, sessions: 4, totalTokens: 20 },
      previous: { costUsd: 10, sessions: 4, totalTokens: 10 },
    }),
    "cost",
  );

  assert.equal(
    result.some((value) => value.key === "efficiency.increase" || value.key === "efficiency.decrease"),
    false,
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
          current: { costUsd: 180, totalTokens: 180 },
          previous: { costUsd: 20, totalTokens: 20 },
        },
      ],
    }),
    "cost",
  );

  assert.equal(result.length, 3);
  assert.deepEqual([...result].sort((a, b) => b.score - a.score), result);
});
