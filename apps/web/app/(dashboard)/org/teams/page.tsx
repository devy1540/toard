import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import type { LeaderRow } from "@toard/core";
import { Activity, DollarSign, Inbox, TrendingUp, Trophy } from "lucide-react";
import { LeaderboardBarChart } from "@/components/charts/leaderboard-bar-chart";
import { AutoRefresh } from "@/components/dashboard/auto-refresh";
import { DashboardFilters } from "@/components/dashboard/dashboard-filters";
import { PricingNotice } from "@/components/dashboard/pricing-notice";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { fmtCompact, fmtNum, fmtUsd } from "@/lib/format";
import { parseDashboardPeriod, type DashboardSearchParams } from "@/lib/period";
import { getEnabledProviders } from "@/lib/providers";
import { getDashboardViewer } from "@/lib/session-user";
import { getStorage } from "@/lib/storage";
import { cn } from "@/lib/utils";
import { getViewerTimezone } from "@/lib/viewer-time";

export const dynamic = "force-dynamic";

type TeamPeriod = ReturnType<typeof parseDashboardPeriod>;

function hrefWith(sp: DashboardSearchParams, path = "/org/team"): string {
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
  const period = parseDashboardPeriod(sp, await getViewerTimezone());
  const providers = await getEnabledProviders();
  const viewer = await getDashboardViewer();
  if (!viewer) redirect("/login");

  const isAdmin = viewer.role === "admin";
  if (!isAdmin) redirect(hrefWith(sp, "/org/team"));

  return (
    <div className="space-y-6">
      <DashboardFilters
        providers={providers}
        timezone={period.timezone}
        limited={period.limited}
        title={t("teamsTitle")}
        trailing={<AutoRefresh />}
      />

      <PricingNotice />

      <AllTeamsOverview period={period} />
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
          <div className="grid min-w-0 gap-4 2xl:grid-cols-[minmax(0,1fr)_minmax(0,0.72fr)]">
            <Card className="min-w-0 gap-4">
              <CardHeader>
                <CardTitle>{t("ranking.podiumTitle", { scope: scopeLabel })}</CardTitle>
                <CardDescription>{t("ranking.podiumDescription")}</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid min-w-0 gap-3 lg:grid-cols-3">
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

            <Card className="min-w-0 gap-4">
              <CardHeader>
                <CardTitle>{t("ranking.distributionTitle")}</CardTitle>
                <CardDescription>{t("ranking.distributionDescription")}</CardDescription>
              </CardHeader>
              <CardContent className="min-w-0">
                <LeaderboardBarChart data={rows} />
              </CardContent>
            </Card>
          </div>

          <Card className="min-w-0 gap-4">
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
        <Card className="min-w-0">
          <CardContent className="min-w-0">
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
