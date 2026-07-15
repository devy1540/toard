import assert from "node:assert/strict";
import { test } from "node:test";
import {
  calendarDateToDateKey,
  calendarRangeToDateKeys,
  dateKeyToCalendarDate,
  dateKeysToCalendarRange,
  isCompleteCalendarRange,
} from "./date-range";

test("Calendar 날짜를 timezone 이동 없이 날짜 키로 변환한다", () => {
  assert.equal(calendarDateToDateKey(new Date(2026, 6, 15, 12)), "2026-07-15");
  assert.deepEqual(
    calendarRangeToDateKeys({ from: new Date(2026, 6, 31, 12), to: new Date(2026, 7, 1, 12) }),
    { from: "2026-07-31", to: "2026-08-01" },
  );
});

test("유효한 날짜 키만 Calendar 날짜로 변환한다", () => {
  const leapDay = dateKeyToCalendarDate("2024-02-29");
  assert.equal(leapDay?.getFullYear(), 2024);
  assert.equal(leapDay?.getMonth(), 1);
  assert.equal(leapDay?.getDate(), 29);
  assert.equal(leapDay?.getHours(), 12);

  assert.equal(dateKeyToCalendarDate("2025-02-29"), undefined);
  assert.equal(dateKeyToCalendarDate("2026-13-01"), undefined);
  assert.equal(dateKeyToCalendarDate("2026-7-01"), undefined);
  assert.equal(dateKeyToCalendarDate("not-a-date"), undefined);
});

test("시작일만 선택한 부분 범위를 유지하고 잘못된 종료일은 거부한다", () => {
  const partial = dateKeysToCalendarRange("2026-07-12", "");
  assert.equal(partial?.from?.getDate(), 12);
  assert.equal(partial?.to, undefined);
  assert.equal(dateKeysToCalendarRange("2026-07-12", "invalid"), undefined);

  const range = dateKeysToCalendarRange("2026-07-12", "2026-07-15");
  assert.equal(range?.from?.getDate(), 12);
  assert.equal(range?.to?.getDate(), 15);
});

test("같은 날도 완성된 범위로 인정하고 시작일만 있으면 미완성으로 본다", () => {
  const day = new Date(2026, 6, 15, 12);
  assert.equal(isCompleteCalendarRange({ from: day }), false);
  assert.equal(isCompleteCalendarRange({ from: day, to: day }), true);
  assert.equal(calendarRangeToDateKeys({ from: day }), undefined);
  assert.deepEqual(calendarRangeToDateKeys({ from: day, to: day }), {
    from: "2026-07-15",
    to: "2026-07-15",
  });
});
