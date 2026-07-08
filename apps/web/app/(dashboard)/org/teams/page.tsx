import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import type { LeaderRow, OverviewStats } from "@toard/core";
import { Activity, ArrowUpDown, DollarSign, Inbox, TrendingUp, Trophy, Users } from "lucide-react";
import { LeaderboardBarChart } from "@/components/charts/leaderboard-bar-chart";
import { UsageAreaChart } from "@/components/charts/usage-area-chart";
import { AutoRefresh } from "@/components/dashboard/auto-refresh";
import { DashboardFilters } from "@/components/dashboard/dashboard-filters";
import { MetricToggle, type ChartMetric } from "@/components/dashboard/metric-toggle";
import { PricingNotice } from "@/components/dashboard/pricing-notice";
import { StatCard } from "@/components/dashboard/stat-card";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { fmtCompact, fmtNum, fmtUsd } from "@/lib/format";
import { fillSeriesGaps, parseFilters, previousPeriod, type DashboardSearchParams } from "@/lib/period";
import { getEnabledProviders } from "@/lib/providers";
import { getDashboardViewer, type SessionUser } from "@/lib/session-user";
import { pctDelta } from "@/lib/stat-delta";
import { getStorage } from "@/lib/storage";
import { cn } from "@/lib/utils";
import { getViewerTimezone } from "@/lib/viewer-time";

export const dynamic = "force-dynamic";

type TeamPeriod = ReturnType<typeof parseFilters>;

function totalTokens(s: OverviewStats): number {
  return s.totalInputTokens + s.totalOutputTokens + s.totalCacheReadTokens + s.totalCacheCreationTokens;
}

