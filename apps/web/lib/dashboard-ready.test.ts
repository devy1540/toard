import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");

test("dashboard HTTP 성공 marker는 shell이 아니라 실제 데이터 컴포넌트에만 있다", () => {
  const overview = source("../components/dashboard/overview-view.tsx");
  const classic = source("../components/dashboard/classic-view.tsx");
  const org = source("../app/(dashboard)/org/page.tsx");
  const team = source("../app/(dashboard)/org/team/page.tsx");
  const shell = source("../app/(dashboard)/layout.tsx");

  assert.match(overview, /data-dashboard-ready="user-overview"/);
  assert.match(classic, /data-dashboard-ready="user-overview"/);
  assert.match(org, /data-dashboard-ready="org-overview"/);
  assert.match(team, /data-dashboard-ready="team-overview"/);
  assert.doesNotMatch(shell, /data-dashboard-ready/);
  assert.ok(
    org.indexOf('data-dashboard-ready="org-overview"') > org.indexOf("async function OverviewTab"),
    "org marker는 OverviewTab 데이터 query 성공 뒤에만 렌더해야 한다",
  );
  assert.ok(
    team.indexOf('data-dashboard-ready="team-overview"') > team.indexOf("async function TeamDetailOverview"),
    "team marker는 TeamDetailOverview 데이터 query 성공 뒤에만 렌더해야 한다",
  );
});

test("조직 overview는 하나의 core snapshot loader를 사용하고 선택 섹션 실패에도 ready marker를 유지한다", () => {
  const org = source("../app/(dashboard)/org/page.tsx");
  const readyMarker = org.indexOf('data-dashboard-ready="org-overview"');
  const coreLoader = org.indexOf("loadOrganizationDashboardData(");
  const toolAvailable = org.indexOf('toolActivity.state === "available"');
  const utilizationAvailable = org.indexOf('utilization.state === "available"');

  assert.ok(coreLoader >= 0, "org overview는 getOrganizationDashboard 기반 loader를 호출해야 한다");
  assert.ok(readyMarker > coreLoader, "ready marker는 성공한 core snapshot loading 뒤에 렌더해야 한다");
  assert.ok(readyMarker < toolAvailable, "tool activity unavailable branch는 core ready marker를 gate하면 안 된다");
  assert.ok(readyMarker < utilizationAvailable, "utilization unavailable branch는 core ready marker를 gate하면 안 된다");
  for (const legacyRead of ["getOverview(", "getDailyTimeseries(", "getLeaderboard(", "getProviderBreakdown("]) {
    assert.equal(org.includes(legacyRead), false, `org overview는 legacy ${legacyRead}를 직접 호출하면 안 된다`);
  }
});
