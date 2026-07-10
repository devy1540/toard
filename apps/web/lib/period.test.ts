import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DASHBOARD_MAX_RANGE_DAYS, parseDashboardPeriod, parseFilters } from "./period";

test("parseFilters — 오늘은 요청한 하루 안 버킷을 사용한다", () => {
  assert.equal(parseFilters({ period: "today", bucket: "15m" }, "UTC").bucket, "15m");
  assert.equal(parseFilters({ period: "today", bucket: "30m" }, "UTC").bucket, "30m");
  assert.equal(parseFilters({ period: "today" }, "UTC").bucket, "hour");
});

test("parseFilters — 하루 범위가 아니면 분 단위 버킷을 무시한다", () => {
  assert.equal(parseFilters({ period: "week", bucket: "15m" }, "UTC").bucket, "day");
  assert.equal(
    parseFilters({ period: "custom", from: "2026-07-01", to: "2026-07-02", bucket: "30m" }, "UTC").bucket,
    "day",
  );
});

test("parseFilters — 단일 일자 커스텀은 하루 안 버킷을 허용한다", () => {
  assert.equal(
    parseFilters({ period: "custom", from: "2026-07-01", to: "2026-07-01", bucket: "30m" }, "UTC").bucket,
    "30m",
  );
});

test("parseFilters — 잘못된 버킷 값은 1시간으로 폴백한다", () => {
  assert.equal(parseFilters({ period: "today", bucket: "5m" }, "UTC").bucket, "hour");
});

test("일반 대시보드의 all은 최근 366일로 제한하고 limited를 반환한다", () => {
  const period = parseDashboardPeriod({ period: "all" }, "UTC");

  assert.equal(period.limited, true);
  assert.equal(period.preset, "all");
  assert.ok(period.to.getTime() - period.from.getTime() <= DASHBOARD_MAX_RANGE_DAYS * 86_400_000);
});

test("366일 초과 custom만 최근 366일로 제한한다", () => {
  const over = parseDashboardPeriod(
    { period: "custom", from: "2025-01-01", to: "2026-02-10" },
    "UTC",
  );
  const exact = parseDashboardPeriod(
    { period: "custom", from: "2024-01-01", to: "2024-12-31" },
    "UTC",
  );

  assert.equal(over.limited, true);
  assert.equal(over.to.getTime() - over.from.getTime(), DASHBOARD_MAX_RANGE_DAYS * 86_400_000);
  assert.equal(exact.limited, false);
  assert.equal(exact.to.getTime() - exact.from.getTime(), DASHBOARD_MAX_RANGE_DAYS * 86_400_000);
});

test("history용 parseFilters all은 epoch 시작을 그대로 보존한다", () => {
  const period = parseFilters({ period: "all" }, "UTC", "all");

  assert.equal(period.from.getTime(), 0);
  assert.equal(period.preset, "all");
  assert.equal("limited" in period, false);
});

test("일반 대시보드 네 페이지는 limited prop을 전파하고 history는 기존 all parser를 유지한다", () => {
  const pages = [
    new URL("../app/(dashboard)/page.tsx", import.meta.url),
    new URL("../app/(dashboard)/org/page.tsx", import.meta.url),
    new URL("../app/(dashboard)/org/team/page.tsx", import.meta.url),
    new URL("../app/(dashboard)/org/teams/page.tsx", import.meta.url),
  ];
  for (const page of pages) {
    const source = readFileSync(page, "utf8");
    assert.match(source, /parseDashboardPeriod\(sp, await getViewerTimezone\(\)\)/);
    assert.match(source, /<DashboardFilters[\s\S]*?limited=\{period\.limited\}/);
  }

  const history = readFileSync(new URL("../app/(dashboard)/history/page.tsx", import.meta.url), "utf8");
  assert.match(history, /parseFilters\(sp, timezone, "all"\)/);
  assert.doesNotMatch(history, /parseDashboardPeriod/);
});

test("DashboardFilters는 limited 안내를 한영 번역으로 렌더한다", () => {
  const component = readFileSync(
    new URL("../components/dashboard/dashboard-filters.tsx", import.meta.url),
    "utf8",
  );
  const ko = JSON.parse(readFileSync(new URL("../messages/ko/dashboard.json", import.meta.url), "utf8"));
  const en = JSON.parse(readFileSync(new URL("../messages/en/dashboard.json", import.meta.url), "utf8"));

  assert.match(component, /limited\?: boolean/);
  assert.match(component, /t\("filters\.rangeLimited"\)/);
  assert.equal(ko.filters.rangeLimited, "최근 12개월까지만 표시합니다");
  assert.equal(en.filters.rangeLimited, "Showing up to the last 12 months");
});
