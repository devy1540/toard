import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import type { LeaderRow, OverviewStats } from "@toard/core";
import { Activity, ArrowUpDown, Building2, DollarSign, Inbox, TrendingDown, TrendingUp, Trophy, Users } from "lucide-react";
import { UsageAreaChart } from "@/components/charts/usage-area-chart";
import { AutoRefresh } from "@/components/dashboard/auto-refresh";
import { DashboardFilters } from "@/components/dashboard/dashboard-filters";
import { MetricToggle, type ChartMetric } from "@/components/dashboard/metric-toggle";
import { PricingNotice } from "@/components/dashboard/pricing-notice";
import { StatCard } from "@/components/dashboard/stat-card";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { fmtCompact, fmtNum, fmtUsd } from "@/lib/format";
import { fillSeriesGaps, parseFilters, previousPeriod, type DashboardSearchParams } from "@/lib/period";
import { getEnabledProviders } from "@/lib/providers";
import { getDashboardViewer } from "@/lib/session-user";
import { pctDelta } from "@/lib/stat-delta";
import { getStorage } from "@/lib/storage";
import { cn } from "@/lib/utils";
import { getViewerTimezone } from "@/lib/viewer-time";

export const dynamic = "force-dynamic";

type OrgSearchParams = DashboardSearchParams & { tab?: string; scope?: string };
type OrgPeriod = ReturnType<typeof parseFilters>;
const costLabelKey = {
  today: "costLabel.today",
  week: "costLabel.week",
  month: "costLabel.month",
  quarter: "costLabel.quarter",
  year: "costLabel.year",
  "7": "costLabel.7",
  "30": "costLabel.30",
  "90": "costLabel.90",
  custom: "costLabel.custom",
  all: "costLabel.all",
} as const;

function totalTokens(s: OverviewStats): number {
  return s.totalInputTokens + s.totalOutputTokens + s.totalCacheReadTokens + s.totalCacheCreationTokens;
}

function safeAverage(total: number, count: number): string {
  return count > 0 ? fmtUsd(total / count) : "—";
}

