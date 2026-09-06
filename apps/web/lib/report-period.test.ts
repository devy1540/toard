import assert from "node:assert/strict";
import test from "node:test";
import { reportPeriod } from "./report-period";

test("reports compare completed Sunday-start weeks using actual local date boundaries", () => {
  const period = reportPeriod(undefined, "Asia/Seoul", new Date("2026-09-06T03:00:00Z"));
  assert.equal(period.week, "2026-08-30");
  assert.equal(period.lastDate, "2026-09-05");
  assert.equal(period.current.from.toISOString(), "2026-08-29T15:00:00.000Z");
  assert.equal(period.current.to.toISOString(), "2026-09-05T15:00:00.000Z");
  assert.equal(period.previous.to.getTime(), period.current.from.getTime());
});
test("DST weeks use seven local dates rather than forcing 168 elapsed hours", () => {
  const period = reportPeriod("2026-03-08", "America/New_York", new Date("2026-03-16T12:00:00Z"));
  assert.equal((period.current.to.getTime() - period.current.from.getTime()) / 3_600_000, 167);
  assert.equal((period.previous.to.getTime() - period.previous.from.getTime()) / 3_600_000, 168);
});
test("invalid, incomplete and no-longer-retained comparisons do not become empty reports", () => {
  const now = new Date("2026-09-06T03:00:00Z");
  for (const week of ["2026-02-30", "2026-09-06", "2026-09-01", "2020-01-05", "invalid"]) assert.throws(() => reportPeriod(week, "UTC", now));
});
