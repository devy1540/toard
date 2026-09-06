import { unstable_cache } from "next/cache";
import type { CostReportScope } from "@toard/core";
import { readUtilizationCacheGeneration } from "./utilization-cache-generation";
import { reportPeriod, type ReportPeriod } from "./report-period";
import { buildWeeklyReport, reportGenerationKey, WEEKLY_REPORT_VERSION } from "./weekly-report";
import { COST_DRIVER_VERSION } from "./cost-drivers";
import { getPool } from "./db";

const cached = unstable_cache(async (scopeJson: string, week: string, timezone: string, _generation: string, _installation: string, _backend: string) => {
  const scope = JSON.parse(scopeJson) as CostReportScope;
  return buildWeeklyReport(scope, reportPeriod(week, timezone));
}, [WEEKLY_REPORT_VERSION, COST_DRIVER_VERSION], { revalidate: 600, tags: ["weekly-reports"] });

export async function getWeeklyReport(scope: CostReportScope, period: ReportPeriod) {
  const [state, identity] = await Promise.all([
    readUtilizationCacheGeneration(scope.kind === "user" ? scope.userId : null),
    getPool().query<{ installation_id: string }>("SELECT installation_id FROM installation_identity WHERE singleton=TRUE"),
  ]);
  const installation = identity.rows[0]?.installation_id;
  if (!installation) throw new Error("report_installation_identity_missing");
  const key = reportGenerationKey(scope, state);
  // Busy collection must not make weekly reports unavailable. The underlying
  // reader is a single-statement snapshot; only caching is bypassed during writes.
  const backend = process.env.STORAGE_BACKEND === "clickhouse" ? "clickhouse" : "postgres";
  return key === null ? buildWeeklyReport(scope, period) : cached(JSON.stringify(scope), period.week, period.timezone, key, installation, backend);
}
