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
