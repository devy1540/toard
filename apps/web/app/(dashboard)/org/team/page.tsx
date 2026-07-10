import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import type { LeaderRow, OverviewStats, ProviderBreakdown } from "@toard/core";
import { DollarSign, Inbox, Layers3, Trophy, Users } from "lucide-react";
import { TeamUsageChart } from "@/components/charts/team-usage-chart";
import { AutoRefresh } from "@/components/dashboard/auto-refresh";
import { DashboardFilters } from "@/components/dashboard/dashboard-filters";
import { MetricToggle, type ChartMetric } from "@/components/dashboard/metric-toggle";
import { PricingNotice } from "@/components/dashboard/pricing-notice";
import { DeltaBadge } from "@/components/dashboard/stat-card";
import { TeamFilter } from "@/components/dashboard/team-filter";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { getPool } from "@/lib/db";
import { fmtCompact, fmtNum, fmtUsd } from "@/lib/format";
import { cacheSharePercent, findPeakTokenBucket, sharePercent, totalUsageTokens, usagePerActiveUser } from "@/lib/org-overview";
import { fillSeriesGaps, parseDashboardPeriod, previousPeriod, type DashboardSearchParams } from "@/lib/period";
import { formatCostForCoverage } from "@/lib/pricing";
import { getEnabledProviders, type ProviderOption } from "@/lib/providers";
import { getDashboardViewer } from "@/lib/session-user";
import { pctDelta } from "@/lib/stat-delta";
import { getStorage } from "@/lib/storage";
import { buildTeamMemberSeries, TEAM_MEMBER_COLORS } from "@/lib/team-overview";
import { getViewerTimezone } from "@/lib/viewer-time";

export const dynamic = "force-dynamic";

type TeamStatusSearchParams = DashboardSearchParams & { team?: string };
type TeamPeriod = ReturnType<typeof parseDashboardPeriod>;
type TeamOption = { id: string; name: string };
type CostLabels = { partial: string; unpriced: string; legacy: string };

function overviewTokens(overview: OverviewStats): number {
  return totalUsageTokens({
    input: overview.totalInputTokens,
    output: overview.totalOutputTokens,
    cacheRead: overview.totalCacheReadTokens,
    cacheCreation: overview.totalCacheCreationTokens,
  });
}

function teamUsageTitleKey(
  bucket: TeamPeriod["bucket"],
): "teamDailyUsage" | "teamHourlyUsage" | "teamUsage30m" | "teamUsage15m" {
  if (bucket === "day") return "teamDailyUsage";
  if (bucket === "hour") return "teamHourlyUsage";
  if (bucket === "30m") return "teamUsage30m";
  return "teamUsage15m";
}

async function listTeams(): Promise<TeamOption[]> {
  const r = await getPool().query<TeamOption>("SELECT id::text AS id, name FROM teams ORDER BY name");
  return r.rows;
}

function SummaryTile({ label, value, sub, icon }: { label: string; value: string; sub?: string; icon?: ReactNode }) {
  return (
    <div className="border-border/70 min-w-0 border-l pl-3">
      <div className="text-muted-foreground flex items-center gap-1.5 text-xs tracking-wide uppercase">
        {icon}
        {label}
      </div>
      <div className="mt-1 truncate text-xl font-medium tabular-nums">{value}</div>
      {sub ? <div className="text-muted-foreground mt-0.5 truncate text-xs">{sub}</div> : null}
    </div>
  );
}

function TeamHero({
  overview,
  previousTokens,
  tokenLabel,
  costLabel,
  activeUsersLabel,
  sessionsLabel,
  activeUsersSub,
  costLabels,
}: {
  overview: OverviewStats;
  previousTokens: number;
  tokenLabel: string;
  costLabel: string;
  activeUsersLabel: string;
  sessionsLabel: string;
  activeUsersSub: string;
  costLabels: CostLabels;
}) {
  const tokens = overviewTokens(overview);
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
        </div>

        <div className="grid w-full gap-4 sm:grid-cols-3 xl:w-auto xl:min-w-[520px]">
          <SummaryTile
            label={costLabel}
            value={formatCostForCoverage(fmtUsd(overview.totalCostUsd), overview.costCoverage, costLabels)}
          />
          <SummaryTile label={activeUsersLabel} value={fmtNum(overview.activeUsers)} sub={activeUsersSub} />
          <SummaryTile label={sessionsLabel} value={fmtNum(overview.totalSessions)} />
        </div>
      </div>
    </section>
  );
}