function SummaryTile({
  label,
  value,
  sub,
  icon,
}: {
  label: string;
  value: string;
  sub?: string;
  icon?: ReactNode;
}) {
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

function sharePct(value: number, total: number): number | null {
  if (total <= 0) return null;
  return Math.round((value / total) * 100);
}

function shareText(value: number, total: number): string {
  const share = sharePct(value, total);
  return share == null ? "—" : `${share}%`;
}

function PodiumCard({
  row,
  rank,
  totalCost,
  totalTokens,
  sessionsLabel,
  tokensLabel,
}: {
  row: LeaderRow;
  rank: number;
  totalCost: number;
  totalTokens: number;
  sessionsLabel: string;
  tokensLabel: string;
}) {
  return (
    <div
      className={cn(
        "border-border bg-background min-w-0 rounded-lg border p-4",
        rank === 1 && "border-primary/40 bg-primary/5",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-muted-foreground text-xs font-medium">#{rank}</div>
          <div className="mt-1 truncate text-lg font-semibold" title={row.label}>
            {row.label}
          </div>
        </div>
        <div className="text-right">
          <div className="font-semibold tabular-nums">{fmtUsd(row.costUsd)}</div>
          <div className="text-muted-foreground text-xs tabular-nums">{shareText(row.costUsd, totalCost)}</div>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
        <div>
          <div className="text-muted-foreground text-xs">{sessionsLabel}</div>
          <div className="font-medium tabular-nums">{fmtNum(row.sessions)}</div>
        </div>
        <div>
          <div className="text-muted-foreground text-xs">{tokensLabel}</div>
          <div className="font-medium tabular-nums">{fmtCompact(row.totalTokens)}</div>
        </div>
      </div>
      <div className="bg-muted mt-4 h-1.5 overflow-hidden rounded-full">
        <div
          className="bg-chart-1 h-full rounded-full"
          style={{ width: `${totalTokens > 0 ? Math.max(3, Math.round((row.totalTokens / totalTokens) * 100)) : 0}%` }}
        />
      </div>
    </div>
  );
}

function RankingListRow({
  row,
  rank,
  totalCost,
  maxCost,
  sessionsLabel,
  tokensLabel,
  costShareLabel,
}: {
  row: LeaderRow;
  rank: number;
  totalCost: number;
  maxCost: number;
  sessionsLabel: string;
  tokensLabel: string;
  costShareLabel: string;
}) {
  const width = maxCost > 0 ? Math.max(3, Math.round((row.costUsd / maxCost) * 100)) : 0;

  return (
    <div className="border-border/80 bg-background rounded-lg border p-3">
      <div className="grid min-w-0 gap-3 sm:grid-cols-[2rem_minmax(0,1fr)_auto] sm:items-center">
        <div className="text-muted-foreground text-sm tabular-nums">#{rank}</div>
        <div className="min-w-0">
          <div className="truncate font-medium" title={row.label}>
            {row.label}
          </div>
          <div className="text-muted-foreground mt-0.5 flex flex-wrap gap-x-3 gap-y-1 text-xs">
            <span>
              {sessionsLabel}: {fmtNum(row.sessions)}
            </span>
            <span>
              {tokensLabel}: {fmtCompact(row.totalTokens)}
            </span>
          </div>
        </div>
        <div className="sm:text-right">
          <div className="font-semibold tabular-nums">{fmtUsd(row.costUsd)}</div>
          <div className="text-muted-foreground text-xs tabular-nums">
            {costShareLabel}: {shareText(row.costUsd, totalCost)}
          </div>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <div className="bg-muted h-1.5 min-w-0 flex-1 overflow-hidden rounded-full">
          <div className="bg-chart-1 h-full rounded-full" style={{ width: `${width}%` }} />
        </div>
      </div>
    </div>
  );
}

export default async function TeamUsagePage({
  searchParams,
}: {
  searchParams: Promise<DashboardSearchParams>;
}) {
  const sp = await searchParams;
  const t = await getTranslations("org");
  const period = parseFilters(sp, await getViewerTimezone());
  const providers = await getEnabledProviders();
  const viewer = await getDashboardViewer();
  if (!viewer) redirect("/login");

  const isAdmin = viewer.role === "admin";
  const title = isAdmin
    ? t("teamsTitle")
    : viewer.teamName
      ? t("myTeamTitle", { team: viewer.teamName })
      : t("myTeamFallbackTitle");

  return (
    <div className="space-y-6">
      <DashboardFilters
        providers={providers}
        timezone={period.timezone}
        title={title}
        trailing={<AutoRefresh />}
      />

      <PricingNotice />

      {isAdmin ? <AllTeamsOverview period={period} /> : <MemberTeamOverview sp={sp} period={period} viewer={viewer} />}
    </div>
  );
}

async function AllTeamsOverview({ period }: { period: TeamPeriod }) {
  const t = await getTranslations("org");
  const rows = await getStorage().getLeaderboard({ ...period, scope: "team" });
  const scopeLabel = t("scope.team");
  const rankedCost = rows.reduce((sum, row) => sum + row.costUsd, 0);
  const rankedTokens = rows.reduce((sum, row) => sum + row.totalTokens, 0);
  const rankedSessions = rows.reduce((sum, row) => sum + row.sessions, 0);
  const maxCost = rows[0]?.costUsd ?? 0;
  const topRows = rows.slice(0, 3);

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryTile
          label={t("ranking.totalCost")}
          value={fmtUsd(rankedCost)}
          sub={t("ranking.totalCostSub", { scope: scopeLabel })}
          icon={<DollarSign className="size-3.5" />}
        />
        <SummaryTile
          label={t("ranking.rankCount")}
          value={fmtNum(rows.length)}
          sub={t("ranking.rankCountSub", { scope: scopeLabel })}
          icon={<Trophy className="size-3.5" />}
        />
        <SummaryTile
          label={t("ranking.totalSessions")}
          value={fmtNum(rankedSessions)}
          sub={t("ranking.totalSessionsSub")}
          icon={<Activity className="size-3.5" />}
        />
        <SummaryTile
          label={t("ranking.topShare")}
          value={rows[0] ? shareText(rows[0].costUsd, rankedCost) : "—"}
          sub={rows[0] ? t("ranking.topShareSub", { name: rows[0].label }) : t("ranking.noLeader")}
          icon={<TrendingUp className="size-3.5" />}
        />
      </div>

      {rows.length > 0 ? (
        <>
          <div className="grid gap-4 2xl:grid-cols-[minmax(0,1fr)_minmax(320px,0.72fr)]">
            <Card className="gap-4">
              <CardHeader>
                <CardTitle>{t("ranking.podiumTitle", { scope: scopeLabel })}</CardTitle>
                <CardDescription>{t("ranking.podiumDescription")}</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid gap-3 lg:grid-cols-3">
                  {topRows.map((row, i) => (
                    <PodiumCard
                      key={row.key}
                      row={row}
                      rank={i + 1}
                      totalCost={rankedCost}
                      totalTokens={rankedTokens}
                      sessionsLabel={t("sessionsCol")}
                      tokensLabel={t("tokensCol")}
                    />
                  ))}
                </div>
              </CardContent>
            </Card>

            <Card className="gap-4">
              <CardHeader>
                <CardTitle>{t("ranking.distributionTitle")}</CardTitle>
                <CardDescription>{t("ranking.distributionDescription")}</CardDescription>
              </CardHeader>
              <CardContent>
                <LeaderboardBarChart data={rows} />
              </CardContent>
            </Card>
          </div>

          <Card className="gap-4">
            <CardHeader>
              <CardTitle>{t("ranking.detailTitle", { scope: scopeLabel })}</CardTitle>
              <CardDescription>{t("ranking.detailDescription")}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {rows.map((row, i) => (
                  <RankingListRow
                    key={row.key}
                    row={row}
                    rank={i + 1}
                    totalCost={rankedCost}
                    maxCost={maxCost}
                    sessionsLabel={t("sessionsCol")}
                    tokensLabel={t("tokensCol")}
                    costShareLabel={t("ranking.costShare")}
                  />
                ))}
              </div>
            </CardContent>
          </Card>
        </>
      ) : (
        <Card>
          <CardContent>
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Inbox />
                </EmptyMedia>
                <EmptyTitle>{t("noDataTitle")}</EmptyTitle>
                <EmptyDescription>{t("noScopeUsageDescription", { scope: scopeLabel })}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          </CardContent>
        </Card>
      )}
    </>
  );
}

async function MemberTeamOverview({
  sp,
  period,
  viewer,
}: {
  sp: DashboardSearchParams;
  period: TeamPeriod;
  viewer: SessionUser;
}) {
  const t = await getTranslations("org");
  if (!viewer.teamId) {
    return (
      <Card>
        <CardContent>
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Users />
              </EmptyMedia>
              <EmptyTitle>{t("teamAccess.unassignedTitle")}</EmptyTitle>
              <EmptyDescription>{t("teamAccess.unassignedDescription")}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </CardContent>
      </Card>
    );
  }

  const metric: ChartMetric = sp.metric === "tokens" ? "tokens" : "cost";
  const storage = getStorage();
  const scoped = { ...period, teamId: viewer.teamId };
  const [overview, prevOverview, daily, members] = await Promise.all([
    storage.getOverview(scoped),
    storage.getOverview({ ...previousPeriod(period), teamId: viewer.teamId }),
    storage.getDailyTimeseries({ ...period, scope: "team", teamId: viewer.teamId }),
    storage.getLeaderboard({ ...period, scope: "user", teamId: viewer.teamId }),
  ]);
  const series = fillSeriesGaps(daily, period);
  const tokens = totalTokens(overview);
  const spark = {
    cost: series.map((d) => d.costUsd),
    sessions: series.map((d) => d.sessions),
    tokens: series.map((d) => d.inputTokens + d.outputTokens + d.cacheReadTokens + d.cacheCreationTokens),
  };
  const maxCost = members[0]?.costUsd ?? 0;
  const costDelta = pctDelta(overview.totalCostUsd, prevOverview.totalCostUsd);
  const sessionsDelta = pctDelta(overview.totalSessions, prevOverview.totalSessions);
  const usersDelta = pctDelta(overview.activeUsers, prevOverview.activeUsers);
  const tokensDelta = pctDelta(tokens, totalTokens(prevOverview));

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label={t("totalCost")}
          value={fmtUsd(overview.totalCostUsd)}
          delta={costDelta ? { ...costDelta, tone: "colored" } : null}
          hint={costDelta ? t(period.preset === "today" ? "vsPrevToday" : "vsPrevPeriod") : undefined}
          spark={spark.cost}
          sparkAccent
          icon={<DollarSign className="size-4" />}
        />
        <StatCard
          label={t("sessions")}
          value={fmtNum(overview.totalSessions)}
          delta={sessionsDelta ? { ...sessionsDelta, tone: "neutral" } : null}
          spark={spark.sessions}
          icon={<Activity className="size-4" />}
        />
        <StatCard
          label={t("activeUsers")}
          value={fmtNum(overview.activeUsers)}
          delta={usersDelta ? { ...usersDelta, tone: "neutral" } : null}
          icon={<Users className="size-4" />}
        />
        <StatCard
          label={t("totalTokens")}
          value={fmtCompact(tokens)}
          delta={tokensDelta ? { ...tokensDelta, tone: "neutral" } : null}
          hint={t("tokenHint", {
            in: fmtCompact(overview.totalInputTokens),
            out: fmtCompact(overview.totalOutputTokens),
            cache: fmtCompact(overview.totalCacheReadTokens + overview.totalCacheCreationTokens),
          })}
          spark={spark.tokens}
          icon={<ArrowUpDown className="size-4" />}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(320px,0.8fr)]">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>{t(period.bucket === "hour" ? "teamHourlyUsage" : "teamDailyUsage")}</CardTitle>
            <MetricToggle value={metric} />
          </CardHeader>
          <CardContent>
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
                  <EmptyDescription>{t("teamNoUsageDescription")}</EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </CardContent>
        </Card>

        <Card className="gap-4">
          <CardHeader>
            <CardTitle>{t("teamMembers")}</CardTitle>
            <CardDescription>{t("teamMembersDescription")}</CardDescription>
          </CardHeader>
          <CardContent>
            {members.length > 0 ? (
              <div className="space-y-3">
                {members.slice(0, 8).map((row, i) => (
                  <RankingListRow
                    key={row.key}
                    row={row}
                    rank={i + 1}
                    totalCost={overview.totalCostUsd}
                    maxCost={maxCost}
                    sessionsLabel={t("sessionsCol")}
                    tokensLabel={t("tokensCol")}
                    costShareLabel={t("ranking.costShare")}
                  />
                ))}
              </div>
            ) : (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Inbox />
                  </EmptyMedia>
                  <EmptyTitle>{t("teamNoMembersTitle")}</EmptyTitle>
                  <EmptyDescription>{t("teamNoUsageDescription")}</EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
