import { Fragment } from "react";
import { getLocale, getTranslations } from "next-intl/server";
import Link from "next/link";
import { Activity, ArrowUpDown, Bot, Clock3, DollarSign, Inbox, Laptop, MessageSquare } from "lucide-react";
import { UsageAreaChart } from "@/components/charts/usage-area-chart";
import { CompositionToggle, type CompositionDimension } from "@/components/dashboard/composition-toggle";
import type { ChartMetric } from "@/components/dashboard/metric-toggle";
import { PricingNotice } from "@/components/dashboard/pricing-notice";
import { DeltaBadge } from "@/components/dashboard/stat-card";
import { ToolActivityCard } from "@/components/dashboard/tool-activity-card";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { orderByTokens, tokenShare } from "@/lib/composition";
import { fmtCompact, fmtNum, fmtUsd } from "@/lib/format";
import { formatModelName } from "@/lib/model-names";
import { fillSeriesGaps, previousPeriod, type DashboardPeriod } from "@/lib/period";
import { formatCostForCoverage, legacyCostHintCount } from "@/lib/pricing";
import { getMyHistorySessions } from "@/lib/prompt-history";
import { pctDelta } from "@/lib/stat-delta";
import { getStorage } from "@/lib/storage";
import { getActiveTokenMeta } from "@/lib/tokens";
import { cn } from "@/lib/utils";
import type { UsageCostCoverage } from "@toard/core";

function coveredCost(
  costUsd: number,
  coverage: UsageCostCoverage,
  labels: { partial: string; unpriced: string; legacy: string },
): string {
  return formatCostForCoverage(fmtUsd(costUsd), coverage, labels);
}

function ShareBar({ share }: { share: number }) {
  const pct = share > 0 ? Math.max(2, Math.round(share * 100)) : 0;
  return (
    <div className="bg-muted h-1.5 overflow-hidden rounded-full">
      <div className="bg-chart-1 h-full rounded-full" style={{ width: `${pct}%` }} />
    </div>
  );
}

function SummaryMetric({
  label,
  value,
  sub,
  badge,
  icon,
}: {
  label: string;
  value: string;
  sub?: string;
  badge?: React.ReactNode;
  icon: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className="text-muted-foreground flex items-center gap-1.5 text-xs tracking-wide uppercase">
        {icon}
        {label}
      </div>
      <div className="mt-1 flex min-w-0 flex-wrap items-baseline gap-1.5">
        <span className="truncate text-xl font-medium tabular-nums">{value}</span>
        {badge ? <span className="text-xs">{badge}</span> : null}
      </div>
      {sub ? <div className="text-muted-foreground mt-0.5 truncate text-xs">{sub}</div> : null}
    </div>
  );
}

function CompositionRow({
  name,
  hoverTitle,
  muted = false,
  tokens,
  cost,
  sessions,
  share,
  marker,
}: {
  name: string;
  hoverTitle?: string;
  muted?: boolean;
  tokens: string;
  cost: string;
  sessions: string;
  share: number;
  marker: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className="flex min-w-0 items-baseline gap-2 text-sm">
        <span className="shrink-0">{marker}</span>
        <span className={cn("truncate", muted ? "text-muted-foreground" : "font-medium")} title={hoverTitle}>
          {name}
        </span>
        <span className="ml-auto shrink-0 font-medium tabular-nums">{tokens}</span>
        <span className="text-muted-foreground w-9 shrink-0 text-right text-xs tabular-nums">
          {Math.round(share * 100)}%
        </span>
      </div>
      <div className="text-muted-foreground mt-0.5 truncate pl-5 text-xs">
        <span className="text-foreground font-medium tabular-nums">{cost}</span>
        {" · "}
        {sessions}
      </div>
      <div className="mt-1.5 pl-5">
        <ShareBar share={share} />
      </div>
    </div>
  );
}

/** 사이드 리스트가 세로로 길어지지 않게 상위 N개만 — 나머지는 개수로 요약 */
const MODELS_SHOWN = 5;
const HOSTS_SHOWN = 4;
const RECENT_SESSIONS_SHOWN = 4;

const HEAT_COLORS = [
  "var(--muted)",
  "color-mix(in oklab, var(--brand) 22%, var(--background))",
  "color-mix(in oklab, var(--brand) 52%, var(--background))",
  "var(--brand)",
];

function usageTitleKey(bucket: DashboardPeriod["bucket"]): "dailyUsage" | "hourlyUsage" | "usage30m" | "usage15m" {
  if (bucket === "day") return "dailyUsage";
  if (bucket === "hour") return "hourlyUsage";
  if (bucket === "30m") return "usage30m";
  return "usage15m";
}

