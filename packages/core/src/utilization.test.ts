import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateOrganizationUtilization,
  buildUtilizationPeriods,
  calculatePersonalUtilization,
  getUtilizationProviderCapability,
  normalizeUtilizationDimension,
  type PersonalUtilizationResult,
  type UtilizationDailyFeature,
} from "./utilization";

function row(day: string, values: Partial<UtilizationDailyFeature> = {}): UtilizationDailyFeature {
  return {
    userId: "user-1",
    day,
    sessions: 1,
    inputTokens: 100,
    cacheReadTokens: 100,
    cacheCreationTokens: 0,
    cacheSignalEvents: 1,
    cacheUnsupportedEvents: 0,
    toolSuccesses: 4,
    toolFailures: 1,
    toolUnknown: 0,
    repeatedToolFailures: 1,
    sessionToolKnownCalls: 5,
    toolActiveSessions: 1,
    distinctTools: 2,
    ...values,
  };
}

const periods = {
  current: { from: new Date("2026-07-08T00:00:00Z"), to: new Date("2026-07-15T00:00:00Z") },
  baseline: { from: new Date("2026-06-10T00:00:00Z"), to: new Date("2026-07-08T00:00:00Z") },
  timezone: "UTC",
};

function validRows(): UtilizationDailyFeature[] {
  const baseline = Array.from({ length: 7 }, (_, index) =>
    row(`2026-06-${String(10 + index).padStart(2, "0")}`),
  );
  const current = [
    row("2026-07-08", {
      sessions: 2,
      cacheReadTokens: 200,
      toolSuccesses: 9,
      toolFailures: 1,
      repeatedToolFailures: 0,
      sessionToolKnownCalls: 10,
    }),
    row("2026-07-09", {
      sessions: 2,
      cacheReadTokens: 200,
      toolSuccesses: 9,
      toolFailures: 1,
      repeatedToolFailures: 0,
      sessionToolKnownCalls: 10,
    }),
    row("2026-07-10", {
      sessions: 1,
      cacheReadTokens: 200,
      toolSuccesses: 9,
      toolFailures: 1,
      repeatedToolFailures: 0,
      sessionToolKnownCalls: 10,
    }),
  ];
  return [...baseline, ...current];
}

test("완료된 7일과 직전 28일을 조직 타임존으로 만든다", () => {
  const result = buildUtilizationPeriods(new Date("2026-07-15T05:00:00Z"), "Asia/Seoul");

  assert.equal(result.current.from.toISOString(), "2026-07-07T15:00:00.000Z");
  assert.equal(result.current.to.toISOString(), "2026-07-14T15:00:00.000Z");
  assert.equal(result.baseline.from.toISOString(), "2026-06-09T15:00:00.000Z");
  assert.equal(result.baseline.to.toISOString(), "2026-07-07T15:00:00.000Z");
});

test("기준선 중앙값은 50점이고 복구 부담 방향은 반대다", () => {
  assert.equal(normalizeUtilizationDimension(0.8, [0.8, 0.8, 0.8], 1), 50);
  assert.ok(normalizeUtilizationDimension(0.1, [0.2, 0.2, 0.2], -1) > 50);
  assert.equal(normalizeUtilizationDimension(1, [0, 0, 0], 1), 100);
});

test("현재 수집 provider의 cache capability만 명시적으로 지원한다", () => {
  for (const provider of ["claude_code", "codex", "gemini", "qwen"]) {
    assert.equal(getUtilizationProviderCapability(provider).reportsCacheRead, true);
  }
  assert.equal(getUtilizationProviderCapability("future-provider").reportsCacheRead, false);
});

test("세 축을 본인 기준선으로 계산하고 중립 사용량은 가중치에 넣지 않는다", () => {
  const result = calculatePersonalUtilization(validRows(), periods);

  assert.equal(result.methodologyVersion, "utilization-v1");
  assert.equal(result.confidence, "medium");
  assert.equal(result.dimensions.length, 3);
  assert.equal(result.dimensions.filter((dimension) => dimension.score != null).length, 3);
  const scores = result.dimensions.map((dimension) => dimension.score).filter((score): score is number => score != null);
  assert.equal(result.score, Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length));
  assert.deepEqual(result.reasons, []);
  assert.equal(result.observations.activeDays, 3);
  assert.equal(result.observations.sessions, 5);
});

test("현재 세션이 부족하면 0점 대신 계산 불가 이유를 반환한다", () => {
  const rows = validRows().map((item) =>
    item.day >= "2026-07-08" ? { ...item, sessions: 1 } : item,
  );
  const result = calculatePersonalUtilization(rows, periods);

  assert.equal(result.score, null);
  assert.equal(result.confidence, "low");
  assert.ok(result.reasons.includes("insufficient_current_sessions"));
});

test("unknown 결과가 많으면 도구 축을 성공으로 간주하지 않는다", () => {
  const rows = validRows().map((item) =>
    item.day >= "2026-07-08" ? { ...item, toolUnknown: 30 } : item,
  );
  const result = calculatePersonalUtilization(rows, periods);
  const execution = result.dimensions.find((dimension) => dimension.key === "execution_stability");

  assert.equal(execution?.score, null);
  assert.equal(execution?.reason, "low_tool_outcome_coverage");
});

function scored(score: number, dimensionScore = score): PersonalUtilizationResult {
  const result = calculatePersonalUtilization(validRows(), periods);
  return {
    ...result,
    score,
    confidence: "medium",
    dimensions: result.dimensions.map((dimension) => ({ ...dimension, score: dimensionScore })),
  };
}

test("조직 활성 사용자가 4명이면 모든 통계를 억제한다", () => {
  const result = aggregateOrganizationUtilization(
    [scored(40), scored(45), scored(55), scored(60)],
    4,
  );

  assert.deepEqual(result, {
    state: "suppressed",
    methodologyVersion: "utilization-v1",
    reason: "suppressed_small_cohort",
  });
});

test("조직 활성 사용자와 유효 결과가 5명이면 개인 식별자 없는 익명 통계만 반환한다", () => {
  const result = aggregateOrganizationUtilization(
    [scored(40), scored(45), scored(50), scored(55), scored(60)],
    5,
  );

  assert.equal(result.state, "available");
  if (result.state !== "available") return;
  assert.equal(result.median, 50);
  assert.deepEqual(result.range, { p25: 45, p75: 55 });
  assert.deepEqual(result.relativeDistribution, { above: 1, usual: 3, below: 1 });
  const json = JSON.stringify(result);
  for (const forbidden of ["userId", "email", "name", "individualScores"]) {
    assert.equal(json.includes(forbidden), false);
  }
});

test("조직 활성 사용자가 5명이어도 유효 결과가 4명이면 숫자를 공개하지 않는다", () => {
  const ineligible = { ...scored(50), score: null, confidence: "low" as const };
  const result = aggregateOrganizationUtilization(
    [scored(40), scored(45), scored(55), scored(60), ineligible],
    5,
  );

  assert.deepEqual(result, {
    state: "insufficient_data",
    methodologyVersion: "utilization-v1",
    reason: "insufficient_eligible_users",
  });
});
