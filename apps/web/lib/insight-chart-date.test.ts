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

test("3월과 2월 비교에서 2월 말일 뒤 position은 비교 날짜가 없다", () => {
  const previousFrom = new Date("2026-02-01T00:00:00.000Z");
  const previousTo = new Date("2026-03-01T00:00:00.000Z");

  assert.equal(
    getInsightPositionDate(previousFrom, 27, "UTC", previousTo)?.toISOString(),
    "2026-02-28T12:00:00.000Z",
  );
  assert.equal(getInsightPositionDate(previousFrom, 28, "UTC", previousTo), null);
});

test("DST 전환 기간의 exclusive 종료일도 캘린더 날짜 경계로 판정한다", () => {
  const previousFrom = new Date("2026-03-07T08:00:00.000Z");
  const previousTo = new Date("2026-03-10T07:00:00.000Z");

  assert.equal(
    getInsightPositionDate(
      previousFrom,
      2,
      "America/Los_Angeles",
      previousTo,
    )?.toISOString(),
    "2026-03-09T12:00:00.000Z",
  );
  assert.equal(
    getInsightPositionDate(previousFrom, 3, "America/Los_Angeles", previousTo),
    null,
  );
});