function RankRow({
  row,
  rank,
  totalCost,
  maxCost,
}: {
  row: LeaderRow;
  rank: number;
  totalCost: number;
  maxCost: number;
}) {
  const width = maxCost > 0 ? Math.max(3, Math.round((row.costUsd / maxCost) * 100)) : 0;
  const share = totalCost > 0 ? Math.round((row.costUsd / totalCost) * 100) : null;

  return (
    <div className="space-y-1.5">
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <span className="text-muted-foreground w-5 shrink-0 text-right tabular-nums">{rank}</span>
        <span className="truncate font-medium" title={row.label}>
          {row.label}
        </span>
        <span className="ml-auto shrink-0 font-medium tabular-nums">{fmtUsd(row.costUsd)}</span>
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
  actionLabel,
  rows,
  totalCost,
  href,
  icon,
}: {
  title: string;
  description: string;
  emptyTitle: string;
  actionLabel?: string;
  rows: LeaderRow[];
  totalCost: number;
  href?: string;
  icon: ReactNode;
}) {
  const shown = rows.slice(0, 5);
  const maxCost = shown[0]?.costUsd ?? 0;

  return (
    <Card className="gap-4">
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2 text-base">
            {icon}
            {title}
          </CardTitle>
          <CardDescription>{description}</CardDescription>
        </div>
        {href && actionLabel ? (
          <Button asChild variant="ghost" size="sm" className="text-muted-foreground -my-1 shrink-0">
            <Link href={href}>{actionLabel}</Link>
          </Button>
        ) : null}
      </CardHeader>
      <CardContent>
        {shown.length > 0 ? (
          <div className="space-y-4">
            {shown.map((row, i) => (
              <RankRow key={row.key} row={row} rank={i + 1} totalCost={totalCost} maxCost={maxCost} />
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
    <Card className="gap-4">
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

function OrgHero({
  overview,
  prevOverview,
  costLabel,
  comparison,
  activeUsersLabel,
  activeUsersSub,
  avgPerUserLabel,
  avgPerSessionLabel,
  topUserSub,
  topTeamSub,
}: {
  overview: OverviewStats;
  prevOverview: OverviewStats;
  costLabel: string;
  comparison: string;
  activeUsersLabel: string;
  activeUsersSub: string;
  avgPerUserLabel: string;
  avgPerSessionLabel: string;
  topUserSub: string;
  topTeamSub: string;
}) {
  const delta = pctDelta(overview.totalCostUsd, prevOverview.totalCostUsd);

  return (
    <section className="border-border/80 bg-card rounded-xl border px-5 py-5">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div className="min-w-0">
          <div className="text-muted-foreground text-xs tracking-wide uppercase">{costLabel}</div>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <span className="text-4xl font-semibold tracking-tight tabular-nums">{fmtUsd(overview.totalCostUsd)}</span>
            {delta ? (
              <span
                className={cn(
                  "inline-flex items-center gap-0.5 rounded-full px-1.5 py-px text-xs font-medium",
                  delta.direction === "down"
                    ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                    : "bg-red-500/10 text-red-600 dark:text-red-400",
                )}
              >
                {delta.direction === "down" ? <TrendingDown className="size-3" /> : <TrendingUp className="size-3" />}
                {delta.pct}
              </span>
            ) : null}
          </div>
          <p className="text-muted-foreground mt-1 text-sm">{comparison}</p>
        </div>

        <div className="grid w-full gap-4 sm:grid-cols-3 lg:w-auto lg:min-w-[520px]">
          <SummaryTile label={activeUsersLabel} value={fmtNum(overview.activeUsers)} sub={activeUsersSub} />
          <SummaryTile
            label={avgPerUserLabel}
            value={safeAverage(overview.totalCostUsd, overview.activeUsers)}
            sub={topUserSub}
          />
          <SummaryTile
            label={avgPerSessionLabel}
            value={safeAverage(overview.totalCostUsd, overview.totalSessions)}
            sub={topTeamSub}
          />
        </div>
      </div>
    </section>
  );
}

/** 필터(period·provider·커스텀 범위)를 유지한 채 tab/scope 만 바꾼 href 생성 */
function hrefWith(sp: OrgSearchParams, path = "/org"): string {
  const q = new URLSearchParams();
  if (sp.period) q.set("period", sp.period);
  if (sp.provider) q.set("provider", sp.provider);
  if (sp.from) q.set("from", sp.from);
  if (sp.to) q.set("to", sp.to);
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
  if (sp.tab === "ranking") redirect(legacyRankingHref(sp));
  const period = parseFilters(sp, await getViewerTimezone());
  const providers = await getEnabledProviders();
  const viewer = await getDashboardViewer();
  const canSeeTeamRanking = viewer?.role === "admin";

  return (
    <div className="space-y-6">
      <DashboardFilters
        providers={providers}
        timezone={period.timezone}
        title={t("title")}
        statusBadge={{ status: "beta", label: navT("badge.beta") }}
        trailing={<AutoRefresh />}
      />

      <PricingNotice />

      <OverviewTab sp={sp} period={period} canSeeTeamRanking={canSeeTeamRanking} />
    </div>
  );
}

async function OverviewTab({
  sp,
  period,
  canSeeTeamRanking,
}: {
  sp: OrgSearchParams;
  period: OrgPeriod;
  canSeeTeamRanking: boolean;
}) {
  const t = await getTranslations("org");
  const metric: ChartMetric = sp.metric === "tokens" ? "tokens" : "cost";
  const storage = getStorage();
  const [overview, prevOverview, daily, topUsers, topTeams] = await Promise.all([
    storage.getOverview(period),
    storage.getOverview(previousPeriod(period)),
    storage.getDailyTimeseries(period),
    storage.getLeaderboard({ ...period, scope: "user" }),
    canSeeTeamRanking ? storage.getLeaderboard({ ...period, scope: "team" }) : Promise.resolve([]),
  ]);

  // 차트·스파크라인이 같은 시리즈를 공유 — 내 사용량과 동형 (추가 조회 없음)
  const series = fillSeriesGaps(daily, period);
  const tokens = totalTokens(overview);
  const spark = {
    cost: series.map((d) => d.costUsd),
    sessions: series.map((d) => d.sessions),
    tokens: series.map((d) => d.inputTokens + d.outputTokens + d.cacheReadTokens + d.cacheCreationTokens),
  };
  const costDelta = pctDelta(overview.totalCostUsd, prevOverview.totalCostUsd);
  const sessionsDelta = pctDelta(overview.totalSessions, prevOverview.totalSessions);
  const usersDelta = pctDelta(overview.activeUsers, prevOverview.activeUsers);
  const tokensDelta = pctDelta(
    totalTokens(overview),
    totalTokens(prevOverview),
  );
  const costDiff = Math.abs(overview.totalCostUsd - prevOverview.totalCostUsd);
  const heroComparison =
    prevOverview.totalCostUsd > 0
      ? t(overview.totalCostUsd <= prevOverview.totalCostUsd ? "hero.lessThanPrev" : "hero.moreThanPrev", {
          prev: fmtUsd(prevOverview.totalCostUsd),
          diff: fmtUsd(costDiff),
        })
      : t("hero.noComparison");

  return (
    <div className="space-y-6">
      <OrgHero
        overview={overview}
        prevOverview={prevOverview}
        costLabel={t(costLabelKey[period.preset])}
        comparison={heroComparison}
        activeUsersLabel={t("hero.activeUsers")}
        activeUsersSub={t("hero.activeUsersSub")}
        avgPerUserLabel={t("hero.avgPerUser")}
        avgPerSessionLabel={t("hero.avgPerSession")}
        topUserSub={topUsers[0] ? t("hero.topUser", { name: topUsers[0].label }) : t("hero.noTopUser")}
        topTeamSub={
          canSeeTeamRanking
            ? topTeams[0]
              ? t("hero.topTeam", { name: topTeams[0].label })
              : t("hero.noTopTeam")
            : t("hero.teamRestricted")
        }
      />

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
          delta={sessionsDelta ? { ...sessionsDelta, tone: "directional" } : null}
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
          delta={tokensDelta ? { ...tokensDelta, tone: "directional" } : null}
          hint={t("tokenHint", {
            in: fmtCompact(overview.totalInputTokens),
            out: fmtCompact(overview.totalOutputTokens),
            cache: fmtCompact(overview.totalCacheReadTokens + overview.totalCacheCreationTokens),
          })}
          spark={spark.tokens}
          icon={<ArrowUpDown className="size-4" />}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(320px,0.8fr)]">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>{t(period.bucket === "hour" ? "hourlyUsage" : "dailyUsage")}</CardTitle>
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
          totalCost={overview.totalCostUsd}
          icon={<Users className="text-muted-foreground size-4" />}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {canSeeTeamRanking ? (
          <LeaderboardPreview
            title={t("topTeams")}
            description={t("topTeamsDescription")}
            emptyTitle={t("noTeamsTitle")}
            actionLabel={t("openRanking")}
            rows={topTeams}
            totalCost={overview.totalCostUsd}
            href={hrefWith(sp, "/org/teams")}
            icon={<Building2 className="text-muted-foreground size-4" />}
          />
        ) : (
          <TeamAccessCard
            title={t("teamAccess.title")}
            description={t("teamAccess.memberDescription")}
            actionLabel={t("teamAccess.openMyTeam")}
            href={hrefWith(sp, "/org/team")}
          />
        )}
        <Card className="gap-4">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Trophy className="text-muted-foreground size-4" />
              {t("workspaceSignals")}
            </CardTitle>
            <CardDescription>{t("workspaceSignalsDescription")}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-1 xl:grid-cols-3">
              <SummaryTile label={t("signal.totalSessions")} value={fmtNum(overview.totalSessions)} sub={t("signal.totalSessionsSub")} />
              <SummaryTile label={t("signal.totalTokens")} value={fmtCompact(tokens)} sub={t("signal.totalTokensSub")} />
              <SummaryTile
                label={t("signal.leaders")}
                value={topUsers.length > 0 ? fmtNum(topUsers.length) : "0"}
                sub={
                  canSeeTeamRanking
                    ? topTeams.length > 0
                      ? t("signal.teamLeaders", { count: topTeams.length })
                      : t("signal.noTeamLeaders")
                    : t("signal.teamRestricted")
                }
              />
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
