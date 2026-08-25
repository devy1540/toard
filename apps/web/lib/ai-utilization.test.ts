import assert from "node:assert/strict";
import test from "node:test";
import {
  buildUtilizationPeriods,
  type UtilizationToolDay,
  type UtilizationUsageDay,
} from "@toard/core";
import {
  calculateOrganizationUtilizationFromRows,
  buildUtilizationHistoryPeriods,
  mergeUtilizationDays,
  shouldBypassOrganizationUtilizationCache,
  shouldBypassPersonalUtilizationCache,
  utilizationCacheArgs,
} from "./ai-utilization";
import type { UtilizationCacheGenerationState } from "./utilization-cache-generation";

test("활용 지수 서비스는 사용량과 도구 일별 행의 합집합을 0 기본값으로 병합한다", () => {
  const usage: UtilizationUsageDay[] = [
    {
      userId: "user-1",
      day: "2026-07-10",
      sessions: 2,
      inputTokens: 100,
      cacheReadTokens: 80,
      cacheCreationTokens: 20,
      cacheSignalEvents: 3,
      cacheUnsupportedEvents: 0,
    },
    {
      userId: "user-1",
      day: "2026-07-09",
      sessions: 1,
      inputTokens: 10,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      cacheSignalEvents: 1,
      cacheUnsupportedEvents: 0,
    },
  ];
  const tools: UtilizationToolDay[] = [
    {
      userId: "user-1",
      day: "2026-07-10",
      successes: 7,
      failures: 3,
      unknown: 2,
      repeatedFailures: 1,
      recoveryAttempts: 2,
      successfulRecoveries: 1,
      sessionToolKnownCalls: 10,
      toolActiveSessions: 2,
      distinctTools: 3,
    },
    {
      userId: "user-1",
      day: "2026-07-08",
      successes: 1,
      failures: 0,
      unknown: 0,
      repeatedFailures: 0,
      recoveryAttempts: 0,
      successfulRecoveries: 0,
      sessionToolKnownCalls: 1,
      toolActiveSessions: 1,
      distinctTools: 1,
    },
  ];

  const merged = mergeUtilizationDays(usage, tools);

  assert.deepEqual(merged.find((row) => row.day === "2026-07-10"), {
    userId: "user-1",
    day: "2026-07-10",
    sessions: 2,
    inputTokens: 100,
    cacheReadTokens: 80,
    cacheCreationTokens: 20,
    cacheSignalEvents: 3,
    cacheUnsupportedEvents: 0,
    toolSuccesses: 7,
    toolFailures: 3,
    toolUnknown: 2,
    repeatedToolFailures: 1,
    recoveryAttempts: 2,
    successfulRecoveries: 1,
    sessionToolKnownCalls: 10,
    toolActiveSessions: 2,
    distinctTools: 3,
  });
  assert.equal(merged.find((row) => row.day === "2026-07-09")?.toolSuccesses, 0);
  assert.equal(merged.find((row) => row.day === "2026-07-08")?.sessions, 0);
});

function organizationRows(userCount: number) {
  const usage: UtilizationUsageDay[] = [];
  const tools: UtilizationToolDay[] = [];
  for (let user = 1; user <= userCount; user++) {
    for (let offset = 0; offset < 35; offset++) {
      const day = new Date(Date.UTC(2026, 5, 10 + offset)).toISOString().slice(0, 10);
      const current = offset >= 28;
      usage.push({
        userId: `user-${user}`,
        day,
        sessions: 1,
        inputTokens: 100,
        cacheReadTokens: current ? 70 : 50,
        cacheCreationTokens: 0,
        cacheSignalEvents: 1,
        cacheUnsupportedEvents: 0,
      });
      tools.push({
        userId: `user-${user}`,
        day,
        successes: current ? 10 : 9,
        failures: current ? 0 : 1,
        unknown: 0,
        repeatedFailures: current ? 0 : 1,
        recoveryAttempts: current ? 0 : 1,
        successfulRecoveries: current ? 0 : 0,
        sessionToolKnownCalls: 10,
        toolActiveSessions: 1,
        distinctTools: 3,
      });
    }
  }
  return { usage, tools };
}

test("활용 지수 조직 집계는 4명을 억제하고 5명부터 개인 식별자 없이 공개한다", () => {
  const periods = buildUtilizationPeriods(new Date("2026-07-15T12:00:00Z"), "UTC");
  const four = organizationRows(4);
  const five = organizationRows(5);

  const fourResult = calculateOrganizationUtilizationFromRows(four.usage, four.tools, periods);
  const fiveResult = calculateOrganizationUtilizationFromRows(five.usage, five.tools, periods);

  assert.equal(fourResult.state, "suppressed");
  assert.equal(fiveResult.state, "available");
  assert.deepEqual(fiveResult.currentPeriod, periods.current);
  assert.deepEqual(fiveResult.baselinePeriod, periods.baseline);
  assert.equal(fiveResult.timezone, "UTC");
  assert.equal(fiveResult.methodologyVersion, "utilization-v2");
  for (const forbidden of ["userId", "email", "name", "individualScores"]) {
    assert.equal(JSON.stringify(fiveResult).includes(forbidden), false);
  }
});

test("활용 지수 개인 캐시 키는 사용자·기간·시간대·방법론 버전을 포함한다", () => {
  const periods = buildUtilizationPeriods(new Date("2026-07-15T12:00:00Z"), "Asia/Seoul");
  const generation: UtilizationCacheGenerationState = {
    personalUserGeneration: 7,
    personalUserPending: 0,
    personalAllGeneration: 3,
    personalAllPending: 0,
    organizationGeneration: 11,
    organizationPending: 0,
  };
  const args = utilizationCacheArgs("user-1", periods, generation);

  assert.equal(args[0], "user-1");
  assert.ok(args.includes("Asia/Seoul"));
  assert.ok(args.includes("utilization-v2"));
  assert.ok(args.includes(periods.baseline.from.toISOString()));
  assert.ok(args.includes(periods.current.to.toISOString()));
  assert.equal(args.at(-2), 7);
  assert.equal(args.at(-1), 3);
});

test("공유 generation pending 동안 personal과 organization cache를 우회한다", () => {
  const state: UtilizationCacheGenerationState = {
    personalUserGeneration: 1,
    personalUserPending: 0,
    personalAllGeneration: 1,
    personalAllPending: 0,
    organizationGeneration: 1,
    organizationPending: 0,
  };

  assert.equal(shouldBypassPersonalUtilizationCache(state), false);
  assert.equal(shouldBypassOrganizationUtilizationCache(state), false);
  assert.equal(shouldBypassPersonalUtilizationCache({ ...state, personalUserPending: 1 }), true);
  assert.equal(shouldBypassPersonalUtilizationCache({ ...state, personalAllPending: 1 }), true);
  assert.equal(shouldBypassOrganizationUtilizationCache({ ...state, organizationPending: 1 }), true);
});

test("활용 지수 과거 추세는 동일한 7일/28일 창을 12주 생성한다", () => {
  const periods = buildUtilizationPeriods(new Date("2026-07-15T12:00:00Z"), "Asia/Seoul");
  const history = buildUtilizationHistoryPeriods(periods);

  assert.equal(history.length, 12);
  assert.equal(history.at(-1)?.current.to.toISOString(), periods.current.to.toISOString());
  assert.equal(
    history[1]!.current.to.getTime() - history[0]!.current.to.getTime(),
    7 * 24 * 60 * 60 * 1000,
  );
  assert.equal(
    history[0]!.current.from.getTime() - history[0]!.baseline.from.getTime(),
    28 * 24 * 60 * 60 * 1000,
  );
});
