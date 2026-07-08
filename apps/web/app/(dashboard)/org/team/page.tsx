import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { LeaderRow, OverviewStats } from "@toard/core";
import { Activity, ArrowUpDown, DollarSign, Inbox, Users } from "lucide-react";
import { UsageAreaChart } from "@/components/charts/usage-area-chart";
import { AutoRefresh } from "@/components/dashboard/auto-refresh";
import { DashboardFilters } from "@/components/dashboard/dashboard-filters";
import { MetricToggle, type ChartMetric } from "@/components/dashboard/metric-toggle";
import { PricingNotice } from "@/components/dashboard/pricing-notice";
import { StatCard } from "@/components/dashboard/stat-card";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { getPool } from "@/lib/db";
import { fmtCompact, fmtNum, fmtUsd } from "@/lib/format";
import { fillSeriesGaps, parseFilters, previousPeriod, type DashboardSearchParams } from "@/lib/period";
import { getEnabledProviders } from "@/lib/providers";
import { getDashboardViewer } from "@/lib/session-user";
import { pctDelta } from "@/lib/stat-delta";
import { getStorage } from "@/lib/storage";
import { getViewerTimezone } from "@/lib/viewer-time";

export const dynamic = "force-dynamic";

type TeamStatusSearchParams = DashboardSearchParams & { team?: string };
type TeamPeriod = ReturnType<typeof parseFilters>;
type TeamOption = { id: string; name: string };

function totalTokens(s: OverviewStats): number {
  return s.totalInputTokens + s.totalOutputTokens + s.totalCacheReadTokens + s.totalCacheCreationTokens;
}

function shareText(value: number, total: number): string {
  if (total <= 0) return "—";
  return `${Math.round((value / total) * 100)}%`;
}

function hrefWithTeam(sp: TeamStatusSearchParams, teamId: string): string {
  const q = new URLSearchParams();
  if (sp.period) q.set("period", sp.period);
  if (sp.provider) q.set("provider", sp.provider);
  if (sp.from) q.set("from", sp.from);
  if (sp.to) q.set("to", sp.to);
  if (sp.metric) q.set("metric", sp.metric);
  q.set("team", teamId);
  return `/org/team?${q.toString()}`;
}

async function listTeams(): Promise<TeamOption[]> {
  const r = await getPool().query<TeamOption>("SELECT id::text AS id, name FROM teams ORDER BY name");
  return r.rows;
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

function TeamSelector({
  sp,
  teams,
  selectedTeamId,
  title,
  description,
}: {
  sp: TeamStatusSearchParams;
  teams: TeamOption[];
  selectedTeamId: string | null;
  title: string;
  description: string;
}) {
  return (
    <div className="space-y-2">
      <div>
        <h2 className="text-sm font-medium">{title}</h2>
        <p className="text-muted-foreground text-sm">{description}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {teams.map((team) => (
          <Button key={team.id} asChild size="sm" variant={team.id === selectedTeamId ? "default" : "outline"}>
            <Link href={hrefWithTeam(sp, team.id)}>{team.name}</Link>
          </Button>
        ))}
      </div>
    </div>
  );
}

export default async function TeamStatusPage({
  searchParams,
}: {
  searchParams: Promise<TeamStatusSearchParams>;
}) {
  const sp = await searchParams;
  const [t, navT] = await Promise.all([getTranslations("org"), getTranslations("nav")]);
  const period = parseFilters(sp, await getViewerTimezone());
  const providers = await getEnabledProviders();
  const viewer = await getDashboardViewer();
  if (!viewer) redirect("/login");

  const isAdmin = viewer.role === "admin";
  const teams = isAdmin ? await listTeams() : [];
  const selectedTeam = isAdmin
    ? (teams.find((team) => team.id === sp.team) ??
      teams.find((team) => team.id === viewer.teamId) ??
      teams[0] ??
      null)
    : viewer.teamId
      ? { id: viewer.teamId, name: viewer.teamName ?? t("myTeamFallbackTitle") }
      : null;
  const title = selectedTeam ? t("myTeamTitle", { team: selectedTeam.name }) : t("myTeamFallbackTitle");

  return (
    <div className="space-y-6">
      <DashboardFilters
        providers={providers}
        timezone={period.timezone}
        title={title}
        statusBadge={{ status: "beta", label: navT("badge.beta") }}
        trailing={<AutoRefresh />}
      />

      <PricingNotice />

      {isAdmin && teams.length > 0 ? (
        <TeamSelector
          sp={sp}
          teams={teams}
          selectedTeamId={selectedTeam?.id ?? null}
          title={t("teamSelector.title")}
          description={t("teamSelector.description")}
        />
      ) : null}

      <TeamDetailOverview period={period} sp={sp} teamId={selectedTeam?.id ?? null} isAdmin={isAdmin} />
    </div>
  );
}

async function TeamDetailOverview({
  sp,
  period,
  teamId,
  isAdmin,
}: {
  sp: TeamStatusSearchParams;
  period: TeamPeriod;
  teamId: string | null;
  isAdmin: boolean;
}) {
  const t = await getTranslations("org");
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

  const metric: ChartMetric = sp.metric === "tokens" ? "tokens" : "cost";
  const storage = getStorage();
  const scoped = { ...period, teamId };
  const [overview, prevOverview, daily, members] = await Promise.all([
    storage.getOverview(scoped),
    storage.getOverview({ ...previousPeriod(period), teamId }),
    storage.getDailyTimeseries({ ...period, scope: "team", teamId }),
    storage.getLeaderboard({ ...period, scope: "user", teamId }),
  ]);
  const series = fillSeriesGaps(daily, period);
  const tokens = totalTokens(overview);
  const spark = {
    cost: series.map((d) => d.costUsd),
    sessions: series.map((d) => d.sessions),
    users: series.map((d) => d.activeUsers),
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
          delta={costDelta}
          hint={costDelta ? t(period.preset === "today" ? "vsPrevToday" : "vsPrevPeriod") : undefined}
          spark={spark.cost}
          icon={<DollarSign className="size-4" />}
        />
        <StatCard
          label={t("sessions")}
          value={fmtNum(overview.totalSessions)}
          delta={sessionsDelta}
          spark={spark.sessions}
          icon={<Activity className="size-4" />}
        />
        <StatCard
          label={t("activeUsers")}
          value={fmtNum(overview.activeUsers)}
          delta={usersDelta}
          spark={spark.users}
          icon={<Users className="size-4" />}
        />
        <StatCard
          label={t("totalTokens")}
          value={fmtCompact(tokens)}
          delta={tokensDelta}
          hint={t("tokenHint", {
            in: fmtCompact(overview.totalInputTokens),
            out: fmtCompact(overview.totalOutputTokens),
            cache: fmtCompact(overview.totalCacheReadTokens + overview.totalCacheCreationTokens),
          })}
          spark={spark.tokens}
          icon={<ArrowUpDown className="size-4" />}
        />
      </div>

      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,0.8fr)]">
        <Card className="min-w-0">
          <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <CardTitle>{t(period.bucket === "hour" ? "teamHourlyUsage" : "teamDailyUsage")}</CardTitle>
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
                  <EmptyDescription>{t("teamNoUsageDescription")}</EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </CardContent>
        </Card>

        <Card className="min-w-0 gap-4">
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
