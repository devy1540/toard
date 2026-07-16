import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

function source(path: string): string {
  const url = new URL(`../${path}`, import.meta.url);
  return existsSync(url) ? readFileSync(url, "utf8") : "";
}

test("공식 shadcn 기반 컴포넌트를 로컬 UI 계층에 둔다", () => {
  assert.match(source("components/ui/alert.tsx"), /data-slot="alert"/);
  assert.match(source("components/ui/toggle.tsx"), /data-slot="toggle"/);
  assert.match(source("components/ui/toggle-group.tsx"), /ToggleGroupPrimitive/);
  assert.match(source("components/ui/field.tsx"), /data-slot="field"/);
});

test("경고와 성공 callout은 현재 시각 클래스를 유지한 shared Alert를 쓴다", () => {
  const pricing = source("components/dashboard/pricing-notice.tsx");
  const admin = source("app/(dashboard)/admin/page.tsx");
  const invites = source("app/(dashboard)/admin/invite-panel.tsx");

  for (const file of [pricing, admin, invites]) {
    assert.match(file, /@\/components\/ui\/alert/);
  }
  assert.match(pricing, /<Alert className="flex items-start gap-2 rounded-md border border-amber-500\/40 bg-amber-500\/5 p-3 text-sm">/);
  assert.match(admin, /<Alert className="flex items-start gap-2 rounded-md border border-amber-500\/40 bg-amber-500\/5 p-3 text-sm">/);
  assert.match(invites, /<Alert className="block rounded-md border border-emerald-500\/40 bg-emerald-500\/5 p-3 text-sm">/);
});

test("선택 컨트롤은 현재 외형을 보존한 shadcn Toggle 기반이다", () => {
  const segmented = source("components/ui/segmented-control.tsx");
  const appearance = source("app/(dashboard)/settings/appearance-form.tsx");

  assert.match(segmented, /@\/components\/ui\/toggle-group/);
  assert.match(segmented, /<ToggleGroup/);
  assert.match(segmented, /<ToggleGroupItem/);
  assert.match(segmented, /gap-0\.5/);
  assert.match(segmented, /h-7/);
  assert.match(segmented, /rounded-sm/);
  assert.match(appearance, /@\/components\/ui\/toggle/);
  assert.match(appearance, /<Toggle/);
  assert.doesNotMatch(appearance, /<button[\s\S]*BRAND_SWATCHES/);
});

test("설정 행은 shadcn Field 기반의 compact와 settings 레이아웃을 공유한다", () => {
  const row = source("components/dashboard/settings-row.tsx");
  const appearance = source("app/(dashboard)/settings/appearance-form.tsx");
  const settings = source("app/(dashboard)/settings/page.tsx");

  assert.match(row, /@\/components\/ui\/field/);
  assert.match(row, /layout\?: "compact" \| "settings"/);
  assert.match(row, /lg:grid-cols-\[16rem_minmax\(0,1fr\)\]/);
  assert.match(appearance, /SettingsRow/);
  assert.doesNotMatch(appearance, /<section className="grid min-w-0 gap-3 py-4/);
  assert.match(settings, /<SettingsRow[\s\S]*loginMethods\.google/);
  assert.match(settings, /<SettingsRow[\s\S]*account\.(?:changeTitle|setTitle)/);
});

test("조직 지표는 페이지 로컬 복제 없이 shared 제품 컴포넌트를 쓴다", () => {
  const org = source("app/(dashboard)/org/page.tsx");
  const team = source("app/(dashboard)/org/team/page.tsx");
  const teams = source("app/(dashboard)/org/teams/page.tsx");
  const summary = source("components/dashboard/summary-tile.tsx");
  const supporting = source("components/dashboard/supporting-metric.tsx");

  assert.match(summary, /function SummaryTile/);
  assert.match(summary, /border-border\/70 min-w-0 border-l pl-3/);
  assert.match(supporting, /@\/components\/ui\/card/);
  assert.match(supporting, /border-border\/80 bg-card min-w-0 gap-0 rounded-xl border px-4 py-4 shadow-sm/);

  for (const page of [org, team, teams]) {
    assert.match(page, /@\/components\/dashboard\/summary-tile/);
    assert.doesNotMatch(page, /function SummaryTile/);
  }
  for (const page of [org, team]) {
    assert.match(page, /@\/components\/dashboard\/supporting-metric/);
    assert.doesNotMatch(page, /function SupportingMetric/);
  }
});
