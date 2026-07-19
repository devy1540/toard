import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import type { LeaderRow, OverviewStats, ProviderBreakdown } from "@toard/core";
import { Blocks, Building2, DollarSign, Inbox, Layers3, Puzzle, Trophy, Users, Wrench } from "lucide-react";
import { UsageAreaChart } from "@/components/charts/usage-area-chart";
import { AutoRefresh } from "@/components/dashboard/auto-refresh";
import { DashboardFilters } from "@/components/dashboard/dashboard-filters";
import { MetricToggle, type ChartMetric } from "@/components/dashboard/metric-toggle";
import { OrgUtilizationCard } from "@/components/dashboard/org-utilization-card";
import { PricingNotice } from "@/components/dashboard/pricing-notice";
import { DeltaBadge } from "@/components/dashboard/stat-card";
import { SummaryTile } from "@/components/dashboard/summary-tile";
import { SupportingMetric } from "@/components/dashboard/supporting-metric";
import { TeamAttributionFence } from "@/components/dashboard/team-attribution-fence";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { fmtCompact, fmtNum, fmtUsd } from "@/lib/format";
import { getCachedOrganizationUtilization } from "@/lib/ai-utilization";
import {
  ORG_LEADERBOARD_METRIC,
  cacheSharePercent,
  findPeakTokenBucket,
  getOrgChartMetric,
  sharePercent,
  tokenLeaderboardMetrics,
  totalUsageTokens,
  usagePerActiveUser,
} from "@/lib/org-overview";
import { fillSeriesGaps, parseDashboardPeriod, previousPeriod, type DashboardSearchParams } from "@/lib/period";
import { formatCostForCoverage, legacyCostHintCount } from "@/lib/pricing";
import { getEnabledProviders, type ProviderOption } from "@/lib/providers";
import { getDashboardViewer } from "@/lib/session-user";
import { pctDelta } from "@/lib/stat-delta";
import { getStorage } from "@/lib/storage";
import { findTeamAttributionFence } from "@/lib/team-attribution";
import { getOrgToolSummary } from "@/lib/tool-metadata";
import { getViewerTimezone } from "@/lib/viewer-time";

export const dynamic = "force-dynamic";

type OrgSearchParams = DashboardSearchParams & { tab?: string; scope?: string };
type OrgPeriod = ReturnType<typeof parseDashboardPeriod>;
const tokenLabelKey = {
  today: "tokenLabel.today",
  week: "tokenLabel.week",
  month: "tokenLabel.month",
  quarter: "tokenLabel.quarter",
  year: "tokenLabel.year",
  "7": "tokenLabel.7",
  "30": "tokenLabel.30",
  "90": "tokenLabel.90",
  custom: "tokenLabel.custom",
  all: "tokenLabel.all",
} as const;

function usageTitleKey(bucket: OrgPeriod["bucket"]): "dailyUsage" | "hourlyUsage" | "usage30m" | "usage15m" {
  if (bucket === "day") return "dailyUsage";
  if (bucket === "hour") return "hourlyUsage";
  if (bucket === "30m") return "usage30m";
  return "usage15m";
}

function RankRow({
  row,
  rank,
  metric,
  total,
  max,
  costLabels,
}: {
  row: LeaderRow;
  rank: number;
  metric: ChartMetric;
  total: number;
  max: number;
  costLabels: { partial: string; unpriced: string; legacy: string };
}) {
  let width: number;
  let share: number | null;
  let value: string;

  if (metric === "tokens") {
    const tokenMetrics = tokenLeaderboardMetrics({
      tokens: row.totalTokens,
      totalTokens: total,
      maxTokens: max,
    });
    width = tokenMetrics.width;
    share = tokenMetrics.share;
    value = fmtCompact(row.totalTokens);
  } else {
    width = max > 0 ? Math.max(3, Math.round((row.costUsd / max) * 100)) : 0;
    share = row.costCoverage.unpricedEvents === 0 && total > 0
      ? Math.round((row.costUsd / total) * 100)
      : null;
    value = formatCostForCoverage(fmtUsd(row.costUsd), row.costCoverage, costLabels);
  }

  return (
    <div className="space-y-1.5">
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <span className="text-muted-foreground w-5 shrink-0 text-right tabular-nums">{rank}</span>
        <span className="truncate font-medium" title={row.label}>
          {row.label}
        </span>
        <span className="ml-auto shrink-0 font-medium tabular-nums">
          {value}
        </span>
      </div>
      <div className="ml-7 flex items-center gap-2">
        <div className="bg-muted h-1.5 min-w-0 flex-1 overflow-hidden rounded-full">
          <div className="bg-chart-1 h-full rounded-full" style={{ width: `${width}%` }} />
        </div>
        <span className="text-muted-foreground w-10 text-right text-[11px] tabular-nums">
          {share == null ? "—" : `${share}%`}
        </span>
      </div>
    </div>
  );
}

