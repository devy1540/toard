import { Fragment } from "react";
import { getLocale, getTranslations } from "next-intl/server";
import { Inbox, Laptop } from "lucide-react";
import { ModelStackedBarChart, type StackedSeries } from "@/components/charts/model-stacked-bar-chart";
import { MetricToggle, type ChartMetric } from "@/components/dashboard/metric-toggle";
import { DeltaBadge } from "@/components/dashboard/stat-card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { fmtCompact, fmtNum, fmtUsd } from "@/lib/format";
import { formatModelName } from "@/lib/model-names";
import { previousPeriod, type DashboardPeriod } from "@/lib/period";
import { pctDelta } from "@/lib/stat-delta";
import { getStorage } from "@/lib/storage";
import { cn } from "@/lib/utils";

/** 스택 시리즈로 개별 표시할 상위 모델 수 — 나머지는 '기타'로 묶는다 */
const TOP_MODELS = 3;
const OTHER_KEY = "__other__";

/** 시리즈 색 — 1위는 브랜드 원색, 이후는 배경 방향으로 페이드(라이트/다크 자동), 기타는 뉴트럴 */
const SERIES_COLORS = [
  "var(--chart-1)",
  "color-mix(in oklab, var(--brand) 55%, var(--background))",
  "color-mix(in oklab, var(--brand) 30%, var(--background))",
  "color-mix(in oklab, var(--muted-foreground) 35%, var(--background))",
];

/** 히트맵 강도 4단계 — 0 은 무활동, 1~3 은 비영(非零) 값의 삼분위 */
const HEAT_COLORS = [
  "var(--muted)",
  "color-mix(in oklab, var(--brand) 22%, var(--background))",
  "color-mix(in oklab, var(--brand) 52%, var(--background))",
  "var(--brand)",
];

