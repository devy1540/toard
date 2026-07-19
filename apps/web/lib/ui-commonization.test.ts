import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function repoSource(path: string): string {
  return readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
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

test("남아 있는 boolean 설정은 shared switch control을 사용한다", () => {
  assert.match(source("components/ui/switch.tsx"), /function Switch/);
  assert.match(source("app/(dashboard)/settings/onboarding-wizard.tsx"), /@\/components\/ui\/switch/);
  assert.doesNotMatch(source("app/(dashboard)/admin/pricing-panel.tsx"), /@\/components\/ui\/switch/);
});

test("관리자 시스템 탭은 rollup 상태를 표시하되 read와 TTL을 제어하지 않는다", () => {
  const page = source("app/(dashboard)/admin/page.tsx");
  const panel = source("app/(dashboard)/admin/rollup-status-panel.tsx");

  assert.match(page, /getRollupAdminStatus\(\)\.catch\(\(\) => null\)/);
  assert.match(page, /<RollupStatusPanel initialStatus=\{rollupStatus\}/);
  assert.match(panel, /const POLL_MS = 10_000/);
  assert.match(panel, /document\.visibilityState === "visible"/);
  assert.match(panel, /signal: ticket\.signal/);
  assert.match(panel, /requestGate\.canCommit\(ticket\)/);
  assert.match(panel, /requestGateRef\.current\?\.invalidate\(\)[\s\S]*setPendingWorker/);
  assert.match(panel, /requestGateRef\.current\?\.invalidate\(\);\s*await refresh\(\)/);
  assert.match(panel, /requestGate\.dispose\(\)/);
  assert.match(panel, /requestGateRef\.current === requestGate[\s\S]*requestGateRef\.current = null/);
  assert.match(panel, /controlAbortRef\.current\?\.abort\(\)/);
  assert.match(panel, /\/api\/admin\/rollups\/status/);
  assert.match(panel, /\/api\/admin\/rollups\/control/);
  assert.match(panel, /await refresh\(\)/);
  assert.match(panel, /role="progressbar"/);
  assert.match(panel, /aria-valuenow=\{/);
  assert.match(panel, /!worker\.hardEnabled/);
  assert.match(panel, /status\.backend === "postgres"/);
  assert.match(panel, /const summaryLabel = status\.degraded[\s\S]*status\.backend === "postgres"/);
  assert.match(panel, /formatDateTime\(worker\.lastErrorAt, locale\)/);
  assert.match(panel, /status\.cutover/);
  assert.match(panel, /healthySeconds/);
  assert.match(panel, /requiredHealthySeconds/);
  assert.match(panel, /worker\.adaptiveLimit/);
  assert.match(panel, /worker\.loadState/);
  assert.match(panel, /status\.scheduler/);
  assert.match(panel, /worker\.eligiblePendingJobs/);
  assert.match(panel, /worker\.waitingForBaseJobs/);
  assert.doesNotMatch(panel, /CLICKHOUSE_READ_|CLICKHOUSE_ENFORCE_RETENTION_TTL/);
  assert.doesNotMatch(panel, />\{worker\.lastError\}</);
});

test("rollup worker는 현재 오류 상태일 때만 실패 안내를 표시한다", () => {
  const panel = source("app/(dashboard)/admin/rollup-status-panel.tsx");

  assert.match(panel, /worker\.state === "error" && worker\.lastError/);
});

test("rollup 관리자 메시지는 한영 shape와 상태·storage 계약을 같이 유지한다", () => {
  const ko = JSON.parse(source("messages/ko/admin.json")) as Record<string, unknown>;
  const en = JSON.parse(source("messages/en/admin.json")) as Record<string, unknown>;
  const koRollup = ko.rollup as Record<string, unknown> | undefined;
  const enRollup = en.rollup as Record<string, unknown> | undefined;
  const koWorker = koRollup?.worker as Record<string, unknown> | undefined;
  const koReadSource = koRollup?.readSource as Record<string, unknown> | undefined;

  assert.deepEqual(messageShape(ko), messageShape(en));
  assert.equal(typeof (ko.system as Record<string, unknown>)?.rollupTitle, "string");
  assert.equal(typeof (en.system as Record<string, unknown>)?.rollupDescription, "string");
  assert.equal(koWorker?.usage15mV2, "15분 기준 rollup");
  assert.equal(koWorker?.timezone, "시간대별 1시간·1일 rollup");
  assert.equal(koReadSource?.usage15mV2, "15분 기준 rollup");
  assert.equal(koReadSource?.timezone, "시간대별 1시간·1일 rollup");
  for (const catalog of [koRollup, enRollup]) {
    assert.equal(typeof catalog?.progress, "string");
    assert.equal(typeof catalog?.eta, "string");
    assert.equal(typeof catalog?.etaConfigured, "string");
    assert.equal(typeof catalog?.lastError, "string");
    assert.equal(typeof catalog?.pause, "string");
    assert.equal(typeof catalog?.resume, "string");
    assert.equal(typeof catalog?.disabledByServer, "string");
    assert.equal(typeof catalog?.readSource, "object");
    assert.equal(typeof catalog?.rawTtl, "object");
    assert.equal(typeof catalog?.states, "object");
    assert.equal(typeof catalog?.worker, "object");
    assert.equal(typeof catalog?.storage, "object");
    assert.equal(typeof catalog?.cutover, "object");
    assert.equal(typeof catalog?.load, "object");
    assert.equal(typeof catalog?.coordinator, "object");
    assert.equal(typeof (catalog?.states as Record<string, unknown>)?.waiting_for_base, "string");
  }
});

test("rollup 운영 문서는 고정 T0 자동 전환과 TTL 분리를 안내한다", () => {
  const runbook = repoSource("docs/clickhouse-exact-rollup-runbook.md");
  const readme = repoSource("README.md");
  const compose = repoSource("docker-compose.yml");

  for (const document of [runbook, readme]) {
    assert.match(document, /고정.*T0|T0.*고정/);
    assert.match(document, /60분.*자동.*전환|자동.*전환.*60분/s);
    assert.match(document, /신규 데이터.*전환.*(밀리|초기화).*않/s);
    assert.match(document, /TTL.*별도|별도.*TTL/s);
  }
  assert.match(compose, /CLICKHOUSE_READ_15M_V2_ROLLUP:.*비상.*override/);
  assert.match(compose, /CLICKHOUSE_READ_TIMEZONE_ROLLUP:.*비상.*override/);
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

test("dashboard filters delegate their visual shell to the shared toolbar", () => {
  const toolbar = source("components/dashboard/dashboard-toolbar.tsx");
  const filters = source("components/dashboard/dashboard-filters.tsx");

  assert.match(toolbar, /function DashboardToolbar/);
  assert.match(toolbar, /FeatureStatusBadge/);
  assert.match(toolbar, /splitHeader[\s\S]*filters/);
  assert.match(filters, /<DashboardToolbar[\s\S]*filters=\{filterControls\}/);
  assert.match(filters, /showCustom[\s\S]*<DateRangePicker/);
  assert.match(filters, /<Button size="sm" onClick=\{applyCustom\} disabled=\{!from \|\| !to\}>/);
});

test("demo open mode can render settings with the dashboard viewer fallback", () => {
  const settings = source("app/(dashboard)/settings/page.tsx");
  assert.match(settings, /getDashboardViewer/);
  assert.doesNotMatch(
    settings,
    /const session = await auth\(\);\s*const userId = session\?\.user\?\.id;\s*if \(!userId\) redirect\("\/login"\);/s,
  );
});

test("onboarding token actions issue once and poll within the authenticated owner", () => {
  const actions = source("app/(dashboard)/settings/token-actions.ts");
  assert.match(actions, /issueOnboardingTokenAction/);
  assert.match(actions, /issueDeviceToken\(userId\)/);
  assert.match(actions, /checkTokenConnectionAction/);
  assert.match(actions, /getTokenConnectionStatus\(userId, tokenId\)/);
});

test("Windows installer routes serve generated no-store PowerShell", () => {
  const install = source("app/install.ps1/route.ts");
  const uninstall = source("app/uninstall.ps1/route.ts");
  assert.match(install, /buildPowerShellInstallScript/);
  assert.match(install, /getIngestEndpoint/);
  assert.match(install, /cache-control.*no-store/s);
  assert.match(uninstall, /buildPowerShellUninstallScript/);
  assert.match(uninstall, /cache-control.*no-store/s);
});

test("macOS and Linux one-line installer does not stop for a daemon prompt", () => {
  const install = source("lib/shell-installer.ts");
  assert.match(install, /TOARD_INSTALL_DAEMON/);
  assert.match(install, /:-1/);
});

test("shell installer builder stays outside the Next.js route module", () => {
  const route = source("app/install.sh/route.ts");
  assert.match(route, /@\/lib\/shell-installer/);
  assert.doesNotMatch(route, /export function installScript/);

  const installer = source("lib/shell-installer.ts");
  assert.match(installer, /export function installScript/);

  const e2e = repoSource(".github/scripts/test-shim-installer-unix.sh");
  assert.match(e2e, /lib\/shell-installer\.ts/);
});

test("installers accept an explicit release mirror for pre-release E2E", () => {
  const install = source("lib/shell-installer.ts");
  const releaseInstall = repoSource("shim/install.sh");
  assert.match(install, /TOARD_SHIM_RELEASE_BASE/);
  assert.match(releaseInstall, /TOARD_SHIM_RELEASE_BASE/);
});

test("shim CI parses generated PowerShell when installer routes change", () => {
  const workflow = repoSource(".github/workflows/shim-ci.yml");
  assert.match(workflow, /apps\/web\/lib\/powershell-installer\.ts/);
  assert.match(workflow, /apps\/web\/app\/install\.ps1\/\*\*/);
  assert.match(workflow, /scriptblock.*Create/s);
});

test("shim CI runs installer E2E on Windows, Linux, and macOS", () => {
  const workflow = repoSource(".github/workflows/shim-ci.yml");
  assert.match(workflow, /windows-latest/);
  assert.match(workflow, /ubuntu-latest/);
  assert.match(workflow, /macos-latest/);
  assert.match(workflow, /test-shim-installer-windows\.ps1/);
  assert.match(workflow, /test-shim-installer-unix\.sh/);
});

test("Windows shim CI verifies GUI helper subsystem and scheduled action", () => {
  const workflow = repoSource(".github/workflows/shim-ci.yml");
  const e2e = repoSource(".github/scripts/test-shim-installer-windows.ps1");

  assert.match(workflow, /toard-shim-background\.exe/);
  assert.match(workflow, /Get-PeSubsystem/);
  assert.match(workflow, /expected Windows GUI subsystem 2/);
  assert.match(e2e, /BackgroundBinary/);
  assert.match(e2e, /toard-shim-background\.exe/);
  assert.match(e2e, /\/Query.*\/XML/s);
  assert.match(e2e, /Start-ScheduledTask/);
});

test("device onboarding uses OS-aware wizard and separate management", () => {
  const wizard = source("app/(dashboard)/settings/onboarding-wizard.tsx");
  const panel = source("app/(dashboard)/settings/onboarding-panel.tsx");
  const commands = source("lib/onboarding-install.ts");
  assert.match(wizard, /detectInstallPlatform/);
  assert.match(wizard, /issueOnboardingTokenAction/);
  assert.match(wizard, /checkTokenConnectionAction/);
  assert.match(wizard, /2_000/);
  assert.match(wizard, /120_000/);
  assert.match(wizard, /href="\/"/);
  assert.match(commands, /uninstall\.ps1/);
  assert.match(panel, /buildManagementCommands/);
  assert.doesNotMatch(panel, /\.toard[\\/]credentials|agent_key=/);
  assert.doesNotMatch(panel, /issueOnboardingTokenAction/);
});

test("settings catalogs keep wizard shape aligned", () => {
  const ko = JSON.parse(source("messages/ko/settings.json"));
  const en = JSON.parse(source("messages/en/settings.json"));
  assert.equal(ko.tabInstall, "컴퓨터 연결");
  assert.equal(en.tabInstall, "Connect computer");
  assert.equal(typeof ko.wizard, "object");
  assert.deepEqual(messageShape(ko.wizard), messageShape(en.wizard));
});

test("web test script includes lib and app tests", () => {
  const pkg = JSON.parse(source("package.json")) as { scripts?: { test?: string } };
  const rootPkg = JSON.parse(repoSource("package.json")) as { scripts?: { "test:migrations"?: string } };
  assert.match(pkg.scripts?.test ?? "", /lib\/\*\.test\.ts/);
  assert.match(pkg.scripts?.test ?? "", /app\/\*\*\/\*\.test\.ts/);
  assert.match(rootPkg.scripts?.["test:migrations"] ?? "", /e2ee-content-migration\.integration\.test\.ts/);
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

test("insight KPI deltas use the shared dashboard badge and calculation", () => {
  const page = source("app/(dashboard)/insights/page.tsx");
  const ko = JSON.parse(source("messages/ko/insights.json"));
  const en = JSON.parse(source("messages/en/insights.json"));

  assert.match(page, /DashboardToolbar/);
  assert.match(page, /@\/components\/dashboard\/stat-card/);
  assert.match(page, /@\/lib\/stat-delta/);
  assert.match(page, /<DeltaBadge delta=\{delta\}/);
  assert.match(page, /const tokenDelta = pctDelta\(/);
  assert.match(page, /const sessionsDelta = pctDelta\(/);
  assert.match(page, /const costDelta = costComplete[\s\S]*pctDelta\(/);
  assert.doesNotMatch(page, /const formatComparison/);
  assert.doesNotMatch(page, /signDisplay: "always"/);
  assert.equal(ko.kpi.previousPeriod, "이전 기간 대비");
  assert.equal(en.kpi.previousPeriod, "vs previous period");
});

test("insights와 history 비용 UI는 같은 query coverage formatter를 재사용한다", () => {
  const insights = source("app/(dashboard)/insights/page.tsx");
  const history = source("app/(dashboard)/history/page.tsx");
  const detail = source("app/(dashboard)/history/session-detail.tsx");

  assert.match(insights, /<PricingNotice coverage=\{comparisonCoverage\}/);
  assert.match(insights, /formatCostForCoverage/);
  assert.match(insights, /costComplete[\s\S]*costDelta/);
  assert.match(history, /formatCostForCoverage\(fmtUsd\(usage\.costUsd\), usage\.costCoverage/);
  assert.match(detail, /formatCostForCoverage\(fmtUsd\(summary\.costUsd\), summary\.costCoverage/);
  assert.match(detail, /costCoverageForStatus\(usage\.costStatus\)/);
});

test("insights 비용 표시는 locale 국가 접두사 없이 $ 기호만 사용한다", () => {
  const page = source("app/(dashboard)/insights/page.tsx");
  const chart = source("components/charts/insight-comparison-chart.tsx");

  assert.match(page, /currency: "USD",\s*currencyDisplay: "narrowSymbol"/);
  assert.match(chart, /currency: "USD",\s*currencyDisplay: "narrowSymbol"/);
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
  const comparisonIndex = page.indexOf("getCachedUserInsights(userId, pair, providerKey)");

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

test("insight filters use dashboard button variants and keep URL updates", () => {
  const filters = source("components/dashboard/insight-filters.tsx");
  assert.match(filters, /@\/components\/ui\/button/);
  assert.doesNotMatch(filters, /@\/components\/ui\/segmented-control/);
  assert.match(filters, /@\/components\/ui\/select/);
  assert.match(filters, /size="sm"/);
  assert.match(filters, /variant=\{value === item\.value \? "default" : "outline"\}/);
  assert.match(filters, /new URLSearchParams\(searchParams\.toString\(\)\)/);
});

test("insights use the shared split toolbar while preserving accessible labels", () => {
  const page = source("app/(dashboard)/insights/page.tsx");
  const filters = source("components/dashboard/insight-filters.tsx");

  assert.match(page, /@\/components\/dashboard\/dashboard-toolbar/);
  assert.match(page, /<DashboardToolbar[\s\S]*filters=\{\s*<InsightFilters/);
  assert.match(page, /trailing=\{/);
  assert.match(page, /splitHeader/);
  assert.match(filters, /<div className="flex flex-wrap items-center gap-2">/);
  assert.doesNotMatch(filters, /className="text-muted-foreground text-xs">\{t\("presets\.label"\)\}/);
  assert.doesNotMatch(filters, /className="text-muted-foreground text-xs">\{t\("filters\.providerLabel"\)\}/);
  assert.doesNotMatch(filters, /className="text-muted-foreground text-xs">\{t\("filters\.metricLabel"\)\}/);
  assert.match(filters, /label=\{t\("presets\.label"\)\}/);
  assert.match(filters, /aria-label=\{t\("filters\.providerLabel"\)\}/);
  assert.match(filters, /label=\{t\("filters\.metricLabel"\)\}/);
});

test("insights expose beta status in navigation and the shared toolbar", () => {
  const nav = source("components/dashboard/sidebar-nav.tsx");
  const page = source("app/(dashboard)/insights/page.tsx");

  assert.match(nav, /href: "\/insights", key: "insights", icon: Lightbulb, badge: "beta"/);
  assert.match(page, /getTranslations\("nav"\)/);
  assert.match(
    page,
    /<DashboardToolbar[\s\S]*statusBadge=\{\{ status: "beta", label: navT\("badge\.beta"\) \}\}/,
  );
});

test("team status exposes preview status in navigation and the page toolbar", () => {
  const nav = source("components/dashboard/sidebar-nav.tsx");
  const page = source("app/(dashboard)/org/team/page.tsx");

  assert.match(nav, /href: "\/org\/team", key: "myTeam", icon: Building2, badge: "preview"/);
  assert.match(page, /statusBadge=\{\{ status: "preview", label: navT\("badge\.preview"\) \}\}/);
});

test("team overview uses a bounded hero and separated analysis sections", () => {
  const page = source("app/(dashboard)/org/teams/page.tsx");

  assert.match(page, /function TeamRankingHero/);
  assert.match(page, /<section className="border-border\/80 bg-card rounded-xl border px-5 py-5">/);
  assert.match(
    page,
    /<TeamRankingHero[\s\S]*totalCost=\{rankedCost\}[\s\S]*coverage=\{coverage\}[\s\S]*costLabels=\{costLabels\}[\s\S]*rankCount=\{rows\.length\}[\s\S]*totalSessions=\{rankedSessions\}[\s\S]*topShare=\{/,
  );
  assert.match(page, /data-dashboard-ready="team-overview" className="space-y-6"/);
  assert.match(page, /grid min-w-0 gap-4 2xl:grid-cols-/);
  assert.doesNotMatch(page, /data-dashboard-ready="team-overview" className="contents"/);
});

test("insight comparison chart renders current and previous without animation", () => {
  const chart = source("components/charts/insight-comparison-chart.tsx");
  assert.match(chart, /dataKey="current"[\s\S]*isAnimationActive=\{false\}/);
  assert.match(chart, /dataKey="previous"[\s\S]*isAnimationActive=\{false\}/);
  assert.match(chart, /current\.costCoverage\.unpricedEvents/);
  assert.match(chart, /previous\.costCoverage\.unpricedEvents/);
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
  assert.match(chart, /const currentEnd = new Date\(currentTo\)/);
  assert.match(
    chart,
    /const currentDate = getInsightPositionDate\([\s\S]*currentStart,[\s\S]*position,[\s\S]*timezone,[\s\S]*currentEnd,[\s\S]*\)/,
  );
  assert.match(chart, /if \(currentDate === null\) return \[\];/);
  assert.match(chart, /previous: previousDate === null \? undefined :/);
  assert.match(chart, /chart\.comparisonUnavailable/);
  assert.match(page, /currentFrom=\{pair\.current\.from\.toISOString\(\)\}/);
  assert.match(page, /currentTo=\{pair\.current\.to\.toISOString\(\)\}/);
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
  assert.match(composition, /costCoverage\.unpricedEvents/);
});

test("tool activity copy distinguishes explicit calls from loads", () => {
  const ko = JSON.parse(source("messages/ko/dashboard.json"));
  assert.equal(ko.toolActivity.skillLabel, "스킬 활동");
  assert.equal(ko.toolActivity.explicitBadge, "명시 호출");
  assert.equal(ko.toolActivity.loadedBadge, "로드");
  assert.doesNotMatch(JSON.stringify(ko.toolActivity), /사용한 스킬/);
});

test("overview adds tool activity as a secondary card", () => {
  const overview = source("components/dashboard/overview-view.tsx");
  assert.match(overview, /ToolActivityCard/);
  assert.match(overview, /<ToolActivityCard[^>]*\/>/s);
});

test("tool activity card marks the feature as beta", () => {
  const card = source("components/dashboard/tool-activity-card.tsx");
  assert.match(card, /FeatureStatusBadge/);
  assert.match(card, /status="beta"/);
  assert.match(card, /navT\("badge\.beta"\)/);
});

test("device inventory is current state, not period activity", () => {
  const inventory = source("app/(dashboard)/settings/device-inventory.tsx");
  assert.match(inventory, /DeviceToolInventory/);
  assert.doesNotMatch(inventory, /fromDate|toDate|DashboardPeriod/);
});

test("organization page uses anonymous tool summary without drilldown", () => {
  const org = source("app/(dashboard)/org/page.tsx");
  assert.match(org, /getOrgToolSummary/);
  assert.doesNotMatch(org, /toolActivity.*(?:itemKey|displayName|sessionId)/s);
});

test("history security uses managed status and keeps legacy E2EE conditional", () => {
  const panel = source("app/(dashboard)/settings/history-security-panel.tsx");
  const ko = JSON.parse(source("messages/ko/settings.json"));
  const en = JSON.parse(source("messages/en/settings.json"));
  assert.match(panel, /getUserHistorySecurityStatus/);
  assert.match(panel, /status\?\.legacy/);
  assert.doesNotMatch(panel, /E2EE_MAX_CIPHERTEXT_BYTES|withUserContext|encryption_scheme/);
  for (const messages of [ko, en]) {
    assert.equal(typeof messages.historySecurity.managedEncryption, "string");
    assert.equal(typeof messages.historySecurity.privacyBoundary, "string");
    assert.equal(typeof messages.historySecurity.legacyMigrating, "string");
    assert.equal(typeof messages.historySecurity.legacyComplete, "string");
    assert.equal(typeof messages.historySecurity.legacyBlocked, "string");
  }
});

test("empty legacy page rechecks authoritative status instead of declaring completion", () => {
  const history = source("app/(dashboard)/history/e2ee-history-client.tsx");
  assert.doesNotMatch(history, /if \(result\.complete\) \{ setLegacyRemaining\(0\); return; \}/);
});
