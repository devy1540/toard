import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { Activity, ArrowUpDown, DollarSign, Inbox, Users } from "lucide-react";
import { LeaderboardBarChart } from "@/components/charts/leaderboard-bar-chart";
import { UsageAreaChart } from "@/components/charts/usage-area-chart";
import { AutoRefresh } from "@/components/dashboard/auto-refresh";
import { DashboardFilters } from "@/components/dashboard/dashboard-filters";
import { LinkTabs } from "@/components/dashboard/link-tabs";
import { MetricToggle, type ChartMetric } from "@/components/dashboard/metric-toggle";
import { PageHeader } from "@/components/dashboard/page-header";
import { PricingNotice } from "@/components/dashboard/pricing-notice";
import { StatCard } from "@/components/dashboard/stat-card";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtCompact, fmtNum, fmtUsd } from "@/lib/format";
import { fillSeriesGaps, parseFilters, type DashboardSearchParams } from "@/lib/period";
import { getEnabledProviders } from "@/lib/providers";
import { getStorage } from "@/lib/storage";

export const dynamic = "force-dynamic";

type OrgSearchParams = DashboardSearchParams & { tab?: string; scope?: string };

/** 필터(period·provider·커스텀 범위)를 유지한 채 tab/scope 만 바꾼 href 생성 */
function hrefWith(sp: OrgSearchParams, next: { tab?: string; scope?: string }): string {
  const q = new URLSearchParams();
  if (sp.period) q.set("period", sp.period);
  if (sp.provider) q.set("provider", sp.provider);
  if (sp.from) q.set("from", sp.from);
  if (sp.to) q.set("to", sp.to);
  if (sp.metric) q.set("metric", sp.metric);
  const tab = next.tab ?? sp.tab;
  if (tab && tab !== "overview") q.set("tab", tab);
  if (next.scope) q.set("scope", next.scope);
  const qs = q.toString();
  return qs ? `/org?${qs}` : "/org";
}

/** 전체 현황 — 개요·순위를 한 메뉴로 통합 (역할 축 개편). */
export default async function OrgPage({
  searchParams,
}: {
  searchParams: Promise<OrgSearchParams>;
}) {
  const sp = await searchParams;
  const t = await getTranslations("org");
  const tab = sp.tab === "ranking" ? "ranking" : "overview";
  const period = parseFilters(sp);
  const providers = await getEnabledProviders();

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          <>
            <DashboardFilters providers={providers} />
            <AutoRefresh />
          </>
        }
      />

      <PricingNotice />

      <LinkTabs
        active={tab}
        tabs={[
          { value: "overview", label: t("tabOverview"), href: hrefWith(sp, { tab: "overview" }) },
          { value: "ranking", label: t("tabRanking"), href: hrefWith(sp, { tab: "ranking" }) },
        ]}
      />

      {tab === "overview" ? <OverviewTab sp={sp} period={period} /> : <RankingTab sp={sp} period={period} />}
    </div>
  );
}

