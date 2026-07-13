import { Clock3, Inbox, Lightbulb } from "lucide-react";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { InsightComparisonChart } from "@/components/charts/insight-comparison-chart";
import { DashboardToolbar } from "@/components/dashboard/dashboard-toolbar";
import { InsightComposition } from "@/components/dashboard/insight-composition";
import { InsightFilters } from "@/components/dashboard/insight-filters";
import { PricingNotice } from "@/components/dashboard/pricing-notice";
import { DeltaBadge, type StatDelta } from "@/components/dashboard/stat-card";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { getCurrentUserId } from "@/lib/current-user";
import {
  buildInsightPeriodPair,
  formatInsightPeriodRange,
  getInsightPeriodAnchor,
  parseInsightPreset,
} from "@/lib/insight-period";
import { generateInsightCandidates, type InsightRuleKey } from "@/lib/insight-rules";
import { getEnabledProviders, resolveInsightProvider } from "@/lib/providers";
import { formatCostForCoverage, legacyCostHintCount } from "@/lib/pricing";
import { pctDelta } from "@/lib/stat-delta";
import { getCachedUserInsights } from "@/lib/user-insights";
import { getViewerTimezone } from "@/lib/viewer-time";

export const dynamic = "force-dynamic";

type InsightSearchParams = {
  period?: string;
  provider?: string;
  metric?: string;
};

function KpiCard({
  label,
  value,
  delta,
  comparison,
}: {
  label: string;
  value: string;
  delta: StatDelta | null;
  comparison: string;
}) {
  return (
    <Card className="gap-3 py-5">
      <CardHeader className="px-5">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl tabular-nums">{value}</CardTitle>
      </CardHeader>
      <CardContent className="px-5">
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
          {delta ? <DeltaBadge delta={delta} /> : null}
          <span className="text-muted-foreground">{comparison}</span>
        </div>
      </CardContent>
    </Card>
  );
}

function assertNever(value: never): never {
  throw new Error(`Unhandled insight rule: ${String(value)}`);
}

