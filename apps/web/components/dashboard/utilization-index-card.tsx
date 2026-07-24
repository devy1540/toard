import type { UtilizationDimensionResult, UtilizationReason } from "@toard/core";
import { getFormatter, getTranslations } from "next-intl/server";
import { FeatureStatusBadge } from "@/components/dashboard/feature-status-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import type { PersonalUtilizationHistoryPoint, PersonalUtilizationView } from "@/lib/ai-utilization";
import { getOrgTimezone } from "@/lib/org-time";

type Formatter = Awaited<ReturnType<typeof getFormatter>>;

const TREND_WEEK_COUNT = 12;
const MIN_TREND_WEEKS = 3;

function percent(value: number | null, format: Formatter): string {
  return value == null
    ? "—"
    : format.number(value, { style: "percent", maximumFractionDigits: 0 });
}

function scoreState(score: number | null): "above" | "usual" | "below" | "unavailable" {
  if (score == null) return "unavailable";
  if (score > 55) return "above";
  if (score < 45) return "below";
  return "usual";
}

function UtilizationTrend({
  history,
  format,
  label,
  unavailable,
  timezone,
}: {
  history: PersonalUtilizationHistoryPoint[];
  format: Formatter;
  label: string;
  unavailable: string;
  timezone: string;
}) {
  const width = 440;
  const height = 120;
  const padding = 10;
  const plotWidth = width - padding * 2;
  const plotHeight = height - padding * 2;
  const points = history.map((point, index) => {
    if (point.score == null) return null;
    return {
      x: history.length === 1 ? width / 2 : padding + (index * plotWidth) / (history.length - 1),
      y: padding + ((100 - point.score) / 100) * plotHeight,
      score: point.score,
    };
  });

  return (
    <div>
      <svg className="h-24 w-full" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
        <line
          x1={padding}
          x2={width - padding}
          y1={padding + plotHeight / 2}
          y2={padding + plotHeight / 2}
          className="stroke-border"
          strokeDasharray="4 4"
        />
        {points.slice(1).map((point, index) => {
          const previous = points[index];
          if (!point || !previous) return null;
          return (
            <line
              key={`line-${index}`}
              x1={previous.x}
              y1={previous.y}
              x2={point.x}
              y2={point.y}
              className="stroke-chart-1"
              strokeWidth="2.5"
              strokeLinecap="round"
            />
          );
        })}
        {points.map((point, index) => point ? (
          <circle
            key={`point-${index}`}
            cx={point.x}
            cy={point.y}
            r={index === points.length - 1 ? 4 : 3}
            className="fill-chart-1"
          />
        ) : null)}
      </svg>
      <ul className="sr-only">
        {history.map((point) => (
          <li key={point.currentPeriod.to.toISOString()}>
            {format.dateTime(new Date(point.currentPeriod.to.getTime() - 1), {
              month: "short",
              day: "numeric",
              timeZone: timezone,
            })}: {point.score == null ? unavailable : format.number(point.score)}
          </li>
        ))}
      </ul>
    </div>
  );
}

function RelativeScale({ score, label, selfBaseline }: {
  score: number | null;
  label: string;
  selfBaseline: string;
}) {
  const markerPosition = score == null ? null : Math.min(98, Math.max(2, score));

  return (
    <div className="mt-4" role="img" aria-label={label}>
      <div className="relative h-3">
        <div className="bg-border absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full" />
        <div className="bg-muted-foreground/50 absolute left-1/2 top-0 h-3 w-px" />
        {markerPosition == null ? null : (
          <span
            className="bg-chart-1 ring-card absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2"
            style={{ left: `${markerPosition}%` }}
          />
        )}
      </div>
      <div className="text-muted-foreground mt-1 flex justify-between text-[11px]">
        <span>0</span>
        <span>{selfBaseline}</span>
        <span>100</span>
      </div>
    </div>
  );
}

