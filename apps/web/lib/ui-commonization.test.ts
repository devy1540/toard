import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
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

test("insight filters reuse shared controls and update URL parameters", () => {
  const filters = source("components/dashboard/insight-filters.tsx");
  assert.match(filters, /@\/components\/ui\/segmented-control/);
  assert.match(filters, /@\/components\/ui\/select/);
  assert.match(filters, /new URLSearchParams\(searchParams\.toString\(\)\)/);
});

test("insight comparison chart renders current and previous without animation", () => {
  const chart = source("components/charts/insight-comparison-chart.tsx");
  assert.match(chart, /dataKey="current"[\s\S]*isAnimationActive=\{false\}/);
  assert.match(chart, /dataKey="previous"[\s\S]*isAnimationActive=\{false\}/);
});

test("insight composition uses shared tabs and limits rows", () => {
  const composition = source("components/dashboard/insight-composition.tsx");
  assert.match(composition, /@\/components\/ui\/segmented-control/);
  assert.match(composition, /\.slice\(0, 5\)/);
});