export default async function InsightsPage({
  searchParams,
}: {
  searchParams: Promise<InsightSearchParams>;
}) {
  const [t, navT, dashboardT, format, locale] = await Promise.all([
    getTranslations("insights"),
    getTranslations("nav"),
    getTranslations("dashboard"),
    getFormatter(),
    getLocale(),
  ]);
  const userId = await getCurrentUserId();
  if (!userId) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Inbox />
          </EmptyMedia>
          <EmptyTitle>{t("loginRequired.title")}</EmptyTitle>
          <EmptyDescription>{t("loginRequired.description")}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const sp = await searchParams;
  const preset = parseInsightPreset(sp.period);
  const timezone = await getViewerTimezone();
  const metric = sp.metric === "cost" ? "cost" : "tokens";
  const anchor = getInsightPeriodAnchor();
  const pair = buildInsightPeriodPair(preset, timezone, anchor);
  const providers = await getEnabledProviders();
  const providerKey = resolveInsightProvider(sp.provider, providers);
  const comparison = await getCachedUserInsights(userId, pair, providerKey);
  const comparisonCoverage = {
    pricedEvents: comparison.current.costCoverage.pricedEvents + comparison.previous.costCoverage.pricedEvents,
    unpricedEvents: comparison.current.costCoverage.unpricedEvents + comparison.previous.costCoverage.unpricedEvents,
    legacyEvents: comparison.current.costCoverage.legacyEvents + comparison.previous.costCoverage.legacyEvents,
  };
  const costComplete = comparisonCoverage.unpricedEvents === 0;
  const tokenDelta = pctDelta(comparison.current.totalTokens, comparison.previous.totalTokens);
  const sessionsDelta = pctDelta(comparison.current.sessions, comparison.previous.sessions);
  const costDelta = costComplete ? pctDelta(comparison.current.costUsd, comparison.previous.costUsd) : null;
  const candidates = generateInsightCandidates(comparison, metric);
  const costLabels = {
    partial: dashboardT("costCoverage.partial"),
    unpriced: dashboardT("costCoverage.unpriced"),
    legacy: dashboardT("costCoverage.legacy"),
  };
  const currentLegacyCount = costComplete
    ? legacyCostHintCount(comparison.current.costCoverage)
    : null;
  const costComparison = currentLegacyCount == null
    ? costComplete
      ? comparison.previous.costUsd === 0
        ? t("kpi.noPrevious")
        : t("kpi.previousPeriod")
      : comparisonCoverage.pricedEvents + comparisonCoverage.legacyEvents > 0
        ? costLabels.partial
        : costLabels.unpriced
    : dashboardT("costCoverage.legacyHint", { count: format.number(currentLegacyCount) });
  const hasCurrentUsage =
    comparison.current.sessions > 0 || comparison.current.costUsd > 0 || comparison.current.totalTokens > 0;

  const formatRuleDelta = (value: number | string | undefined) =>
    format.number(Number(value), { maximumFractionDigits: 1 });
  const translateCandidate = (key: InsightRuleKey, values: Record<string, number | string>) => {
    const delta = formatRuleDelta(values.delta);
    const name = String(values.name ?? "");
    const dimension = values.dimension === "provider" ? t("composition.provider") : t("composition.model");
    switch (key) {
      case "usage.new":
        return t("rules.usage.new");
      case "cost.increase":
        return t("rules.cost.increase", { delta });
      case "cost.decrease":
        return t("rules.cost.decrease", { delta });
      case "sessions.increase":
        return t("rules.sessions.increase", { delta });
      case "sessions.decrease":
        return t("rules.sessions.decrease", { delta });
      case "tokens.increase":
        return t("rules.tokens.increase", { delta });
      case "tokens.decrease":
        return t("rules.tokens.decrease", { delta });
      case "efficiency.increase":
        return t("rules.efficiency.increase", { delta });
      case "efficiency.decrease":
        return t("rules.efficiency.decrease", { delta });
      case "composition.increase":
        return t("rules.composition.increase", { name, dimension, delta });
      case "composition.decrease":
        return t("rules.composition.decrease", { name, dimension, delta });
      case "composition.new":
        return t("rules.composition.new", { name, dimension });
      default:
        return assertNever(key);
    }
  };
  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <DashboardToolbar
          title={t("title")}
          statusBadge={{ status: "beta", label: navT("badge.beta") }}
          filters={
            <InsightFilters
              preset={preset}
              metric={metric}
              provider={providerKey ?? "all"}
              providers={providers}
            />
          }
          trailing={
            <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              <span className="flex items-center gap-1.5">
                <Clock3 className="size-3.5" />
                {t("freshness.dataThrough", {
                  time: format.dateTime(pair.current.to, {
                    dateStyle: "medium",
                    timeStyle: "short",
                    timeZone: timezone,
                  }),
                })}
              </span>
              <span>{t("freshness.delay")}</span>
            </div>
          }
          splitHeader
        />
        <div className="bg-muted/30 text-muted-foreground grid gap-1 rounded-lg px-3 py-2 text-xs sm:grid-cols-2 sm:gap-4">
          <p>
            {t("ranges.current", {
              range: formatInsightPeriodRange(pair.current, locale, timezone),
            })}
          </p>
          <p>
            {t("ranges.previous", {
              range: formatInsightPeriodRange(pair.previous, locale, timezone),
            })}
          </p>
        </div>
      </header>

      <PricingNotice coverage={comparisonCoverage} />

      {!hasCurrentUsage ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Inbox />
            </EmptyMedia>
            <EmptyTitle>{t("empty.title")}</EmptyTitle>
            <EmptyDescription>{t("empty.description")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <section className="space-y-3" aria-labelledby="insight-summary-title">
            <div>
              <h2 id="insight-summary-title" className="text-sm font-medium">
                {t("summary.title")}
              </h2>
              <p className="text-muted-foreground mt-0.5 text-xs">{t("summary.description")}</p>
            </div>
            {candidates.length === 0 ? (
              <Card className="bg-muted/30 gap-3 py-5">
                <CardContent className="text-muted-foreground flex items-center gap-2 px-5 text-sm">
                  <Lightbulb className="size-4 shrink-0" />
                  {t("summary.empty")}
                </CardContent>
              </Card>
            ) : (
              <div className="grid gap-4 lg:grid-cols-3">
                {candidates.map((candidate, index) => (
                  <Card key={`${candidate.key}-${index}`} className="border-chart-1/30 bg-muted/30 gap-3 py-5">
                    <CardContent className="flex items-start gap-2 px-5 text-sm leading-relaxed">
                      <Lightbulb className="text-chart-1 mt-0.5 size-4 shrink-0" />
                      <span>{translateCandidate(candidate.key, candidate.values)}</span>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </section>

          <section className="grid gap-4 sm:grid-cols-3" aria-label={t("comparison.current")}>
            <KpiCard
              label={t("kpi.tokens")}
              value={format.number(comparison.current.totalTokens)}
              delta={tokenDelta}
              comparison={comparison.previous.totalTokens === 0 ? t("kpi.noPrevious") : t("kpi.previousPeriod")}
            />
            <KpiCard
              label={t("kpi.sessions")}
              value={format.number(comparison.current.sessions)}
              delta={sessionsDelta}
              comparison={comparison.previous.sessions === 0 ? t("kpi.noPrevious") : t("kpi.previousPeriod")}
            />
            <KpiCard
              label={t("kpi.cost")}
              value={formatCostForCoverage(
                format.number(comparison.current.costUsd, {
                  style: "currency",
                  currency: "USD",
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 4,
                }),
                comparison.current.costCoverage,
                costLabels,
              )}
              delta={costDelta}
              comparison={costComparison}
            />
          </section>

          <Card>
            <CardHeader>
              <CardTitle>{t("chart.title")}</CardTitle>
              <CardDescription>{t("chart.description")}</CardDescription>
            </CardHeader>
            <CardContent>
              <InsightComparisonChart
                data={comparison.trend}
                metric={metric}
                currentFrom={pair.current.from.toISOString()}
                currentTo={pair.current.to.toISOString()}
                previousFrom={pair.previous.from.toISOString()}
                previousTo={pair.previous.to.toISOString()}
                timezone={pair.timezone}
              />
            </CardContent>
          </Card>

          <InsightComposition byModel={comparison.byModel} byProvider={comparison.byProvider} metric={metric} />
        </>
      )}
    </div>
  );
}