function LeaderboardPreview({
  title,
  description,
  emptyTitle,
  rows,
  metric,
  total,
  icon,
  trailing,
  costLabels,
}: {
  title: string;
  description: string;
  emptyTitle: string;
  rows: LeaderRow[];
  metric: ChartMetric;
  total: number;
  icon: ReactNode;
  trailing?: ReactNode;
  costLabels: { partial: string; unpriced: string; legacy: string };
}) {
  const shown = rows.slice(0, 5);
  const max = metric === "tokens" ? shown[0]?.totalTokens ?? 0 : shown[0]?.costUsd ?? 0;

  return (
    <Card className="min-w-0 gap-4">
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2 text-base">
            {icon}
            {title}
          </CardTitle>
          <CardDescription>{description}</CardDescription>
        </div>
        {trailing ? <div className="shrink-0">{trailing}</div> : null}
      </CardHeader>
      <CardContent>
        {shown.length > 0 ? (
          <div className="space-y-4">
            {shown.map((row, i) => (
              <RankRow key={row.key} row={row} rank={i + 1} metric={metric} total={total} max={max} costLabels={costLabels} />
            ))}
          </div>
        ) : (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Inbox />
              </EmptyMedia>
              <EmptyTitle>{emptyTitle}</EmptyTitle>
            </EmptyHeader>
          </Empty>
        )}
      </CardContent>
    </Card>
  );
}