/** 개요 뷰 — 요약 스트립·차트 우선·우측 구성 패널로 재정렬한 운영형 대시보드. */
export async function OverviewView({
  userId,
  period,
  metric,
  composition,
}: {
  userId: string;
  period: DashboardPeriod;
  metric: ChartMetric;
  composition: CompositionDimension;
}) {
  const t = await getTranslations("dashboard");
  const locale = await getLocale();
  const storage = getStorage();
  const [usage, prevOverview, tokenMeta, hourly, history] = await Promise.all([
    storage.getUserUsage(userId, period),
    storage.getOverview({ ...previousPeriod(period), userId }),
    getActiveTokenMeta(userId),
    storage.getUserHourlyTimeseries(userId, period),
    getMyHistorySessions(userId, period, 0, RECENT_SESSIONS_SHOWN),
  ]);
  const { overview, daily, byModel, byHost } = usage;
  const costLabels = {
    partial: t("costCoverage.partial"),
    unpriced: t("costCoverage.unpriced"),
    legacy: t("costCoverage.legacy"),
  };
  const sessionKeys = history.sessions.filter((s) => s.isSession).map((s) => s.key);
  const recentUsage =
    history.enabled && sessionKeys.length > 0 ? await storage.getSessionUsageSummaries(userId, sessionKeys) : [];
  const usageBySession = new Map(recentUsage.map((s) => [s.sessionId, s]));

  // 미설치 추정: 토큰이 없거나 한 번도 수신된 적 없음 → 빈 상태에서 설치 CTA 노출
  const notInstalled = !tokenMeta || !tokenMeta.lastUsedAt;

  const series = fillSeriesGaps(daily, period);
  const totalTokens =
    overview.totalInputTokens +
    overview.totalOutputTokens +
    overview.totalCacheReadTokens +
    overview.totalCacheCreationTokens;
  const prevTokens =
    prevOverview.totalInputTokens +
    prevOverview.totalOutputTokens +
    prevOverview.totalCacheReadTokens +
    prevOverview.totalCacheCreationTokens;
  const costDelta = overview.costCoverage.unpricedEvents === 0 && prevOverview.costCoverage.unpricedEvents === 0
    ? pctDelta(overview.totalCostUsd, prevOverview.totalCostUsd)
    : null;
  const legacyCount = legacyCostHintCount(overview.costCoverage);
  const costHint = legacyCount == null
    ? costDelta
      ? t(period.preset === "today" ? "vsPrevToday" : "vsPrevPeriod")
      : t("summaryPrimaryHint")
    : t("costCoverage.legacyHint", { count: fmtNum(legacyCount) });
  const sessionsDelta = pctDelta(overview.totalSessions, prevOverview.totalSessions);
  const tokensDelta = pctDelta(totalTokens, prevTokens);

  const modelComposition = orderByTokens(byModel);
  const hostComposition = orderByTokens(byHost);
  const topModel = modelComposition[0];
  const topModelName = topModel ? (formatModelName(topModel.model) ?? topModel.model) : "—";
  const namedHosts = hostComposition.filter((h) => h.host != null);
  const hasNamedHost = namedHosts.length > 0;
  const topHost = namedHosts[0]?.host ?? "—";
  const modelTokenSum = modelComposition.reduce((s, m) => s + m.totalTokens, 0);
  const hostTokenSum = hostComposition.reduce((s, h) => s + h.totalTokens, 0);

  const timeFmt = new Intl.DateTimeFormat(locale, {
    timeZone: period.timezone,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });

  // 시간대 리듬: hour 버킷 → 요일(월=0)×시간 그리드, 비영 값 삼분위로 강도 산출
  const cell = new Map<string, number>();
  for (const p of hourly) {
    const v = p.inputTokens + p.outputTokens + p.cacheReadTokens + p.cacheCreationTokens;
    if (v <= 0) continue;
    const [datePart, hourPart] = p.day.split(" ");
    const [y, m, d] = datePart!.split("-").map(Number);
    const dow = (new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay() + 6) % 7;
    const key = `${dow}-${Number(hourPart!.slice(0, 2))}`;
    cell.set(key, (cell.get(key) ?? 0) + v);
  }
  const values = [...cell.values()].sort((a, b) => a - b);
  const q = (p: number): number => values[Math.min(values.length - 1, Math.floor(values.length * p))] ?? 0;
  const [t1, t2] = [q(1 / 3), q(2 / 3)];
  const levelOf = (v: number | undefined): number => (!v ? 0 : v <= t1 ? 1 : v <= t2 ? 2 : 3);
  const dowFmt = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" });
  const dowLabels = Array.from({ length: 7 }, (_, i) => dowFmt.format(new Date(Date.UTC(2024, 0, 1 + i))));

  return (
    <>
      <PricingNotice coverage={overview.costCoverage} />

      <section data-dashboard-ready="user-overview" className="rounded-lg border p-4">
        <div className="grid gap-4 lg:grid-cols-5">
          <SummaryMetric
            label={t("statTokens")}
            value={fmtCompact(totalTokens)}
            sub={t("tokensHint", {
              in: fmtCompact(overview.totalInputTokens),
              out: fmtCompact(overview.totalOutputTokens),
              cache: fmtCompact(overview.totalCacheReadTokens + overview.totalCacheCreationTokens),
            })}
            badge={tokensDelta ? <DeltaBadge delta={tokensDelta} /> : undefined}
            icon={<ArrowUpDown className="size-3.5" />}
          />
          <SummaryMetric
            label={t(`costLabel.${period.preset}`)}
            value={coveredCost(overview.totalCostUsd, overview.costCoverage, costLabels)}
            sub={costHint}
            badge={costDelta ? <DeltaBadge delta={costDelta} /> : undefined}
            icon={<DollarSign className="size-3.5" />}
          />
          <SummaryMetric
            label={t("statSessions")}
            value={fmtNum(overview.totalSessions)}
            sub={t("sessionsHint")}
            badge={sessionsDelta ? <DeltaBadge delta={sessionsDelta} /> : undefined}
            icon={<Activity className="size-3.5" />}
          />
          <SummaryMetric
            label={t("topModel")}
            value={topModelName}
            sub={topModel ? t("breakdownSub", { tokens: fmtCompact(topModel.totalTokens), sessions: fmtNum(topModel.sessions) }) : undefined}
            icon={<Bot className="size-3.5" />}
          />
          <SummaryMetric label={t("topDevice")} value={topHost} icon={<Laptop className="size-3.5" />} />
        </div>
      </section>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(280px,0.9fr)]">
        <section className="min-w-0 rounded-lg border p-4">
          <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2 className="text-sm font-medium">{t("trendTitle")}</h2>
              <p className="text-muted-foreground mt-0.5 text-xs">{t(usageTitleKey(period.bucket))}</p>
            </div>
            <div className="text-muted-foreground text-xs">{metric === "cost" ? t("chart.cost") : t("chart.tokens")}</div>
          </div>
          <div className="min-w-0">
            {daily.length > 0 ? (
              <UsageAreaChart data={series} metric={metric} bucket={period.bucket} markNow={period.preset === "today"} />
            ) : notInstalled ? (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Inbox />
                  </EmptyMedia>
                  <EmptyTitle>{t("noCollectedUsageTitle")}</EmptyTitle>
                  <EmptyDescription>{t("noCollectedUsageDescription")}</EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <Button asChild size="sm">
                    <Link href="/settings?tab=install">{t("installShim")}</Link>
                  </Button>
                </EmptyContent>
              </Empty>
            ) : (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Inbox />
                  </EmptyMedia>
                  <EmptyTitle>{t("noDataTitle")}</EmptyTitle>
                  <EmptyDescription>{t("noMyUsageDescription")}</EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </div>
        </section>

        <aside className="flex min-w-0 flex-col rounded-lg border p-4 xl:sticky xl:top-4">
          <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2 className="text-sm font-medium">{t("compositionTitle")}</h2>
              <p className="text-muted-foreground mt-0.5 text-xs">
                {t(composition === "model" ? "compositionModelDescription" : "compositionDeviceDescription")}
              </p>
            </div>
            <CompositionToggle value={composition} />
          </div>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
            {composition === "model" ? (
              modelComposition.length > 0 ? (
                <>
                  {modelComposition.slice(0, MODELS_SHOWN).map((m, i) => (
                    <CompositionRow
                      key={m.model}
                      name={formatModelName(m.model) ?? m.model}
                      hoverTitle={m.model}
                      tokens={fmtCompact(m.totalTokens)}
                      cost={coveredCost(m.costUsd, m.costCoverage, costLabels)}
                      sessions={t("sessionCount", { count: fmtNum(m.sessions) })}
                      share={tokenShare(m.totalTokens, modelTokenSum)}
                      marker={<span className="bg-chart-1 inline-block size-2 rounded-[3px]" style={{ opacity: Math.max(0.35, 1 - i * 0.12) }} />}
                    />
                  ))}
                  {modelComposition.length > MODELS_SHOWN ? (
                    <div className="text-muted-foreground pl-5 text-xs">{t("moreModels", { n: modelComposition.length - MODELS_SHOWN })}</div>
                  ) : null}
                </>
              ) : (
                <div className="text-muted-foreground text-sm">{t("noModelDataTitle")}</div>
              )
            ) : hasNamedHost ? (
              <>
                {hostComposition.slice(0, HOSTS_SHOWN).map((h) => (
                  <CompositionRow
                    key={h.host ?? "__unknown__"}
                    name={h.host ?? t("unknownHost")}
                    muted={h.host == null}
                    tokens={fmtCompact(h.totalTokens)}
                    cost={coveredCost(h.costUsd, h.costCoverage, costLabels)}
                    sessions={t("sessionCount", { count: fmtNum(h.sessions) })}
                    share={tokenShare(h.totalTokens, hostTokenSum)}
                    marker={<Laptop className="text-muted-foreground size-3.5" />}
                  />
                ))}
                {hostComposition.length > HOSTS_SHOWN ? (
                  <div className="text-muted-foreground pl-5 text-xs">{t("moreDevices", { n: hostComposition.length - HOSTS_SHOWN })}</div>
                ) : null}
              </>
            ) : (
              <div className="text-muted-foreground text-sm">{t("noDeviceDataTitle")}</div>
            )}
          </div>
        </aside>
      </div>

      <ToolActivityCard userId={userId} period={period} />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
        <section className="min-w-0 rounded-lg border p-4">
          <div className="mb-3">
            <h2 className="text-sm font-medium">{t("rhythmTitle")}</h2>
            <p className="text-muted-foreground mt-0.5 text-xs">{t("rhythmDescription")}</p>
          </div>
          <div className="overflow-x-auto pb-1">
            <div className="min-w-[360px]">
              <div className="grid grid-cols-[minmax(24px,auto)_repeat(24,1fr)] items-center gap-[3px]">
                {Array.from({ length: 7 }, (_, dow) => (
                  <Fragment key={dow}>
                    <span className="text-muted-foreground pr-1 text-[10px]">{dowLabels[dow]}</span>
                    {Array.from({ length: 24 }, (_, h) => (
                      <span
                        key={h}
                        title={`${dowLabels[dow]} ${String(h).padStart(2, "0")}:00 — ${fmtCompact(cell.get(`${dow}-${h}`) ?? 0)}`}
                        className="h-3.5 rounded-[3px]"
                        style={{ background: HEAT_COLORS[levelOf(cell.get(`${dow}-${h}`))] }}
                      />
                    ))}
                  </Fragment>
                ))}
              </div>
              <div className="text-muted-foreground mt-1.5 flex justify-between pl-7 text-[10px]">
                <span>0</span>
                <span>6</span>
                <span>12</span>
                <span>18</span>
                <span>23</span>
              </div>
            </div>
          </div>
        </section>

        <section className="min-w-0 rounded-lg border p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-medium">{t("recentSessionsTitle")}</h2>
              <p className="text-muted-foreground mt-0.5 text-xs">{t("recentSessionsDescription")}</p>
            </div>
            <Button asChild variant="ghost" size="sm">
              <Link href="/history">{t("viewHistory")}</Link>
            </Button>
          </div>

          {!history.enabled ? (
            <div className="text-muted-foreground rounded-md border border-dashed p-4 text-sm">
              {t("recentSessionsUnavailable")}
            </div>
          ) : history.sessions.length === 0 ? (
            <div className="text-muted-foreground rounded-md border border-dashed p-4 text-sm">{t("noRecentSessions")}</div>
          ) : (
            <div className="space-y-2">
              {history.sessions.map((s) => {
                const u = usageBySession.get(s.key);
                const model = u?.models[0] ? (formatModelName(u.models[0]) ?? u.models[0]) : s.providerKey;
                const cost = u
                  ? formatCostForCoverage(fmtUsd(u.costUsd), u.costCoverage, costLabels)
                  : t("history.noUsage");
                return (
                  <Link
                    key={s.key}
                    href={`/history?session=${encodeURIComponent(s.key)}`}
                    className="hover:bg-muted/60 block min-w-0 rounded-md border p-3 transition-colors"
                  >
                    <div className="flex min-w-0 items-center gap-2 text-sm">
                      <MessageSquare className="text-muted-foreground size-3.5 shrink-0" />
                      <span className="truncate font-medium">{s.preview || model}</span>
                      <span className="ml-auto shrink-0 font-medium tabular-nums">{cost}</span>
                    </div>
                    <div className="text-muted-foreground mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                      <span>{model}</span>
                      <span>·</span>
                      <span>{t("history.turns", { count: s.turnCount })}</span>
                      <span>·</span>
                      <span className="inline-flex items-center gap-1 tabular-nums">
                        <Clock3 className="size-3" />
                        {timeFmt.format(s.latestTs)}
                      </span>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </>
  );
}
