import assert from "node:assert/strict";
import test from "node:test";
import {
  ORG_LEADERBOARD_METRIC,
  cacheSharePercent,
  findPeakTokenBucket,
  getOrgChartMetric,
  tokenLeaderboardMetrics,
  sharePercent,
  totalUsageTokens,
  usagePerActiveUser,
} from "./org-overview";

test("organization overview defaults its chart to tokens and keeps an explicit cost choice", () => {
  assert.equal(getOrgChartMetric(undefined), "tokens");
  assert.equal(getOrgChartMetric("tokens"), "tokens");
  assert.equal(getOrgChartMetric("cost"), "cost");
  assert.equal(getOrgChartMetric("unknown"), "tokens");
});

test("organization overview ranks users and calculates leaderboard bars by tokens", () => {
  assert.equal(ORG_LEADERBOARD_METRIC, "tokens");
  assert.deepEqual(
    tokenLeaderboardMetrics({ tokens: 400, totalTokens: 1_000, maxTokens: 800 }),
    { width: 50, share: 40 },
  );
  assert.deepEqual(
    tokenLeaderboardMetrics({ tokens: 0, totalTokens: 0, maxTokens: 0 }),
    { width: 0, share: null },
  );
});

test("organization overview totals every token category", () => {
  assert.equal(
    totalUsageTokens({ input: 120, output: 30, cacheRead: 800, cacheCreation: 50 }),
    1_000,
  );
});

test("organization overview exposes cache share and per-user token usage without dividing by zero", () => {
  assert.equal(cacheSharePercent(850, 1_000), 85);
  assert.equal(cacheSharePercent(0, 0), null);
  assert.equal(sharePercent(2, 3), 67);
  assert.equal(sharePercent(0, 0), null);
  assert.equal(usagePerActiveUser(1_000, 5), 200);
  assert.equal(usagePerActiveUser(1_000, 0), null);
});

test("organization overview finds the busiest token bucket and ignores empty usage", () => {
  const peak = findPeakTokenBucket([
    { day: "2026-07-07", input: 20, output: 10, cacheRead: 0, cacheCreation: 0 },
    { day: "2026-07-08", input: 15, output: 10, cacheRead: 50, cacheCreation: 5 },
  ]);

  assert.equal(peak?.day, "2026-07-08");
  assert.equal(findPeakTokenBucket([{ day: "2026-07-09", input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }]), null);
});
