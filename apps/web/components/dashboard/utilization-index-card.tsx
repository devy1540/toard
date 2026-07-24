import type { UtilizationDimensionResult, UtilizationReason } from "@toard/core";
import { getFormatter, getTranslations } from "next-intl/server";
import { FeatureStatusBadge } from "@/components/dashboard/feature-status-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import type { PersonalUtilizationHistoryPoint, PersonalUtilizationView } from "@/lib/ai-utilization";
import { getOrgTimezone } from "@/lib/org-time";

type Formatter = Awaited<ReturnType<typeof getFormatter>>;

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
      <svg className="h-28 w-full" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
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
              className="stroke-violet-500"
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
            className="fill-violet-500"
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
    <Card className="overflow-hidden">
      <CardHeader className="gap-2">
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

      <CardContent className="space-y-6">
        <div className="bg-muted/35 grid gap-4 rounded-lg px-4 py-4 sm:grid-cols-[1fr_auto] sm:items-end">
          <div>
            <p className="text-muted-foreground text-xs">{t("utilization.comparisonWindow")}</p>
            <p className="mt-1 text-xl font-semibold">{t(`utilization.summary.${state}`)}</p>
            <p className="text-muted-foreground mt-1 text-sm">{t("utilization.summaryDescription")}</p>
          </div>
          <div className="sm:text-right">
            <p className="text-muted-foreground text-xs">{t("utilization.indexLabel")}</p>
            <p className="text-4xl font-semibold tabular-nums">
              {result.score == null ? "—" : format.number(result.score)}
            </p>
            <p className="text-muted-foreground text-xs">{t("utilization.selfBaseline")}</p>
          </div>
        </div>

        {result.score == null ? (
          <div className="border-border/70 rounded-lg border px-4 py-3">
            <p className="font-medium">{t("utilization.unavailable")}</p>
            <ul className="text-muted-foreground mt-2 space-y-1 text-sm">
              {result.reasons.map((item) => <li key={item}>{reason(item)}</li>)}
            </ul>
          </div>
        ) : null}

        <section aria-labelledby="utilization-signals-title">
          <div className="mb-3">
            <h3 id="utilization-signals-title" className="text-sm font-medium">
              {t("utilization.signals.title")}
            </h3>
            <p className="text-muted-foreground mt-0.5 text-xs">{t("utilization.signals.description")}</p>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {result.dimensions.map((dimension) => {
              const delta = dimension.currentValue != null && dimension.baselineMedian != null
                ? `${format.number((dimension.currentValue - dimension.baselineMedian) * 100, {
                    maximumFractionDigits: 1,
                    signDisplay: "always",
                  })}${t("utilization.percentagePoint")}`
                : "—";
              return (
                <DimensionCard
                  key={dimension.key}
                  dimension={dimension}
                  name={dimensionNames[dimension.key]}
                  description={dimensionDescriptions[dimension.key]}
                  current={percent(dimension.currentValue, format)}
                  comparison={t("utilization.dimensionComparison", {
                    baseline: percent(dimension.baselineMedian, format),
                    delta,
                  })}
                  samples={t("utilization.samples", {
                    current: dimension.currentSampleSize,
                    baseline: dimension.baselineSampleSize,
                  })}
                  scoreLabel={t("utilization.dimensionScore", {
                    score: dimension.score == null ? "—" : format.number(dimension.score),
                  })}
                  reason={dimension.reason ? reason(dimension.reason) : null}
                />
              );
            })}
          </div>
        </section>

        <section className="border-border/70 rounded-lg border px-4 py-4" aria-labelledby="utilization-recovery-title">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 id="utilization-recovery-title" className="text-sm font-medium">
                {t("utilization.recovery.title")}
              </h3>
              <p className="text-muted-foreground mt-0.5 text-xs">{t("utilization.recovery.description")}</p>
            </div>
            <p className="text-2xl font-semibold tabular-nums">
              {result.observations.recoveryRate == null
                ? "—"
                : percent(result.observations.recoveryRate, format)}
            </p>
          </div>
          <p className="text-muted-foreground mt-3 text-xs">
            {result.observations.recoveryAttempts > 0
              ? t("utilization.recovery.samples", {
                  success: result.observations.successfulRecoveries,
                  attempts: result.observations.recoveryAttempts,
                  repeated: result.observations.repeatedToolFailures,
                })
              : t("utilization.recovery.noAttempts")}
          </p>
        </section>

        <section aria-labelledby="utilization-evidence-title">
          <h3 id="utilization-evidence-title" className="mb-2 text-sm font-medium">
            {t("utilization.evidence.title")}
          </h3>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Observation label={t("utilization.evidence.activeDays")} value={format.number(result.observations.activeDays)} />
            <Observation label={t("utilization.evidence.sessions")} value={format.number(result.observations.sessions)} />
            <Observation label={t("utilization.evidence.knownToolCalls")} value={format.number(result.observations.knownToolCalls)} />
            <Observation
              label={t("utilization.evidence.toolOutcomeCoverage")}
              value={percent(result.observations.toolOutcomeCoverage, format)}
            />
          </div>
        </section>

        <section aria-labelledby="utilization-trend-title">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h3 id="utilization-trend-title" className="text-sm font-medium">
                {t("utilization.trend.title")}
              </h3>
              <p className="text-muted-foreground mt-0.5 text-xs">
                {t("utilization.trend.description", { count: validHistory.length })}
              </p>
            </div>
            <span className="text-muted-foreground text-xs">{t("utilization.trend.baseline")}</span>
          </div>
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
        </section>

        <section aria-labelledby="utilization-observations-title">
          <h3 id="utilization-observations-title" className="mb-2 text-sm font-medium">
            {t("utilization.observations.title")}
          </h3>
          <div className="grid gap-3 sm:grid-cols-2">
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
      </CardContent>

      <CardFooter className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 border-t text-xs">
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

function DimensionCard({
  dimension,
  name,
  description,
  current,
  comparison,
  samples,
  scoreLabel,
  reason,
}: {
  dimension: UtilizationDimensionResult;
  name: string;
  description: string;
  current: string;
  comparison: string;
  samples: string;
  scoreLabel: string;
  reason: string | null;
}) {
  return (
    <div className="border-border/70 rounded-lg border px-4 py-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium">{name}</p>
          <p className="text-muted-foreground mt-0.5 text-xs">{description}</p>
        </div>
        <span className="bg-muted rounded-md px-2 py-1 text-xs tabular-nums">{scoreLabel}</span>
      </div>
      <p className="mt-3 text-3xl font-semibold tabular-nums">{current}</p>
      <p className="text-muted-foreground mt-1 text-xs">{comparison}</p>
      <p className="text-muted-foreground mt-1 text-xs">{samples}</p>
      {dimension.reason ? <p className="text-muted-foreground mt-2 text-xs">{reason}</p> : null}
    </div>
  );
}

function Observation({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-border/70 border-l pl-3">
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className="mt-1 font-medium tabular-nums">{value}</p>
    </div>
  );
}
