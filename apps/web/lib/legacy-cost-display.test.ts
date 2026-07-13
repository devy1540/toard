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

  assert.match(notice, /state === "complete" \|\| state === "legacy"/);
  assert.doesNotMatch(notice, /pricingNotice\.legacyTitle|pricingNotice\.legacyDescription/);
  assert.match(overview, /legacyCostHintCount\(overview\.costCoverage\)/);
  assert.match(overview, /costCoverage\.legacyHint/);
  assert.match(classic, /legacyCostHintCount\(overview\.costCoverage\)/);
  assert.match(classic, /costCoverage\.legacyHint/);
});
