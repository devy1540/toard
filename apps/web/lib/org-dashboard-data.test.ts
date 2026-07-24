import assert from "node:assert/strict";
import test from "node:test";
import type {
  OrganizationDashboardData,
  OrganizationDashboardQuery,
  OrganizationUtilizationResult,
  PeriodQuery,
  ToolActivitySummary,
} from "@toard/core";
import {
  loadOrganizationDashboardData,
  type OrganizationDashboardDependencies,
} from "./org-dashboard-data";

const dashboardQuery: OrganizationDashboardQuery = {
  current: {
    from: new Date("2026-07-01T00:00:00.000Z"),
    to: new Date("2026-07-08T00:00:00.000Z"),
    timezone: "UTC",
    bucket: "day",
  },
  previous: {
    from: new Date("2026-06-24T00:00:00.000Z"),
    to: new Date("2026-07-01T00:00:00.000Z"),
  },
  includeTeamLeaderboard: true,
  leaderboardOrder: "tokens",
};
const toolPeriod: PeriodQuery = dashboardQuery.current;
const dashboard = {
  overview: { totalCostUsd: 42 },
  previousOverview: { totalCostUsd: 24 },
  daily: [{ day: "2026-07-01" }],
  topUsers: [{ label: "Ada" }],
  topTeams: [{ label: "Core" }],
  providerBreakdown: [{ providerKey: "codex" }],
} as OrganizationDashboardData;
const toolActivity: ToolActivitySummary = {
  mcpCalls: 12,
  distinctSkills: 3,
  distinctPlugins: 2,
  failures: 1,
  activeUsers: 4,
  activeDevices: 5,
};
const utilization: OrganizationUtilizationResult = {
  state: "suppressed",
  methodologyVersion: "utilization-v2",
  reason: "suppressed_small_cohort",
};

function dependencies(overrides: Partial<OrganizationDashboardDependencies> = {}): OrganizationDashboardDependencies {
  return {
    getDashboard: async () => dashboard,
    getToolActivity: async () => toolActivity,
    getUtilization: async () => utilization,
    warn: () => undefined,
    ...overrides,
  };
}

function load(deps: OrganizationDashboardDependencies) {
  return loadOrganizationDashboardData({ dashboard: dashboardQuery, toolPeriod }, deps);
}

test("핵심 dashboard 거부 이유는 객체 동일성으로 전파한다", async () => {
  const failure = { private: "core failure" };

  await assert.rejects(load(dependencies({ getDashboard: async () => Promise.reject(failure) })), (error) => error === failure);
});

test("도구 활동 실패는 해당 섹션만 unavailable로 바꾸고 안전한 경고 하나만 남긴다", async () => {
  const warnings: unknown[] = [];
  const privateFailure = new Error("do not log this private detail");

  const result = await load(dependencies({
    getToolActivity: async () => Promise.reject(privateFailure),
    warn: (record) => warnings.push(record),
  }));

  assert.strictEqual(result.dashboard, dashboard);
  assert.deepEqual(result.toolActivity, { state: "unavailable" });
  assert.deepEqual(result.utilization, { state: "available", value: utilization });
  assert.deepEqual(warnings, [{ event: "org_dashboard_optional_section_unavailable", section: "tool_activity" }]);
  assert.equal(JSON.stringify(warnings).includes(privateFailure.message), false);
});

test("활용 지수 실패는 해당 섹션만 unavailable로 바꾸고 핵심과 도구 결과를 보존한다", async () => {
  const warnings: unknown[] = [];

  const result = await load(dependencies({
    getUtilization: async () => Promise.reject(new Error("private utilization failure")),
    warn: (record) => warnings.push(record),
  }));

  assert.strictEqual(result.dashboard, dashboard);
  assert.deepEqual(result.toolActivity, { state: "available", value: toolActivity });
  assert.deepEqual(result.utilization, { state: "unavailable" });
  assert.deepEqual(warnings, [{ event: "org_dashboard_optional_section_unavailable", section: "utilization" }]);
});

test("두 선택 섹션이 모두 실패해도 핵심 dashboard는 반환한다", async () => {
  const warnings: unknown[] = [];

  const result = await load(dependencies({
    getToolActivity: async () => Promise.reject(new Error("tool private failure")),
    getUtilization: async () => Promise.reject(new Error("utilization private failure")),
    warn: (record) => warnings.push(record),
  }));

  assert.strictEqual(result.dashboard, dashboard);
  assert.deepEqual(result.toolActivity, { state: "unavailable" });
  assert.deepEqual(result.utilization, { state: "unavailable" });
  assert.deepEqual(warnings, [
    { event: "org_dashboard_optional_section_unavailable", section: "tool_activity" },
    { event: "org_dashboard_optional_section_unavailable", section: "utilization" },
  ]);
});

test("세 dashboard 읽기는 서로 기다리지 않고 모두 시작한다", async () => {
  const started: string[] = [];
  let resolveDashboard!: (value: OrganizationDashboardData) => void;
  let resolveToolActivity!: (value: ToolActivitySummary) => void;
  let resolveUtilization!: (value: OrganizationUtilizationResult) => void;
  const result = load(dependencies({
    getDashboard: () => new Promise((resolve) => {
      started.push("dashboard");
      resolveDashboard = resolve;
    }),
    getToolActivity: () => new Promise((resolve) => {
      started.push("tool_activity");
      resolveToolActivity = resolve;
    }),
    getUtilization: () => new Promise((resolve) => {
      started.push("utilization");
      resolveUtilization = resolve;
    }),
  }));

  assert.deepEqual(started, ["dashboard", "tool_activity", "utilization"]);
  resolveDashboard(dashboard);
  resolveToolActivity(toolActivity);
  resolveUtilization(utilization);
  await result;
});

test("성공한 객체는 값 변경 없이 available 값으로 반환한다", async () => {
  const result = await load(dependencies());

  assert.strictEqual(result.dashboard, dashboard);
  assert.equal(result.toolActivity.state, "available");
  assert.equal(result.utilization.state, "available");
  if (result.toolActivity.state !== "available" || result.utilization.state !== "available") {
    assert.fail("성공한 선택 섹션은 available이어야 한다");
  }
  assert.strictEqual(result.toolActivity.value, toolActivity);
  assert.strictEqual(result.utilization.value, utilization);
});
