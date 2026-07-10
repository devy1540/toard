import assert from "node:assert/strict";
import test from "node:test";
import { getInsightPositionDate } from "./insight-chart-date";

test("최근 7일의 position 0부터 7까지 실제 캘린더 날짜로 변환한다", () => {
  const from = new Date("2026-07-03T05:30:00.000Z");
  assert.equal(getInsightPositionDate(from, 0, "Asia/Seoul").toISOString(), "2026-07-03T12:00:00.000Z");
  assert.equal(getInsightPositionDate(from, 7, "Asia/Seoul").toISOString(), "2026-07-10T12:00:00.000Z");
});

test("DST 전환에도 24시간이 아닌 캘린더 일수를 더한다", () => {
  const from = new Date("2026-03-07T20:00:00.000Z");
  assert.equal(
    getInsightPositionDate(from, 2, "America/Los_Angeles").toISOString(),
    "2026-03-09T12:00:00.000Z",
  );
});
