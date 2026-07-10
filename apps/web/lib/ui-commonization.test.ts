import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function messageShape(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return typeof value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, messageShape(nested)]),
  );
}

test("dashboard and settings segmented choices use the shared segmented control", () => {
  assert.match(source("components/ui/segmented-control.tsx"), /function SegmentedControl/);
  assert.match(source("components/dashboard/view-toggle.tsx"), /@\/components\/ui\/segmented-control/);
  assert.match(source("app/(dashboard)/settings/appearance-form.tsx"), /@\/components\/ui\/segmented-control/);
});

test("visible boolean settings use the shared switch control", () => {
  assert.match(source("components/ui/switch.tsx"), /function Switch/);
  assert.match(source("app/(dashboard)/admin/pricing-panel.tsx"), /@\/components\/ui\/switch/);
  assert.match(source("app/(dashboard)/settings/onboarding-panel.tsx"), /@\/components\/ui\/switch/);
});

test("dashboard disclosures use the shared disclosure wrapper", () => {
  assert.match(source("components/ui/disclosure.tsx"), /function Disclosure/);
  assert.match(source("app/(dashboard)/history/session-detail.tsx"), /@\/components\/ui\/disclosure/);
  assert.match(source("app/(dashboard)/settings/onboarding-panel.tsx"), /@\/components\/ui\/disclosure/);
});

test("dashboard provider filter stays compact for the all-tools value", () => {
  const filters = source("components/dashboard/dashboard-filters.tsx");
  assert.match(filters, /SelectTrigger className="[^"]*min-w-0/);
  assert.doesNotMatch(filters, /min-w-\[8rem\]/);
});

test("demo open mode can render settings with the dashboard viewer fallback", () => {
  const settings = source("app/(dashboard)/settings/page.tsx");
  assert.match(settings, /getDashboardViewer/);
  assert.doesNotMatch(
    settings,
    /const session = await auth\(\);\s*const userId = session\?\.user\?\.id;\s*if \(!userId\) redirect\("\/login"\);/s,
  );
});

test("personal navigation includes insights between usage and history", () => {
  const nav = source("components/dashboard/sidebar-nav.tsx");
  assert.match(nav, /key: "myUsage"[\s\S]*key: "insights"[\s\S]*key: "history"/);
});

test("insights page uses the cached comparison and shared cards", () => {
  const page = source("app/(dashboard)/insights/page.tsx");
  assert.match(page, /getCachedUserInsights/);
  assert.match(page, /@\/components\/ui\/card/);
});

test("insights default to tokens while preserving explicit cost selection", () => {
  const page = source("app/(dashboard)/insights/page.tsx");
  assert.match(page, /const metric = sp\.metric === "cost" \? "cost" : "tokens"/);
  assert.match(page, /generateInsightCandidates\(comparison, metric\)/);
  assert.match(page, /<InsightComparisonChart[\s\S]*data=\{comparison\.trend\}[\s\S]*metric=\{metric\}/);
  assert.match(page, /<InsightComposition[\s\S]*metric=\{metric\}/);
});

test("insights keep token-first KPI and metric-control order", () => {
  const page = source("app/(dashboard)/insights/page.tsx");
  const filters = source("components/dashboard/insight-filters.tsx");
  const tokenKpi = page.indexOf('label={t("kpi.tokens")}');
  const sessionKpi = page.indexOf('label={t("kpi.sessions")}');
  const costKpi = page.indexOf('label={t("kpi.cost")}');
  const tokenMetric = filters.indexOf('{ value: "tokens", label: t("filters.tokens") }');
  const costMetric = filters.indexOf('{ value: "cost", label: t("filters.cost") }');

  assert.notEqual(tokenKpi, -1);
  assert.notEqual(sessionKpi, -1);
  assert.notEqual(costKpi, -1);
  assert.equal(tokenKpi < sessionKpi && sessionKpi < costKpi, true);
  assert.notEqual(tokenMetric, -1);
  assert.notEqual(costMetric, -1);
  assert.equal(tokenMetric < costMetric, true);
});

test("insights page builds cache arguments from a stable period anchor", () => {
  const page = source("app/(dashboard)/insights/page.tsx");
  assert.match(page, /const anchor = getInsightPeriodAnchor\(\)/);
  assert.match(page, /buildInsightPeriodPair\(preset, timezone, anchor\)/);
});