/** 스탯 뷰 — 히어로 비용·모델별 스택 막대·시간대 리듬 히트맵 (toard.view=stats). */
export async function StatsView({
  userId,
  period,
  metric,
}: {
  userId: string;
  period: DashboardPeriod;
  metric: ChartMetric;
}) {
  const t = await getTranslations("dashboard");
  const locale = await getLocale();
  const storage = getStorage();
  const { overview, daily, byModel, byHost } = await storage.getUserUsage(userId, period);
  const prevOverview = await storage.getOverview({ ...previousPeriod(period), userId });
  const modelSeries = await storage.getUserModelTimeseries(userId, period);
  const hourly = await storage.getUserHourlyTimeseries(userId, period);

  if (daily.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Inbox />
          </EmptyMedia>
          <EmptyTitle>{t("noDataTitle")}</EmptyTitle>
          <EmptyDescription>{t("noMyUsageDescription")}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  // ── 히어로 ──
  const costDelta = pctDelta(overview.totalCostUsd, prevOverview.totalCostUsd);
  const diff = Math.abs(overview.totalCostUsd - prevOverview.totalCostUsd);
  const comparison =
    prevOverview.totalCostUsd > 0
      ? t(overview.totalCostUsd <= prevOverview.totalCostUsd ? "stats.lessThanPrev" : "stats.moreThanPrev", {
          prev: fmtUsd(prevOverview.totalCostUsd),
          diff: fmtUsd(diff),
        })
      : null;
  const totalTokens =
    overview.totalInputTokens +
    overview.totalOutputTokens +
    overview.totalCacheReadTokens +
    overview.totalCacheCreationTokens;
  const activeBuckets = daily.filter(
    (d) => d.costUsd > 0 || d.inputTokens + d.outputTokens + d.cacheReadTokens + d.cacheCreationTokens > 0,
  ).length;
  const topModelName = byModel[0] ? (formatModelName(byModel[0].model) ?? byModel[0].model) : null;

  // ── 스택 막대: 상위 모델 + 기타로 피벗 (표시 버킷 = 기간 버킷) ──
  const topModels = byModel.slice(0, TOP_MODELS).map((m) => m.model);
  const hasOther = byModel.length > TOP_MODELS;
  const dayLabel = (day: string): string => (period.bucket === "hour" ? day.slice(11) : day.slice(5));
  const rowMap = new Map<string, Record<string, number | string>>();
  for (const p of modelSeries) {
    const key = topModels.includes(p.model) ? p.model : OTHER_KEY;
    let row = rowMap.get(p.day);
    if (!row) {
      row = { day: dayLabel(p.day) };
      for (const m of topModels) row[m] = 0;
      if (hasOther) row[OTHER_KEY] = 0;
      rowMap.set(p.day, row);
    }
    const v = metric === "cost" ? p.costUsd : p.totalTokens;
    row[key] = Number(row[key] ?? 0) + v;
  }
  const rows = [...rowMap.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, r]) => r);
  const series: StackedSeries[] = [
    ...topModels.map((m, i) => ({ key: m, label: formatModelName(m) ?? m, color: SERIES_COLORS[i]! })),
    ...(hasOther ? [{ key: OTHER_KEY, label: t("stats.othersLabel"), color: SERIES_COLORS[3]! }] : []),
  ];

  // ── 시간대 리듬: hour 버킷 → 요일(월=0)×시간 그리드, 비영 값 삼분위로 강도 산출 ──
  const cell = new Map<string, number>();
  for (const p of hourly) {
    const v = p.inputTokens + p.outputTokens + p.cacheReadTokens + p.cacheCreationTokens;
    if (v <= 0) continue;
    const [datePart, hourPart] = p.day.split(" ");
    const [y, m, d] = datePart!.split("-").map(Number);
    const dow = (new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay() + 6) % 7; // 월요일 시작
    const key = `${dow}-${Number(hourPart!.slice(0, 2))}`;
    cell.set(key, (cell.get(key) ?? 0) + v);
  }
  const values = [...cell.values()].sort((a, b) => a - b);
  const q = (p: number): number => values[Math.min(values.length - 1, Math.floor(values.length * p))] ?? 0;
  const [t1, t2] = [q(1 / 3), q(2 / 3)];
  const levelOf = (v: number | undefined): number => (!v ? 0 : v <= t1 ? 1 : v <= t2 ? 2 : 3);
  // 요일 라벨 — 2024-01-01(월)부터 7일, 뷰어 로케일의 짧은 요일명
  const dowFmt = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" });
  const dowLabels = Array.from({ length: 7 }, (_, i) => dowFmt.format(new Date(Date.UTC(2024, 0, 1 + i))));

  // ── 분해: 모델(시리즈 색 점 매칭) + 기기 ──
  const modelCostSum = byModel.reduce((s, m) => s + m.costUsd, 0);
  const modelTokenSum = byModel.reduce((s, m) => s + m.totalTokens, 0);
  const hostCostSum = byHost.reduce((s, h) => s + h.costUsd, 0);
  const hostTokenSum = byHost.reduce((s, h) => s + h.totalTokens, 0);
  const shareOf = (cost: number, tokens: number, costSum: number, tokenSum: number): number =>
    costSum > 0 ? cost / costSum : tokenSum > 0 ? tokens / tokenSum : 0;
  const hasNamedHost = byHost.some((h) => h.host != null);

  return (
    <>
      {/* 히어로 — 기간 비용 + 직전 기간 문장형 비교 + 보조 지표 */}
      <div className="flex min-w-0 flex-wrap items-end gap-x-10 gap-y-4">
        <div className="min-w-0">
          <div className="text-muted-foreground text-xs tracking-wide uppercase">
            {t(`costLabel.${period.preset}`)}
          </div>
          <div className="flex flex-wrap items-baseline gap-3">
            <span className="text-4xl font-semibold tracking-tight tabular-nums">
              {fmtUsd(overview.totalCostUsd)}
            </span>
            {costDelta ? (
              <span className="text-xs">
                <DeltaBadge delta={costDelta} />
              </span>
            ) : null}
          </div>
          {comparison ? <div className="text-muted-foreground mt-1 text-sm">{comparison}</div> : null}
        </div>
        <div className="flex flex-wrap gap-x-8 gap-y-3 pb-1">
          <div>
            <div className="text-muted-foreground text-xs tracking-wide uppercase">{t("statSessions")}</div>
            <div className="mt-0.5 text-xl font-medium tabular-nums">{fmtNum(overview.totalSessions)}</div>
          </div>
          <div>
            <div className="text-muted-foreground text-xs tracking-wide uppercase">{t("statTokens")}</div>
            <div className="mt-0.5 text-xl font-medium tabular-nums">{fmtCompact(totalTokens)}</div>
          </div>
          <div>
            <div className="text-muted-foreground text-xs tracking-wide uppercase">
              {t(period.bucket === "hour" ? "stats.activeHours" : "stats.activeDays")}
            </div>
            <div className="mt-0.5 text-xl font-medium tabular-nums">{activeBuckets}</div>
          </div>
          {topModelName ? (
            <div className="hidden sm:block">
              <div className="text-muted-foreground text-xs tracking-wide uppercase">{t("stats.topModel")}</div>
              <div className="mt-0.5 max-w-40 truncate text-xl font-medium">{topModelName}</div>
            </div>
          ) : null}
        </div>
      </div>

      <div className="border-border border-t" />

      {/* 버킷×모델 스택 막대 — 총량 추이와 모델 구성을 한 자리에서 */}
      <div className="min-w-0">
        <div className="mb-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <span className="text-muted-foreground text-xs tracking-wide uppercase">{t("stats.byModelDaily")}</span>
          <div className="flex flex-wrap items-center gap-3 sm:gap-4">
            <div className="hidden min-w-0 flex-wrap items-center gap-4 sm:flex">
              {series.map((s) => (
                <span key={s.key} className="text-muted-foreground flex items-center gap-1.5 text-xs">
                  <span className="size-2 rounded-[3px]" style={{ background: s.color }} />
                  {s.label}
                </span>
              ))}
            </div>
            <MetricToggle value={metric} />
          </div>
        </div>
        <div className="min-w-0">
          <ModelStackedBarChart rows={rows} series={series} metric={metric} />
        </div>
      </div>

      <div className="border-border border-t" />

      <div className="grid min-w-0 gap-10 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        {/* 시간대 리듬 — 요일×시간 히트맵 (뷰어 타임존 벽시계) */}
        <div className="min-w-0">
          <div className="text-muted-foreground mb-3 text-xs tracking-wide uppercase">{t("stats.hourlyRhythm")}</div>
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
        </div>

        {/* 분해 — 모델(스택 색 점 매칭) + 기기 */}
        <div className="min-w-0">
          <div className="text-muted-foreground mb-3 text-xs tracking-wide uppercase">{t("stats.breakdown")}</div>
          <div className="space-y-1.5">
            {byModel.slice(0, TOP_MODELS + 1).map((m, i) => (
              <div key={m.model} className="flex min-w-0 items-center gap-2 text-sm">
                <span
                  className="size-2 shrink-0 rounded-[3px]"
                  style={{ background: SERIES_COLORS[Math.min(i, 3)] }}
                />
                <span className="truncate font-medium" title={m.model}>
                  {formatModelName(m.model) ?? m.model}
                </span>
                <span className="ml-auto shrink-0 font-medium tabular-nums">{fmtUsd(m.costUsd)}</span>
                <span className="text-muted-foreground w-9 text-right text-xs tabular-nums">
                  {Math.round(shareOf(m.costUsd, m.totalTokens, modelCostSum, modelTokenSum) * 100)}%
                </span>
              </div>
            ))}
            {hasNamedHost ? (
              <>
                <div className="border-border my-2 border-t" />
                {byHost.map((h) => (
                  <div key={h.host ?? "__unknown__"} className="flex min-w-0 items-center gap-2 text-sm">
                    <Laptop className="text-muted-foreground size-3.5 shrink-0" />
                    <span className={cn("truncate", h.host ? "font-medium" : "text-muted-foreground")}>
                      {h.host ?? t("unknownHost")}
                    </span>
                    <span className="ml-auto shrink-0 font-medium tabular-nums">{fmtUsd(h.costUsd)}</span>
                    <span className="text-muted-foreground w-9 text-right text-xs tabular-nums">
                      {Math.round(shareOf(h.costUsd, h.totalTokens, hostCostSum, hostTokenSum) * 100)}%
                    </span>
                  </div>
                ))}
              </>
            ) : null}
          </div>
        </div>
      </div>
    </>
  );
}