function SupportingMetric({ label, value, sub, icon }: { label: string; value: string; sub: string; icon: ReactNode }) {
  return (
    <div className="border-border/80 bg-card min-w-0 rounded-xl border px-4 py-4 shadow-sm">
      <div className="text-muted-foreground flex items-center gap-2 text-sm">
        {icon}
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-2 truncate text-2xl font-bold tracking-tight tabular-nums">{value}</div>
      <div className="text-muted-foreground mt-1 truncate text-xs">{sub}</div>
    </div>
  );
}

function TeamRankRow({
  row,
  rank,
  metric,
  total,
  max,
  color,
  sessionsLabel,
  secondaryLabel,
  costLabels,
}: {
  row: LeaderRow;
  rank: number;
  metric: ChartMetric;
  total: number;
  max: number;
  color: string;
  sessionsLabel: string;
  secondaryLabel: string;
  costLabels: CostLabels;
}) {
  const value = metric === "tokens" ? row.totalTokens : row.costUsd;
  const cost = formatCostForCoverage(fmtUsd(row.costUsd), row.costCoverage, costLabels);
  const secondary = metric === "tokens" ? cost : fmtCompact(row.totalTokens);
  const share = sharePercent(value, total);
  const width = max > 0 ? Math.max(3, Math.round((value / max) * 100)) : 0;

  return (
    <div className="space-y-1.5">
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <span className="text-muted-foreground w-5 shrink-0 text-right tabular-nums">{rank}</span>
        <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: color }} aria-hidden />
        <span className="truncate font-medium" title={row.label}>
          {row.label}
        </span>
        <span className="ml-auto shrink-0 font-medium tabular-nums">
          {metric === "tokens" ? fmtCompact(row.totalTokens) : cost}
        </span>
      </div>
      <div className="ml-7 space-y-1.5">
        <div className="text-muted-foreground flex flex-wrap gap-x-2 text-[11px]">
          <span>{sessionsLabel} {fmtNum(row.sessions)}</span>
          <span>{secondaryLabel} {secondary}</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="bg-muted h-1.5 min-w-0 flex-1 overflow-hidden rounded-full">
            <div className="h-full rounded-full" style={{ width: `${width}%`, backgroundColor: color }} />
          </div>
          <span className="text-muted-foreground w-10 text-right text-[11px] tabular-nums">
            {share == null ? "—" : `${share}%`}
          </span>
        </div>
      </div>
    </div>
  );
}