function AccumulatingTrend({
  history,
  title,
  description,
}: {
  history: PersonalUtilizationHistoryPoint[];
  title: string;
  description: string;
}) {
  const offset = Math.max(0, TREND_WEEK_COUNT - history.length);

  return (
    <div className="bg-muted/35 mt-4 rounded-lg px-4 py-4">
      <div className="grid grid-cols-12 gap-1.5" aria-hidden="true">
        {Array.from({ length: TREND_WEEK_COUNT }, (_, index) => {
          const point = history[index - offset];
          return (
            <span
              key={index}
              className={`h-1.5 rounded-full ${point?.score == null ? "bg-border" : "bg-chart-1"}`}
            />
          );
        })}
      </div>
      <p className="mt-3 text-sm font-medium">{title}</p>
      <p className="text-muted-foreground mt-0.5 text-xs">{description}</p>
    </div>
  );
}

export async function UtilizationIndexCard({ result }: { result: PersonalUtilizationView }) {
  const [t, format] = await Promise.all([getTranslations("insights"), getFormatter()]);
  const timezone = getOrgTimezone();
  const period = (from: Date, to: Date) => t("utilization.periodRange", {
    from: format.dateTime(from, { dateStyle: "medium", timeZone: timezone }),
    to: format.dateTime(new Date(to.getTime() - 1), { dateStyle: "medium", timeZone: timezone }),
  });
  const dimensionNames = {
    context_continuity: t("utilization.dimensions.context_continuity"),
    execution_stability: t("utilization.dimensions.execution_stability"),
  };
  const dimensionDescriptions = {
    context_continuity: t("utilization.dimensionDescriptions.context_continuity"),
    execution_stability: t("utilization.dimensionDescriptions.execution_stability"),
  };
  const reason = (key: UtilizationReason) => t(`utilization.reasons.${key}`);
  const state = scoreState(result.score);
  const validHistory = result.history.filter((point) => point.score != null);
  const firstHistory = result.history[0];
  const lastHistory = result.history.at(-1);

  return (
    <Card
      data-testid="utilization-index-card"
      className="w-full gap-0 overflow-hidden py-0"
    >
      <CardHeader className="border-b px-4 py-4 sm:px-6 lg:px-7 [.border-b]:pb-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle>{t("utilization.title")}</CardTitle>
              <FeatureStatusBadge status="experiment">{t("utilization.experiment")}</FeatureStatusBadge>
            </div>
            <CardDescription>{t("utilization.description")}</CardDescription>
          </div>
          <Badge variant="secondary">{t(`utilization.confidence.${result.confidence}`)}</Badge>
        </div>
      </CardHeader>

      <CardContent className="px-0">
        <section className="grid gap-5 px-4 py-5 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-6 sm:px-6 lg:px-7">
          <div className="sm:border-border sm:border-r sm:pr-6">
            <p className="text-muted-foreground text-xs">{t("utilization.indexLabel")}</p>
            <p className="mt-1 text-5xl font-semibold tracking-tight tabular-nums">
              {result.score == null ? "—" : format.number(result.score)}
            </p>
            <p className="text-muted-foreground mt-1 text-xs">{t("utilization.selfBaseline")}</p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">{t("utilization.comparisonWindow")}</p>
            <p className="mt-1 text-xl font-semibold">{t(`utilization.summary.${state}`)}</p>
            <p className="text-muted-foreground mt-1 text-sm">{t("utilization.summaryDescription")}</p>
            <RelativeScale
              score={result.score}
              label={t("utilization.scaleAria", {
                score: result.score == null ? t("utilization.unavailableShort") : format.number(result.score),
              })}
              selfBaseline={t("utilization.selfBaseline")}
            />
          </div>
        </section>

        {result.score == null ? (
          <div className="border-border/70 mx-4 mb-5 rounded-lg border px-4 py-3 sm:mx-6">
            <p className="font-medium">{t("utilization.unavailable")}</p>
            <ul className="text-muted-foreground mt-2 space-y-1 text-sm">
              {result.reasons.map((item) => <li key={item}>{reason(item)}</li>)}
            </ul>
          </div>
        ) : null}

        <section className="border-t px-4 py-5 sm:px-6 lg:px-7" aria-labelledby="utilization-signals-title">
          <div className="mb-1">
            <h3 id="utilization-signals-title" className="text-sm font-medium">
              {t("utilization.signals.title")}
            </h3>
            <p className="text-muted-foreground mt-0.5 text-xs">{t("utilization.signals.description")}</p>
          </div>
          <div className="mt-4 grid gap-3 lg:grid-cols-2">
            {result.dimensions.map((dimension) => {
              const delta = dimension.currentValue != null && dimension.baselineMedian != null
                ? `${format.number((dimension.currentValue - dimension.baselineMedian) * 100, {
                    maximumFractionDigits: 1,
                    signDisplay: "always",
                  })}${t("utilization.percentagePoint")}`
                : "—";
              return (
                <DimensionPanel
                  key={dimension.key}
                  dimension={dimension}
                  name={dimensionNames[dimension.key]}
                  description={dimensionDescriptions[dimension.key]}
                  current={t("utilization.dimensionCurrent", {
                    value: percent(dimension.currentValue, format),
                  })}
                  comparison={t("utilization.dimensionComparison", {
                    baseline: percent(dimension.baselineMedian, format),
                    delta,
                  })}
                  samples={t("utilization.samples", {
                    current: dimension.currentSampleSize,
                    baseline: dimension.baselineSampleSize,
                  })}
                  score={dimension.score == null ? "—" : format.number(dimension.score)}
                  scoreLabel={t("utilization.indexLabel")}
                  reason={dimension.reason ? reason(dimension.reason) : null}
                />
              );
            })}
          </div>
        </section>

        <section className="border-t px-4 py-5 sm:px-6 lg:px-7" aria-labelledby="utilization-evidence-title">
          <h3 id="utilization-evidence-title" className="mb-3 text-sm font-medium">
            {t("utilization.evidence.title")}
          </h3>
          <div className="grid grid-cols-2 gap-x-3 gap-y-5 lg:grid-cols-4">
            <Observation label={t("utilization.evidence.activeDays")} value={format.number(result.observations.activeDays)} />
            <Observation label={t("utilization.evidence.sessions")} value={format.number(result.observations.sessions)} />
            <Observation
              label={t("utilization.evidence.knownToolCalls")}
              value={format.number(result.observations.knownToolCalls)}
              detail={t("utilization.evidence.coverage", {
                value: percent(result.observations.toolOutcomeCoverage, format),
              })}
            />
            <Observation
              label={t("utilization.recovery.title")}
              value={percent(result.observations.recoveryRate, format)}
              detail={result.observations.recoveryAttempts > 0
                ? t("utilization.recovery.samples", {
                    success: result.observations.successfulRecoveries,
                    attempts: result.observations.recoveryAttempts,
                    repeated: result.observations.repeatedToolFailures,
                  })
                : t("utilization.recovery.noAttempts")}
            />
          </div>
          <p className="text-muted-foreground mt-3 text-xs">{t("utilization.recovery.description")}</p>
        </section>

        <div className="grid border-t xl:grid-cols-[minmax(0,2fr)_minmax(18rem,0.75fr)]">
          <section className="px-4 py-5 sm:px-6 lg:px-7" aria-labelledby="utilization-trend-title">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <div>
                <h3 id="utilization-trend-title" className="text-sm font-medium">
                  {t("utilization.trend.title")}
                </h3>
                <p className="text-muted-foreground mt-0.5 text-xs">
                  {t("utilization.trend.description", { count: validHistory.length })}
                </p>
              </div>
              {validHistory.length >= MIN_TREND_WEEKS ? (
                <span className="text-muted-foreground text-xs">{t("utilization.trend.baseline")}</span>
              ) : null}
            </div>
            {validHistory.length >= MIN_TREND_WEEKS ? (
              <>
                <UtilizationTrend
                  history={result.history}
                  format={format}
                  label={t("utilization.trend.aria", { count: validHistory.length })}
                  unavailable={t("utilization.unavailableShort")}
                  timezone={timezone}
                />
                <div className="text-muted-foreground flex justify-between text-xs">
                  <span>
                    {firstHistory
                      ? format.dateTime(firstHistory.currentPeriod.from, {
                          month: "short",
                          day: "numeric",
                          timeZone: timezone,
                        })
                      : ""}
                  </span>
                  <span>
                    {lastHistory
                      ? format.dateTime(new Date(lastHistory.currentPeriod.to.getTime() - 1), {
                          month: "short",
                          day: "numeric",
                          timeZone: timezone,
                        })
                      : ""}
                  </span>
                </div>
              </>
            ) : (
              <AccumulatingTrend
                history={result.history}
                title={t("utilization.trend.accumulating", {
                  count: validHistory.length,
                  total: TREND_WEEK_COUNT,
                })}
                description={t("utilization.trend.minimum", { count: MIN_TREND_WEEKS })}
              />
            )}
          </section>

          <section
            className="border-t px-4 py-5 sm:px-6 xl:border-t-0 xl:border-l"
            aria-labelledby="utilization-observations-title"
          >
            <h3 id="utilization-observations-title" className="mb-4 text-xs font-medium">
              {t("utilization.observations.title")}
            </h3>
            <div className="grid grid-cols-2 gap-5 xl:grid-cols-1">
              <Observation
                label={t("utilization.observations.toolSessionRate")}
                value={percent(result.observations.toolActiveSessionRate, format)}
              />
              <Observation
                label={t("utilization.observations.distinctTools")}
                value={format.number(result.observations.distinctTools)}
              />
            </div>
          </section>
        </div>
      </CardContent>

      <CardFooter className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 border-t px-4 py-3 text-[11px] sm:px-6 [.border-t]:pt-3">
        <span>{t("utilization.currentPeriod", { range: period(result.currentPeriod.from, result.currentPeriod.to) })}</span>
        <span>{t("utilization.baseline", { range: period(result.baselinePeriod.from, result.baselinePeriod.to) })}</span>
        <span>{result.methodologyVersion}</span>
        <span>{t("utilization.calculatedAt", {
          time: format.dateTime(new Date(result.calculatedAt), {
            dateStyle: "medium",
            timeStyle: "short",
            timeZone: timezone,
          }),
        })}</span>
        <span>{t("utilization.delay")}</span>
      </CardFooter>
    </Card>
  );
}

