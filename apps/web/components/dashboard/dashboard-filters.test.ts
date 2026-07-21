import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("DashboardFilters는 네이티브 date input 대신 shadcn 범위 선택기를 사용한다", () => {
  const source = readFileSync(new URL("./dashboard-filters.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(source, /type=["']date["']/);
  assert.match(source, /<DateRangePicker/);
  assert.match(source, /calendarRangeToDateKeys/);
});