async function OverviewTab({
  sp,
  period,
}: {
  sp: OrgSearchParams;
  period: ReturnType<typeof parseFilters>;
}) {
  const t = await getTranslations("org");
  const metric: ChartMetric = sp.metric === "tokens" ? "tokens" : "cost";
  const storage = getStorage();
  const [overview, daily, topUsers] = await Promise.all([
    storage.getOverview(period),
    storage.getDailyTimeseries(period),
    storage.getLeaderboard({ ...period, scope: "user" }),
  ]);

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label={t("totalCost")} value={fmtUsd(overview.totalCostUsd)} icon={<DollarSign className="size-4" />} />
        <StatCard label={t("sessions")} value={fmtNum(overview.totalSessions)} icon={<Activity className="size-4" />} />
        <StatCard label={t("activeUsers")} value={fmtNum(overview.activeUsers)} icon={<Users className="size-4" />} />
        <StatCard
          label={t("totalTokens")}
          value={fmtCompact(overview.totalInputTokens + overview.totalOutputTokens)}
          hint={t("tokenHint", { in: fmtCompact(overview.totalInputTokens), out: fmtCompact(overview.totalOutputTokens) })}
          icon={<ArrowUpDown className="size-4" />}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>{t(period.bucket === "hour" ? "hourlyUsage" : "dailyUsage")}</CardTitle>
            <MetricToggle value={metric} />
          </CardHeader>
          <CardContent>
            {daily.length > 0 ? (
              <UsageAreaChart data={fillSeriesGaps(daily, period)} metric={metric} bucket={period.bucket} />
            ) : (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Inbox />
                  </EmptyMedia>
                  <EmptyTitle>{t("noDataTitle")}</EmptyTitle>
                  <EmptyDescription>{t("noCollectedUsageDescription")}</EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>{t("topUsers")}</CardTitle>
            <Button asChild variant="ghost" size="sm" className="text-muted-foreground -my-1">
              <Link href={hrefWith(sp, { tab: "ranking" })}>{t("viewAllRanking")}</Link>
            </Button>
          </CardHeader>
          <CardContent>
            {topUsers.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("user")}</TableHead>
                    <TableHead className="text-right">{t("cost")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {topUsers.slice(0, 6).map((r) => (
                    <TableRow key={r.key}>
                      <TableCell className="font-medium">{r.label}</TableCell>
                      <TableCell className="text-right">{fmtUsd(r.costUsd)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Inbox />
                  </EmptyMedia>
                  <EmptyTitle>{t("noUsersTitle")}</EmptyTitle>
                </EmptyHeader>
              </Empty>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

async function RankingTab({
  sp,
  period,
}: {
  sp: OrgSearchParams;
  period: ReturnType<typeof parseFilters>;
}) {
  const t = await getTranslations("org");
  const scope = sp.scope === "team" || sp.scope === "department" ? "team" : "user"; // department 는 구 URL 호환
  const scopeLabel = scope === "team" ? t("scope.team") : t("scope.user");
  const rows = await getStorage().getLeaderboard({ ...period, scope });

  return (
    <div className="space-y-6">
      <div className="flex justify-end gap-1">
        <Button asChild variant={scope === "user" ? "default" : "outline"} size="sm">
          <Link href={hrefWith(sp, { tab: "ranking", scope: "user" })}>{t("scope.user")}</Link>
        </Button>
        <Button asChild variant={scope === "team" ? "default" : "outline"} size="sm">
          <Link href={hrefWith(sp, { tab: "ranking", scope: "team" })}>{t("scope.team")}</Link>
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("topByCost", { scope: scopeLabel })}</CardTitle>
        </CardHeader>
        <CardContent>
          {rows.length > 0 ? (
            <LeaderboardBarChart data={rows} />
          ) : (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Inbox />
                </EmptyMedia>
                <EmptyTitle>{t("noDataTitle")}</EmptyTitle>
                <EmptyDescription>{t("noScopeUsageDescription", { scope: scopeLabel })}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </CardContent>
      </Card>

      {rows.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("rankingTitle", { scope: scopeLabel })}</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">#</TableHead>
                  <TableHead>{scopeLabel}</TableHead>
                  <TableHead className="text-right">{t("sessionsCol")}</TableHead>
                  <TableHead className="text-right">{t("tokensCol")}</TableHead>
                  <TableHead className="text-right">{t("cost")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r, i) => (
                  <TableRow key={r.key}>
                    <TableCell className="text-muted-foreground">{i + 1}</TableCell>
                    <TableCell className="font-medium">{r.label}</TableCell>
                    <TableCell className="text-right">{fmtNum(r.sessions)}</TableCell>
                    <TableCell className="text-right">{fmtCompact(r.totalTokens)}</TableCell>
                    <TableCell className="text-right">{fmtUsd(r.costUsd)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
