import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

test("legacy 가격 상태는 상단 배너 없이 개인 비용 KPI의 보조 문구로 표시된다", () => {
  const notice = source("components/dashboard/pricing-notice.tsx");
  const overview = source("components/dashboard/overview-view.tsx");
  const classic = source("components/dashboard/classic-view.tsx");
  const usage = source("lib/dashboard-usage.ts");

  assert.match(notice, /state === "complete" \|\| state === "legacy"/);
  assert.doesNotMatch(notice, /pricingNotice\.legacyTitle|pricingNotice\.legacyDescription/);
  assert.match(overview, /legacyCostHintCount\(overview\.costCoverage\)/);
  assert.match(overview, /costCoverage\.legacyHint/);
  assert.match(classic, /legacyCostHintCount\(overview\.costCoverage\)/);
  assert.match(classic, /costCoverage\.legacyHint/);
  assert.match(classic, /formatCoveredCost/);
  assert.match(usage, /return formatCostForCoverage\(fmtUsd\(costUsd\), coverage, labels\)/);
  assert.doesNotMatch(classic, /state === "legacy"[\s\S]*labels\.legacy/);
});

test("legacy 가격 보조 문구는 인사이트와 조직·팀의 대표 비용 KPI에 공통 적용된다", () => {
  const insights = source("app/(dashboard)/insights/page.tsx");
  const org = source("app/(dashboard)/org/page.tsx");
  const teams = source("app/(dashboard)/org/teams/page.tsx");
  const team = source("app/(dashboard)/org/team/page.tsx");

  assert.match(insights, /legacyCostHintCount\(comparison\.current\.costCoverage\)/);
  assert.match(insights, /costComplete[\s\S]*costCoverage\.legacyHint/);
  assert.match(org, /legacyCostHintCount\(overview\.costCoverage\)/);
  assert.match(teams, /legacyCostHintCount\(coverage\)/);
  assert.match(team, /legacyCostHintCount\(overview\.costCoverage\)/);

  for (const page of [insights, org, teams, team]) {
    assert.match(page, /costCoverage\.legacyHint/);
  }
});
