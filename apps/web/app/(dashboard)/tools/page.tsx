import { getTranslations } from "next-intl/server";
import { DashboardFilters } from "@/components/dashboard/dashboard-filters";
import { ToolActivityList } from "@/components/dashboard/tool-activity-list";
import { Card, CardContent } from "@/components/ui/card";
import { fmtNum } from "@/lib/format";
import { getCurrentUserId } from "@/lib/current-user";
import { parseFilters, type DashboardSearchParams } from "@/lib/period";
import { getEnabledProviders } from "@/lib/providers";
import { getMyToolActivity } from "@/lib/tool-metadata";
import { getViewerTimezone } from "@/lib/viewer-time";

export const dynamic = "force-dynamic";

export default async function ToolsPage({ searchParams }: { searchParams: Promise<DashboardSearchParams> }) {
  const t = await getTranslations("dashboard.toolActivity");
  const userId = await getCurrentUserId();
  const sp = await searchParams;
  const period = parseFilters(sp, await getViewerTimezone());
  const providers = await getEnabledProviders();
  const data = userId ? await getMyToolActivity(userId, period) : { summary: { mcpCalls: 0, distinctSkills: 0, distinctPlugins: 0, failures: 0 }, rows: [] };
  return (
    <div className="space-y-6">
      <DashboardFilters providers={providers} timezone={period.timezone} title={t("detailTitle")} splitHeader />
      <div className="grid gap-4 sm:grid-cols-4">
        <Summary label={t("mcpLabel")} value={data.summary.mcpCalls} />
        <Summary label={t("skillLabel")} value={data.summary.distinctSkills} />
        <Summary label={t("pluginLabel")} value={data.summary.distinctPlugins} />
        <Summary label={t("failureLabel")} value={data.summary.failures} />
      </div>
      <ToolActivityList rows={data.rows} timezone={period.timezone} />
    </div>
  );
}

function Summary({ label, value }: { label: string; value: number }) {
  return <Card><CardContent className="pt-6"><div className="text-muted-foreground text-xs">{label}</div><div className="mt-1 text-2xl font-medium tabular-nums">{fmtNum(value)}</div></CardContent></Card>;
}