function TeamMembersCard({
  rows,
  metric,
  total,
  title,
  description,
  emptyTitle,
  emptyDescription,
  sessionsLabel,
  secondaryLabel,
  costLabels,
}: {
  rows: LeaderRow[];
  metric: ChartMetric;
  total: number;
  title: string;
  description: string;
  emptyTitle: string;
  emptyDescription: string;
  sessionsLabel: string;
  secondaryLabel: string;
  costLabels: CostLabels;
}) {
  const shown = rows.slice(0, 5);
  const max = shown.length > 0 ? (metric === "tokens" ? shown[0]!.totalTokens : shown[0]!.costUsd) : 0;

  return (
    <Card className="min-w-0 gap-4 xl:h-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Users className="text-muted-foreground size-4" />
          {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {shown.length > 0 ? (
          <div className="space-y-4">
            {shown.map((row, index) => (
              <TeamRankRow
                key={row.key}
                row={row}
                rank={index + 1}
                metric={metric}
                total={total}
                max={max}
                color={TEAM_MEMBER_COLORS[index % TEAM_MEMBER_COLORS.length] ?? TEAM_MEMBER_COLORS[0]}
                sessionsLabel={sessionsLabel}
                secondaryLabel={secondaryLabel}
                costLabels={costLabels}
              />
            ))}
          </div>
        ) : (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Inbox />
              </EmptyMedia>
              <EmptyTitle>{emptyTitle}</EmptyTitle>
              <EmptyDescription>{emptyDescription}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </CardContent>
    </Card>
  );
}

function TeamSignalsCard({
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
        <div className="grid min-w-0 gap-3 sm:grid-cols-3">
          {signals.map((signal) => (
            <SummaryTile key={signal.label} {...signal} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

const providerBarClasses = ["bg-chart-1", "bg-chart-2", "bg-chart-3", "bg-chart-4", "bg-chart-5"] as const;

function TeamProviderCompositionCard({
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
        {rows.length > 0 ? (
          <div className="space-y-3">
            {rows.slice(0, 5).map((row, index) => {
              const share = sharePercent(row.totalTokens, totalTokens);
              return (
                <div key={row.providerKey} className="grid min-w-0 grid-cols-[minmax(6rem,0.8fr)_minmax(0,1.6fr)_auto] items-center gap-3">
                  <span className="truncate text-sm font-medium" title={labels.get(row.providerKey) ?? row.providerKey}>
                    {labels.get(row.providerKey) ?? row.providerKey}
                  </span>
                  <div className="bg-muted h-1.5 min-w-0 overflow-hidden rounded-full">
                    <div className={`${providerBarClasses[index] ?? "bg-chart-5"} h-full rounded-full`} style={{ width: `${share ?? 0}%` }} />
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

export default async function TeamStatusPage({
  searchParams,
}: {
  searchParams: Promise<TeamStatusSearchParams>;
}) {
  const sp = await searchParams;
  const [t, navT] = await Promise.all([getTranslations("org"), getTranslations("nav")]);
  const period = parseDashboardPeriod(sp, await getViewerTimezone());
  const [providers, viewer] = await Promise.all([getEnabledProviders(), getDashboardViewer()]);
  if (!viewer) redirect("/login");

  const isAdmin = viewer.role === "admin";
  const teams = isAdmin ? await listTeams() : [];
  const selectedTeam = isAdmin
    ? (teams.find((team) => team.id === sp.team) ?? teams.find((team) => team.id === viewer.teamId) ?? teams[0] ?? null)
    : viewer.teamId
      ? { id: viewer.teamId, name: viewer.teamName ?? t("myTeamFallbackTitle") }
      : null;
  const title = selectedTeam ? t("myTeamTitle", { team: selectedTeam.name }) : t("myTeamFallbackTitle");

  return (
    <div className="space-y-6">
      <DashboardFilters
        providers={providers}
        timezone={period.timezone}
        limited={period.limited}
        showBucketControl
        title={title}
        statusBadge={{ status: "beta", label: navT("badge.beta") }}
        filterTrailing={
          isAdmin && selectedTeam ? <TeamFilter teams={teams} value={selectedTeam.id} label={t("teamSelector.label")} /> : undefined
        }
        trailing={<AutoRefresh />}
      />

      <TeamDetailOverview period={period} sp={sp} teamId={selectedTeam?.id ?? null} isAdmin={isAdmin} providers={providers} />
    </div>
  );
}

async function TeamDetailOverview({
  sp,
  period,
  teamId,
  isAdmin,
  providers,
}: {
  sp: TeamStatusSearchParams;
  period: TeamPeriod;
  teamId: string | null;
  isAdmin: boolean;
  providers: ProviderOption[];
}) {
  const [t, dashboardT] = await Promise.all([getTranslations("org"), getTranslations("dashboard")]);
  if (!teamId) {
    return (
      <Card className="min-w-0">
        <CardContent className="min-w-0">
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Users />
              </EmptyMedia>
              <EmptyTitle>{t(isAdmin ? "teamSelector.emptyTitle" : "teamAccess.unassignedTitle")}</EmptyTitle>
              <EmptyDescription>
                {t(isAdmin ? "teamSelector.emptyDescription" : "teamAccess.unassignedDescription")}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </CardContent>
      </Card>
    );
  }

  const metric: ChartMetric = sp.metric === "cost" ? "cost" : "tokens";
  const storage = getStorage();
  const scoped = { ...period, teamId };
  const [overview, prevOverview, daily, members, tokenMembers, providerBreakdown] = await Promise.all([
    storage.getOverview(scoped),
    storage.getOverview({ ...previousPeriod(period), teamId }),
    storage.getDailyTimeseries({ ...period, scope: "team", teamId }),
    storage.getLeaderboard({ ...period, scope: "user", teamId, orderBy: metric }),
    metric === "tokens"
      ? Promise.resolve(null)
      : storage.getLeaderboard({ ...period, scope: "user", teamId, orderBy: "tokens" }),
    storage.getProviderBreakdown(scoped),
  ]);
  const series = fillSeriesGaps(daily, period);
  const costLabels = {
    partial: dashboardT("costCoverage.partial"),
    unpriced: dashboardT("costCoverage.unpriced"),
    legacy: dashboardT("costCoverage.legacy"),
  };
  const shownMembers = members.slice(0, 5);
  const memberPoints = await storage.getTeamMemberTimeseries({
    ...period,
    teamId,
    userIds: shownMembers.map((member) => member.key),
  });
  const tokens = overviewTokens(overview);
  const previousTokens = overviewTokens(prevOverview);
  const cacheTokens = overview.totalCacheReadTokens + overview.totalCacheCreationTokens;
  const tokensPerUser = usagePerActiveUser(tokens, overview.activeUsers);
  const cacheShare = cacheSharePercent(cacheTokens, tokens);
  const membersByTokens = tokenMembers ?? members;
  const topThreeTokenShare = sharePercent(
    membersByTokens.slice(0, 3).reduce((sum, member) => sum + member.totalTokens, 0),
    tokens,
  );
  const peakUsage = findPeakTokenBucket(
    series.map((point) => ({
      day: point.day,
      input: point.inputTokens,
      output: point.outputTokens,
      cacheRead: point.cacheReadTokens,
      cacheCreation: point.cacheCreationTokens,
    })),
  );
  const memberSeries = buildTeamMemberSeries(series, memberPoints, shownMembers, overview.activeUsers, t("teamChartOthers"));
  const signals = [
    {
      label: t("signal.topThreeTokenShare"),
      value: topThreeTokenShare == null ? "—" : `${topThreeTokenShare}%`,
      sub: t("signal.topThreeTokenShareSub"),
    },
    {
      label: t("signal.peakTokenBucket"),
      value: peakUsage ? peakUsage.day.slice(5) : "—",
      sub: t("signal.peakTokenBucketSub"),
    },
    {
      label: t("signal.costChange"),
      value: overview.costCoverage.unpricedEvents > 0 || prevOverview.costCoverage.unpricedEvents > 0
        ? "—"
        : pctDelta(overview.totalCostUsd, prevOverview.totalCostUsd)?.pct ?? "—",
      sub: t("signal.costChangeSub"),
    },
  ];

  return (
    <div data-dashboard-ready="team-overview" className="space-y-6">
      <PricingNotice coverage={overview.costCoverage} />

      <TeamHero
        overview={overview}
        previousTokens={previousTokens}
        tokenLabel={t("totalTokens")}
        costLabel={t("totalCost")}
        activeUsersLabel={t("activeUsers")}
        sessionsLabel={t("sessions")}
        activeUsersSub={t("hero.activeUsersSub")}
        costLabels={costLabels}
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

      <div className="grid min-w-0 items-stretch gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,0.8fr)]">
        <Card className="min-w-0 xl:h-full">
          <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <CardTitle>{t(teamUsageTitleKey(period.bucket))}</CardTitle>
              <CardDescription>{t("teamChartMembersDescription")}</CardDescription>
            </div>
            <MetricToggle value={metric} />
          </CardHeader>
          <CardContent className="min-w-0">
            {daily.length > 0 ? (
              <TeamUsageChart
                aggregate={series}
                members={memberSeries}
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
                  <EmptyDescription>{t("teamNoUsageDescription")}</EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </CardContent>
        </Card>

        <TeamMembersCard
          rows={members}
          metric={metric}
          total={metric === "tokens" ? tokens : overview.totalCostUsd}
          title={t("teamMembers")}
          description={t(metric === "tokens" ? "teamMembersTokensDescription" : "teamMembersCostDescription")}
          emptyTitle={t("teamNoMembersTitle")}
          emptyDescription={t("teamNoUsageDescription")}
          sessionsLabel={t("sessionsCol")}
          secondaryLabel={metric === "tokens" ? t("cost") : t("tokensCol")}
          costLabels={costLabels}
        />
      </div>

      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <TeamSignalsCard title={t("teamSignals")} description={t("teamSignalsDescription")} signals={signals} />
        <TeamProviderCompositionCard
          title={t("teamProviderComposition")}
          description={t("teamProviderCompositionDescription")}
          emptyTitle={t("noProviderTitle")}
          rows={providerBreakdown}
          totalTokens={tokens}
          providers={providers}
        />
      </div>
    </div>
  );
}