function TeamAccessCard({
  title,
  description,
  actionLabel,
  href,
}: {
  title: string;
  description: string;
  actionLabel: string;
  href: string;
}) {
  return (
    <Card className="min-w-0 gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Building2 className="text-muted-foreground size-4" />
          {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <Button asChild variant="outline" size="sm">
          <Link href={href}>{actionLabel}</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

function OrgHero({
  overview,
  prevOverview,
  tokenLabel,
  tokenComparison,
  costLabel,
  costComparison,
  costValue,
  activeUsersLabel,
  activeUsersSub,
}: {
  overview: OverviewStats;
  prevOverview: OverviewStats;
  tokenLabel: string;
  tokenComparison: string;
  costLabel: string;
  costComparison: string;
  costValue: string;
  activeUsersLabel: string;
  activeUsersSub: string;
}) {
  const tokens = totalUsageTokens({
    input: overview.totalInputTokens,
    output: overview.totalOutputTokens,
    cacheRead: overview.totalCacheReadTokens,
    cacheCreation: overview.totalCacheCreationTokens,
  });
  const previousTokens = totalUsageTokens({
    input: prevOverview.totalInputTokens,
    output: prevOverview.totalOutputTokens,
    cacheRead: prevOverview.totalCacheReadTokens,
    cacheCreation: prevOverview.totalCacheCreationTokens,
  });
  const delta = pctDelta(tokens, previousTokens);

  return (
    <section className="border-border/80 bg-card rounded-xl border px-5 py-5">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div className="min-w-0">
          <div className="text-muted-foreground text-xs tracking-wide uppercase">{tokenLabel}</div>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <span className="text-4xl font-semibold tracking-tight tabular-nums">{fmtCompact(tokens)}</span>
            {delta ? (
              <span className="text-xs">
                <DeltaBadge delta={delta} />
              </span>
            ) : null}
          </div>
          <p className="text-muted-foreground mt-1 text-sm">{tokenComparison}</p>
        </div>

        <div className="grid w-full gap-4 sm:grid-cols-2 xl:w-auto xl:min-w-[390px]">
          <SummaryTile label={costLabel} value={costValue} sub={costComparison} />
          <SummaryTile label={activeUsersLabel} value={fmtNum(overview.activeUsers)} sub={activeUsersSub} />
        </div>
      </div>
    </section>
  );
}

function WorkspaceSignalsCard({
  title,
  description,
  signals,
}: {
  title: string;
  description: string;
  signals: Array<{ label: string; value: string; sub: string }>;
}) {
  return (
    <Card className="min-w-0 gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Trophy className="text-muted-foreground size-4" />
          {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {signals.map((signal) => (
            <SummaryTile key={signal.label} {...signal} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

const providerBarClasses = ["bg-chart-1", "bg-chart-2", "bg-chart-3", "bg-chart-4", "bg-chart-5"] as const;

function ProviderCompositionCard({
  title,
  description,
  emptyTitle,
  rows,
  totalTokens,
  providers,
}: {
  title: string;
  description: string;
  emptyTitle: string;
  rows: ProviderBreakdown[];
  totalTokens: number;
  providers: ProviderOption[];
}) {
  const shown = rows.slice(0, 5);
  const labels = new Map(providers.map((provider) => [provider.key, provider.label]));

  return (
    <Card className="min-w-0 gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Layers3 className="text-muted-foreground size-4" />
          {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {shown.length > 0 ? (
          <div className="space-y-3">
            {shown.map((row, index) => {
              const share = sharePercent(row.totalTokens, totalTokens);
              return (
                <div key={row.providerKey} className="grid min-w-0 grid-cols-[minmax(6rem,0.8fr)_minmax(0,1.6fr)_auto] items-center gap-3">
                  <span className="truncate text-sm font-medium" title={labels.get(row.providerKey) ?? row.providerKey}>
                    {labels.get(row.providerKey) ?? row.providerKey}
                  </span>
                  <div className="bg-muted h-1.5 min-w-0 overflow-hidden rounded-full">
                    <div
                      className={`${providerBarClasses[index] ?? "bg-chart-5"} h-full rounded-full`}
                      style={{ width: `${share ?? 0}%` }}
                    />
                  </div>
                  <span className="text-muted-foreground text-right text-xs tabular-nums">{share == null ? "—" : `${share}%`}</span>
                </div>
              );
            })}
          </div>
        ) : (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Inbox />
              </EmptyMedia>
              <EmptyTitle>{emptyTitle}</EmptyTitle>
            </EmptyHeader>
          </Empty>
        )}
      </CardContent>
    </Card>
  );
}

/** 필터(period·provider·커스텀 범위)를 유지한 채 tab/scope 만 바꾼 href 생성 */
function hrefWith(sp: OrgSearchParams, path = "/org"): string {
  const q = new URLSearchParams();
  if (sp.period) q.set("period", sp.period);
  if (sp.provider) q.set("provider", sp.provider);
  if (sp.from) q.set("from", sp.from);
  if (sp.to) q.set("to", sp.to);
  if (sp.bucket) q.set("bucket", sp.bucket);
  if (sp.metric) q.set("metric", sp.metric);
  const qs = q.toString();
  return qs ? `${path}?${qs}` : path;
}

function legacyRankingHref(sp: OrgSearchParams): string {
  return sp.scope === "team" || sp.scope === "department" ? hrefWith(sp, "/org/teams") : hrefWith(sp, "/org");
}

/** 전체 현황 — 워크스페이스 전체 사용량 총량·추이 중심. 팀별 상세는 /org/teams. */
export default async function OrgPage({
  searchParams,
}: {
  searchParams: Promise<OrgSearchParams>;
}) {
  const sp = await searchParams;
  const t = await getTranslations("org");
  const navT = await getTranslations("nav");
  const attributionT = await getTranslations("admin");
  if (sp.tab === "ranking") redirect(legacyRankingHref(sp));
  const period = parseDashboardPeriod(sp, await getViewerTimezone());
  const providers = await getEnabledProviders();
  const viewer = await getDashboardViewer();
  const canSeeTeamRanking = viewer?.role === "admin";
  const attributionFence = await findTeamAttributionFence(period.from, period.to);

  return (
    <div className="space-y-6">
      <DashboardFilters
        providers={providers}
        timezone={period.timezone}
        limited={period.limited}
        showBucketControl
        title={t("title")}
        statusBadge={{ status: "preview", label: navT("badge.preview") }}
        trailing={<AutoRefresh />}
      />

      {attributionFence ? (
        <TeamAttributionFence
          title={attributionT("teamAttribution.readFenceTitle")}
          description={attributionT("teamAttribution.readFenceDescription")}
        />
      ) : (
        <OverviewTab sp={sp} period={period} providers={providers} canSeeTeamRanking={canSeeTeamRanking} />
      )}
    </div>
  );
}

async function OverviewTab({
  sp,
  period,
  providers,
  canSeeTeamRanking,
}: {
  sp: OrgSearchParams;
  period: OrgPeriod;
  providers: ProviderOption[];
  canSeeTeamRanking: boolean;
}) {
  const [t, dashboardT] = await Promise.all([getTranslations("org"), getTranslations("dashboard")]);
  const metric: ChartMetric = getOrgChartMetric(sp.metric);
  const storage = getStorage();
  const [overview, prevOverview, daily, topUsers, topTeams, providerBreakdown, toolActivity, utilization] = await Promise.all([
    storage.getOverview(period),
    storage.getOverview(previousPeriod(period)),
    storage.getDailyTimeseries(period),
    storage.getLeaderboard({ ...period, scope: "user", orderBy: ORG_LEADERBOARD_METRIC }),
    canSeeTeamRanking ? storage.getLeaderboard({ ...period, scope: "team" }) : Promise.resolve([]),
    storage.getProviderBreakdown(period),
    getOrgToolSummary(period),
    getCachedOrganizationUtilization(),
  ]);

  const series = fillSeriesGaps(daily, period);
  const costLabels = {
    partial: dashboardT("costCoverage.partial"),
    unpriced: dashboardT("costCoverage.unpriced"),
    legacy: dashboardT("costCoverage.legacy"),
  };
  const costValue = formatCostForCoverage(fmtUsd(overview.totalCostUsd), overview.costCoverage, costLabels);
  const tokens = totalUsageTokens({
    input: overview.totalInputTokens,
    output: overview.totalOutputTokens,
    cacheRead: overview.totalCacheReadTokens,
    cacheCreation: overview.totalCacheCreationTokens,
  });
  const previousTokens = totalUsageTokens({
    input: prevOverview.totalInputTokens,
    output: prevOverview.totalOutputTokens,
    cacheRead: prevOverview.totalCacheReadTokens,
    cacheCreation: prevOverview.totalCacheCreationTokens,
  });
  const cacheTokens = overview.totalCacheReadTokens + overview.totalCacheCreationTokens;
  const cacheShare = cacheSharePercent(cacheTokens, tokens);
  const tokensPerUser = usagePerActiveUser(tokens, overview.activeUsers);
  const tokenDiff = Math.abs(tokens - previousTokens);
  const costDiff = Math.abs(overview.totalCostUsd - prevOverview.totalCostUsd);
  const tokenComparison =
    previousTokens > 0
      ? t(tokens <= previousTokens ? "hero.tokenLessThanPrev" : "hero.tokenMoreThanPrev", {
          prev: fmtCompact(previousTokens),
          diff: fmtCompact(tokenDiff),
        })
      : t("hero.noTokenComparison");
  const legacyCount = overview.costCoverage.unpricedEvents === 0 && prevOverview.costCoverage.unpricedEvents === 0
    ? legacyCostHintCount(overview.costCoverage)
    : null;
  const legacyHint = legacyCount == null
    ? null
    : dashboardT("costCoverage.legacyHint", { count: fmtNum(legacyCount) });
  const costComparison = legacyHint ?? (
    overview.costCoverage.unpricedEvents > 0 || prevOverview.costCoverage.unpricedEvents > 0
      ? dashboardT("costCoverage.partial")
      : prevOverview.totalCostUsd > 0
        ? t(overview.totalCostUsd <= prevOverview.totalCostUsd ? "hero.lessThanPrev" : "hero.moreThanPrev", {
            prev: fmtUsd(prevOverview.totalCostUsd),
            diff: fmtUsd(costDiff),
          })
        : t("hero.noComparison")
  );
  const topThreeTokens = topUsers.slice(0, 3).reduce((sum, row) => sum + row.totalTokens, 0);
  const topThreeShare = sharePercent(topThreeTokens, tokens);
  const peakUsage = findPeakTokenBucket(
    series.map((point) => ({
      day: point.day,
      input: point.inputTokens,
      output: point.outputTokens,
      cacheRead: point.cacheReadTokens,
      cacheCreation: point.cacheCreationTokens,
    })),
  );
  const costDelta = overview.costCoverage.unpricedEvents === 0 && prevOverview.costCoverage.unpricedEvents === 0
    ? pctDelta(overview.totalCostUsd, prevOverview.totalCostUsd)
    : null;
  const workspaceSignals = [
    {
      label: t("signal.topThreeTokenShare"),
      value: topThreeShare == null ? "—" : `${topThreeShare}%`,
      sub: t("signal.topThreeWorkspaceTokenShareSub"),
    },
    {
      label: t("signal.peakTokenBucket"),
      value: peakUsage ? peakUsage.day.slice(5) : "—",
      sub: t("signal.peakTokenBucketSub"),
    },
    {
      label: t("signal.costChange"),
      value: costDelta?.pct ?? "—",
      sub: t("signal.costChangeSub"),
    },
  ];

  return (
    <div data-dashboard-ready="org-overview" className="space-y-6">
      <PricingNotice coverage={overview.costCoverage} />

      <OrgHero
        overview={overview}
        prevOverview={prevOverview}
        tokenLabel={t(tokenLabelKey[period.preset])}
        tokenComparison={tokenComparison}
        costLabel={t("totalCost")}
        costComparison={costComparison}
        costValue={costValue}
        activeUsersLabel={t("hero.activeUsers")}
        activeUsersSub={t("hero.activeUsersWithSessions", { count: fmtNum(overview.totalSessions) })}
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <SupportingMetric
          label={t("tokensPerUser")}
          value={tokensPerUser == null ? "—" : fmtCompact(tokensPerUser)}
          sub={t("hero.activeUsersSub")}
          icon={<Users className="size-4" />}
        />
        <SupportingMetric
          label={t("costPerUser")}
          value={overview.activeUsers > 0
            ? formatCostForCoverage(fmtUsd(overview.totalCostUsd / overview.activeUsers), overview.costCoverage, costLabels)
            : "—"}
          sub={t("hero.activeUsersSub")}
          icon={<DollarSign className="size-4" />}
        />
        <SupportingMetric
          label={t("signal.cacheShare")}
          value={cacheShare == null ? "—" : `${cacheShare}%`}
          sub={t("signal.cacheShareSub", { cache: fmtCompact(cacheTokens) })}
          icon={<Layers3 className="size-4" />}
        />
      </div>

      <Card>
        <CardHeader><CardTitle>{t("toolActivity.title")}</CardTitle><CardDescription>{t("toolActivity.description")}</CardDescription></CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
          <SummaryTile label={t("toolActivity.mcp")} value={fmtNum(toolActivity.mcpCalls)} icon={<Wrench className="size-3.5" />} />
          <SummaryTile label={t("toolActivity.skills")} value={fmtNum(toolActivity.distinctSkills)} icon={<Blocks className="size-3.5" />} />
          <SummaryTile label={t("toolActivity.plugins")} value={fmtNum(toolActivity.distinctPlugins)} icon={<Puzzle className="size-3.5" />} />
          <SummaryTile label={t("toolActivity.users")} value={fmtNum(toolActivity.activeUsers ?? 0)} icon={<Users className="size-3.5" />} />
          <SummaryTile label={t("toolActivity.devices")} value={fmtNum(toolActivity.activeDevices ?? 0)} />
        </CardContent>
      </Card>

      <OrgUtilizationCard result={utilization} />

      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,0.8fr)]">
        <Card className="min-w-0">
          <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <CardTitle>{t(usageTitleKey(period.bucket))}</CardTitle>
            <MetricToggle value={metric} />
          </CardHeader>
          <CardContent className="min-w-0">
            {daily.length > 0 ? (
              <UsageAreaChart
                data={series}
                metric={metric}
                bucket={period.bucket}
                markNow={period.preset === "today"}
              />
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

        <LeaderboardPreview
          title={t("topUsers")}
          description={t("topUsersDescription")}
          emptyTitle={t("noUsersTitle")}
          rows={topUsers}
          metric={ORG_LEADERBOARD_METRIC}
          total={tokens}
          icon={<Users className="text-muted-foreground size-4" />}
          costLabels={costLabels}
        />
      </div>

      {canSeeTeamRanking ? (
        <div className="grid min-w-0 gap-4 lg:grid-cols-2">
          <LeaderboardPreview
            title={t("topTeams")}
            description={t("topTeamsDescription")}
            emptyTitle={t("noTeamsTitle")}
            rows={topTeams}
            metric="cost"
            total={overview.totalCostUsd}
            icon={<Building2 className="text-muted-foreground size-4" />}
            costLabels={costLabels}
            trailing={
              <Button asChild variant="ghost" size="sm" className="text-muted-foreground -my-1">
                <Link href={hrefWith(sp, "/org/teams")}>{t("openTeams")}</Link>
              </Button>
            }
          />
          <WorkspaceSignalsCard
            title={t("workspaceSignals")}
            description={t("workspaceSignalsDescription")}
            signals={workspaceSignals}
          />
        </div>
      ) : (
        <div className="grid min-w-0 gap-4 lg:grid-cols-2">
          <TeamAccessCard
            title={t("teamAccess.title")}
            description={t("teamAccess.memberDescription")}
            actionLabel={t("teamAccess.openMyTeam")}
            href={hrefWith(sp, "/org/team")}
          />
          <WorkspaceSignalsCard
            title={t("workspaceSignals")}
            description={t("workspaceSignalsDescription")}
            signals={workspaceSignals}
          />
        </div>
      )}

      <ProviderCompositionCard
        title={t("providerComposition")}
        description={t("providerCompositionDescription")}
        emptyTitle={t("noProviderTitle")}
        rows={providerBreakdown}
        totalTokens={tokens}
        providers={providers}
      />
    </div>
  );
}
