import assert from "node:assert/strict";
import test from "node:test";
import {
  addLocalCalendarDays,
  canonicalTimezoneId,
  firstInstantOfLocalDate,
  localDateKey,
} from "./timezone";

test("timezone alias는 하나의 canonical IANA ID로 수렴한다", () => {
  assert.equal(canonicalTimezoneId("US/Pacific"), "America/Los_Angeles");
  assert.equal(canonicalTimezoneId("America/Los_Angeles"), "America/Los_Angeles");
  assert.equal(canonicalTimezoneId("Asia/Kolkata"), "Asia/Calcutta");
  assert.equal(canonicalTimezoneId("Asia/Kathmandu"), "Asia/Katmandu");
  assert.equal(canonicalTimezoneId("PST"), null);
});

test("자정 gap local date는 그 날짜의 실제 첫 instant를 반환한다", () => {
  const first = firstInstantOfLocalDate("2025-09-07", "America/Santiago");

  assert.equal(first.toISOString(), "2025-09-07T04:00:00.000Z");
  assert.equal(localDateKey(first, "America/Santiago"), "2025-09-07");
  assert.equal(localDateKey(new Date(first.getTime() - 1), "America/Santiago"), "2025-09-06");
});

test("local-date resolver는 UTC millisecond 경계와 DST 날짜를 정확히 찾는다", () => {
  const first = firstInstantOfLocalDate("2026-03-08", "America/Los_Angeles");

  assert.equal(first.toISOString(), "2026-03-08T08:00:00.000Z");
  assert.equal(localDateKey(first, "America/Los_Angeles"), "2026-03-08");
  assert.equal(localDateKey(new Date(first.getTime() - 1), "America/Los_Angeles"), "2026-03-07");
  assert.equal(addLocalCalendarDays("2026-03-08", 1), "2026-03-09");
});

test("local-date resolver의 탐색 범위에 존재하지 않는 날짜는 거부한다", () => {
  assert.throws(
    () => firstInstantOfLocalDate("2011-12-30", "Pacific/Apia"),
    /존재하지 않는 local date/,
  );
  assert.throws(() => firstInstantOfLocalDate("2025-02-30", "UTC"), /YYYY-MM-DD/);
});
