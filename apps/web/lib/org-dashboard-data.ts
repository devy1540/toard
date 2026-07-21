import type {
  OrganizationDashboardData,
  OrganizationDashboardQuery,
  OrganizationUtilizationResult,
  PeriodQuery,
  ToolActivitySummary,
} from "@toard/core";
import { getCachedOrganizationUtilization } from "./ai-utilization";
import { getStorage } from "./storage";
import { getOrgToolSummary } from "./tool-metadata";

export type OptionalDashboardSection<T> =
  | { state: "available"; value: T }
  | { state: "unavailable" };

export type OrganizationDashboardWarning = {
  event: "org_dashboard_optional_section_unavailable";
  section: "tool_activity" | "utilization";
};

export interface OrganizationDashboardDependencies {
  getDashboard(query: OrganizationDashboardQuery): Promise<OrganizationDashboardData>;
  getToolActivity(query: PeriodQuery): Promise<ToolActivitySummary>;
  getUtilization(): Promise<OrganizationUtilizationResult>;
  warn(record: OrganizationDashboardWarning): void;
}

const defaultDependencies: OrganizationDashboardDependencies = {
  getDashboard: (query) => getStorage().getOrganizationDashboard(query),
  getToolActivity: getOrgToolSummary,
  getUtilization: getCachedOrganizationUtilization,
  warn: (record) => console.warn(record),
};

function unavailable<T>(
  deps: OrganizationDashboardDependencies,
  section: OrganizationDashboardWarning["section"],
): OptionalDashboardSection<T> {
  try {
    deps.warn({ event: "org_dashboard_optional_section_unavailable", section });
  } catch {
    // 선택 섹션의 관찰 실패가 dashboard 렌더를 막으면 안 된다.
  }
  return { state: "unavailable" };
}

export async function loadOrganizationDashboardData(
  input: {
    dashboard: OrganizationDashboardQuery;
    toolPeriod: PeriodQuery;
  },
  deps: OrganizationDashboardDependencies = defaultDependencies,
): Promise<{
  dashboard: OrganizationDashboardData;
  toolActivity: OptionalDashboardSection<ToolActivitySummary>;
  utilization: OptionalDashboardSection<OrganizationUtilizationResult>;
}> {
  const [dashboard, toolActivity, utilization] = await Promise.allSettled([
    deps.getDashboard(input.dashboard),
    deps.getToolActivity(input.toolPeriod),
    deps.getUtilization(),
  ]);

  if (dashboard.status === "rejected") throw dashboard.reason;

  return {
    dashboard: dashboard.value,
    toolActivity: toolActivity.status === "fulfilled"
      ? { state: "available", value: toolActivity.value }
      : unavailable<ToolActivitySummary>(deps, "tool_activity"),
    utilization: utilization.status === "fulfilled"
      ? { state: "available", value: utilization.value }
      : unavailable<OrganizationUtilizationResult>(deps, "utilization"),
  };
}