function DimensionPanel({
  dimension,
  name,
  description,
  current,
  comparison,
  samples,
  scoreLabel,
  score,
  reason,
}: {
  dimension: UtilizationDimensionResult;
  name: string;
  description: string;
  current: string;
  comparison: string;
  samples: string;
  scoreLabel: string;
  score: string;
  reason: string | null;
}) {
  return (
    <div className="border-border/70 bg-muted/20 rounded-lg border p-4">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
        <div>
          <p className="text-sm font-medium">{name}</p>
          <p className="text-muted-foreground mt-0.5 text-xs">{description}</p>
        </div>
        <div className="sm:min-w-24 sm:text-right">
          <p className="text-muted-foreground text-xs">{scoreLabel}</p>
          <p className="mt-0.5 text-3xl font-semibold tracking-tight tabular-nums">{score}</p>
        </div>
      </div>
      <div className="border-border/70 mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t pt-3">
        <p className="font-medium tabular-nums">{current}</p>
        <p className="text-muted-foreground text-xs">{comparison}</p>
      </div>
      <p className="text-muted-foreground mt-1 text-xs">{samples}</p>
      {dimension.reason ? <p className="text-muted-foreground mt-2 text-xs">{reason}</p> : null}
    </div>
  );
}

function Observation({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="border-border/70 min-w-0 border-l pl-3">
      <p className="text-muted-foreground truncate text-xs">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
      {detail ? <p className="text-muted-foreground mt-0.5 text-xs">{detail}</p> : null}
    </div>
  );
}