test("insights page validates provider before reading the comparison cache", () => {
  const page = source("app/(dashboard)/insights/page.tsx");
  const providersIndex = page.indexOf("const providers = await getEnabledProviders()");
  const comparisonIndex = page.indexOf("const comparison = await getCachedUserInsights(");

  assert.notEqual(providersIndex, -1);
  assert.notEqual(comparisonIndex, -1);
  assert.equal(providersIndex < comparisonIndex, true);
  assert.match(page, /resolveInsightProvider\(sp\.provider, providers\)/);
  assert.match(page, /provider=\{providerKey \?\? "all"\}/);
});

test("insights page shows the period anchor and both localized comparison ranges", () => {
  const page = source("app/(dashboard)/insights/page.tsx");

  assert.match(page, /t\("freshness\.dataThrough", \{[\s\S]*format\.dateTime\(pair\.current\.to/);
  assert.match(page, /t\("freshness\.delay"\)/);
  assert.match(page, /t\("ranges\.current", \{[\s\S]*formatInsightPeriodRange\(pair\.current, locale, timezone\)/);
  assert.match(page, /t\("ranges\.previous", \{[\s\S]*formatInsightPeriodRange\(pair\.previous, locale, timezone\)/);
  assert.doesNotMatch(page, /new Date\(comparison\.calculatedAt\)/);
});

test("Korean and English insight catalogs have the same shape and 10-minute delay copy", () => {
  const ko = JSON.parse(source("messages/ko/insights.json")) as {
    freshness?: { delay?: string };
    chart?: { dateComparison?: string; comparisonUnavailable?: string };
  };
  const en = JSON.parse(source("messages/en/insights.json")) as {
    freshness?: { delay?: string };
    chart?: { dateComparison?: string; comparisonUnavailable?: string };
  };

  assert.deepEqual(messageShape(ko), messageShape(en));
  assert.match(ko.freshness?.delay ?? "", /10분/);
  assert.match(en.freshness?.delay ?? "", /10 minutes/);
  assert.equal(typeof ko.chart?.dateComparison, "string");
  assert.equal(typeof en.chart?.dateComparison, "string");
  assert.equal(ko.chart?.comparisonUnavailable, "비교 데이터 없음");
  assert.equal(en.chart?.comparisonUnavailable, "Comparison data unavailable");
});

test("insight filters reuse shared controls and update URL parameters", () => {
  const filters = source("components/dashboard/insight-filters.tsx");
  assert.match(filters, /@\/components\/ui\/segmented-control/);
  assert.match(filters, /@\/components\/ui\/select/);
  assert.match(filters, /new URLSearchParams\(searchParams\.toString\(\)\)/);
});

test("insights use the compact dashboard toolbar while preserving accessible labels", () => {
  const page = source("app/(dashboard)/insights/page.tsx");
  const filters = source("components/dashboard/insight-filters.tsx");

  assert.match(page, /<h1 className="[^\"]*text-sm font-medium[^\"]*">\{t\("title"\)\}<\/h1>/);
  assert.doesNotMatch(page, /<h1 className="text-2xl/);
  assert.match(page, /flex flex-wrap items-center gap-2[\s\S]*<InsightFilters/);
  assert.match(page, /sm:ml-auto[\s\S]*t\("freshness\.dataThrough"/);
  assert.match(filters, /<div className="flex flex-wrap items-center gap-2">/);
  assert.doesNotMatch(filters, /className="text-muted-foreground text-xs">\{t\("presets\.label"\)\}/);
  assert.doesNotMatch(filters, /className="text-muted-foreground text-xs">\{t\("filters\.providerLabel"\)\}/);
  assert.doesNotMatch(filters, /className="text-muted-foreground text-xs">\{t\("filters\.metricLabel"\)\}/);
  assert.match(filters, /aria-label=\{t\("presets\.label"\)\}/);
  assert.match(filters, /aria-label=\{t\("filters\.providerLabel"\)\}/);
  assert.match(filters, /aria-label=\{t\("filters\.metricLabel"\)\}/);
});

test("insight comparison chart renders current and previous without animation", () => {
  const chart = source("components/charts/insight-comparison-chart.tsx");
  assert.match(chart, /dataKey="current"[\s\S]*isAnimationActive=\{false\}/);
  assert.match(chart, /dataKey="previous"[\s\S]*isAnimationActive=\{false\}/);
});

test("insight comparison chart fills only the current period with the approved gradient", () => {
  const chart = source("components/charts/insight-comparison-chart.tsx");

  assert.match(chart, /ComposedChart/);
  assert.match(chart, /const gradientId = `\$\{descriptionId\.replace\(\/:\/g, ""\)\}-current-fill`/);
  assert.match(chart, /<linearGradient id=\{gradientId\}/);
  assert.match(
    chart,
    /<stop offset="5%" stopColor="var\(--color-chart-1\)" stopOpacity=\{0\.32\}/,
  );
  assert.match(
    chart,
    /<stop offset="95%" stopColor="var\(--color-chart-1\)" stopOpacity=\{0\.04\}/,
  );
  assert.match(
    chart,
    /<Area[^>]*dataKey="current"[^>]*stroke="var\(--color-chart-1\)"[^>]*fill=\{`url\(#\$\{gradientId\}\)`\}[^>]*isAnimationActive=\{false\}/s,
  );
  assert.doesNotMatch(chart, /<Area[^>]*dataKey="previous"/s);
  assert.match(
    chart,
    /<Line[^>]*dataKey="previous"[^>]*stroke="var\(--color-muted-foreground\)"[^>]*strokeDasharray="4 4"[^>]*isAnimationActive=\{false\}/s,
  );
});

test("insight comparison chart preserves sparse numeric positions", () => {
  const chart = source("components/charts/insight-comparison-chart.tsx");
  assert.match(chart, /<XAxis[\s\S]*type="number"[\s\S]*domain=\{\["dataMin", "dataMax"\]\}/);
});

test("insight comparison chart labels positions with current and previous dates", () => {
  const chart = source("components/charts/insight-comparison-chart.tsx");
  const page = source("app/(dashboard)/insights/page.tsx");
  assert.match(chart, /getInsightPositionDate/);
  assert.match(chart, /tickFormatter=.*formatPositionDate/s);
  assert.match(chart, /labelFormatter=.*chart\.dateComparison/s);
  assert.match(chart, /previous: previousDate === null \? undefined :/);
  assert.match(chart, /chart\.comparisonUnavailable/);
  assert.match(page, /currentFrom=\{pair\.current\.from\.toISOString\(\)\}/);
  assert.match(page, /previousFrom=\{pair\.previous\.from\.toISOString\(\)\}/);
  assert.match(page, /previousTo=\{pair\.previous\.to\.toISOString\(\)\}/);
  assert.match(page, /timezone=\{pair\.timezone\}/);
});

test("insight comparison chart exposes its translated name without a nested image role", () => {
  const chart = source("components/charts/insight-comparison-chart.tsx");
  assert.doesNotMatch(chart, /role="img"/);
  assert.match(
    chart,
    /<ComposedChart[\s\S]*aria-label=\{t\("chart\.accessibleLabel"\)\}[\s\S]*aria-describedby=\{descriptionId\}/,
  );
  assert.match(chart, /id=\{descriptionId\}[\s\S]*t\("chart\.accessibleDescription"\)/);
});

test("insights page separates login-required and usage-empty states", () => {
  const page = source("app/(dashboard)/insights/page.tsx");
  assert.match(page, /if \(!userId\)[\s\S]*loginRequired\.title[\s\S]*loginRequired\.description/);
});

test("insights page translates the new-usage rule in its exhaustive switch", () => {
  const page = source("app/(dashboard)/insights/page.tsx");
  const ko = JSON.parse(source("messages/ko/insights.json")) as { rules?: { usage?: { new?: string } } };
  const en = JSON.parse(source("messages/en/insights.json")) as { rules?: { usage?: { new?: string } } };

  assert.match(page, /case "usage\.new":[\s\S]*t\("rules\.usage\.new"/);
  assert.equal(typeof ko.rules?.usage?.new, "string");
  assert.equal(typeof en.rules?.usage?.new, "string");
});

test("insight composition uses shared tabs and limits rows", () => {
  const composition = source("components/dashboard/insight-composition.tsx");
  assert.match(composition, /@\/components\/ui\/segmented-control/);
  assert.match(composition, /\.slice\(0, 5\)/);
});
