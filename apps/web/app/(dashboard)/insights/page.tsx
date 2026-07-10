import type { ReactNode } from "react";
import { Clock3, Inbox, Lightbulb } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import { InsightComparisonChart } from "@/components/charts/insight-comparison-chart";
import { InsightComposition } from "@/components/dashboard/insight-composition";
import { InsightFilters } from "@/components/dashboard/insight-filters";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { getCurrentUserId } from "@/lib/current-user";
import { buildInsightPeriodPair, getInsightPeriodAnchor, parseInsightPreset } from "@/lib/insight-period";
import { generateInsightCandidates, type InsightRuleKey } from "@/lib/insight-rules";
import { getEnabledProviders } from "@/lib/providers";
import { getCachedUserInsights } from "@/lib/user-insights";
import { getViewerTimezone } from "@/lib/viewer-time";

export const dynamic = "force-dynamic";

type InsightSearchParams = {
  period?: string;
  provider?: string;
  metric?: string;
};

function KpiCard({ label, value, comparison }: { label: string; value: string; comparison: ReactNode }) {
  return (
    <Card className="gap-3 py-5">
      <CardHeader className="px-5">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl tabular-nums">{value}</CardTitle>
      </CardHeader>
      <CardContent className="text-muted-foreground px-5 text-xs">{comparison}</CardContent>
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
  const [t, format] = await Promise.all([getTranslations("insights"), getFormatter()]);
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
  const providerKey = sp.provider && sp.provider !== "all" ? sp.provider : undefined;
  const metric = sp.metric === "tokens" ? "tokens" : "cost";
  const anchor = getInsightPeriodAnchor();
  const pair = buildInsightPeriodPair(preset, timezone, anchor);
  const [comparison, providers] = await Promise.all([
    getCachedUserInsights(userId, pair, providerKey),
    getEnabledProviders(),
  ]);
  const candidates = generateInsightCandidates(comparison, metric);
  const hasCurrentUsage =
    comparison.current.sessions > 0 || comparison.current.costUsd > 0 || comparison.current.totalTokens > 0;

  const formatRuleDelta = (value: number | string | undefined) =>
    format.number(Number(value), { maximumFractionDigits: 1 });
  const translateCandidate = (key: InsightRuleKey, values: Record<string, number | string>) => {
    const delta = formatRuleDelta(values.delta);
    const name = String(values.name ?? "");
    const dimension = values.dimension === "provider" ? t("composition.provider") : t("composition.model");
    switch (key) {
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
  const formatComparison = (current: number, previous: number) => {
    if (previous === 0) return t("kpi.noPrevious");
    const delta = (current - previous) / previous;
    return t("kpi.vsPrevious", {
      delta: format.number(delta, { style: "percent", signDisplay: "always", maximumFractionDigits: 1 }),
    });
  };

  return (
    <div className="space-y-6">
      <header className="space-y-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
          <p className="text-muted-foreground mt-1 text-sm">{t("description")}</p>
        </div>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <InsightFilters
            preset={preset}
            metric={metric}
            provider={providerKey ?? "all"}
            providers={providers}
          />
          <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
            <Clock3 className="size-3.5" />
            {t("cache.calculatedAt", {
              time: format.dateTime(new Date(comparison.calculatedAt), {
                dateStyle: "medium",
                timeStyle: "short",
                timeZone: timezone,
              }),
            })}
          </div>
        </div>
      </header>

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
              <div className="grid gap-3 lg:grid-cols-3">
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

          <section className="grid gap-3 sm:grid-cols-3" aria-label={t("comparison.current")}>
            <KpiCard
              label={t("kpi.cost")}
              value={format.number(comparison.current.costUsd, {
                style: "currency",
                currency: "USD",
                minimumFractionDigits: 2,
                maximumFractionDigits: 4,
              })}
              comparison={formatComparison(comparison.current.costUsd, comparison.previous.costUsd)}
            />
            <KpiCard
              label={t("kpi.sessions")}
              value={format.number(comparison.current.sessions)}
              comparison={formatComparison(comparison.current.sessions, comparison.previous.sessions)}
            />
            <KpiCard
              label={t("kpi.tokens")}
              value={format.number(comparison.current.totalTokens)}
              comparison={formatComparison(comparison.current.totalTokens, comparison.previous.totalTokens)}
            />
          </section>

          <Card>
            <CardHeader>
              <CardTitle>{t("chart.title")}</CardTitle>
              <CardDescription>{t("chart.description")}</CardDescription>
            </CardHeader>
            <CardContent>
              <InsightComparisonChart data={comparison.trend} metric={metric} />
            </CardContent>
          </Card>

          <InsightComposition byModel={comparison.byModel} byProvider={comparison.byProvider} metric={metric} />
        </>
      )}
    </div>
  );
}
