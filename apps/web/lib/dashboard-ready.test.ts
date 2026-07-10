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
