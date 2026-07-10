import assert from "node:assert/strict";
import test from "node:test";
import { buildInsightPeriodPair, getInsightPeriodAnchor, parseInsightPreset } from "./insight-period";

test("parseInsightPreset는 세 프리셋 외 값을 최근 7일로 폴백한다", () => {
  assert.equal(parseInsightPreset("week"), "week");
  assert.equal(parseInsightPreset("month"), "month");
  assert.equal(parseInsightPreset("7"), "7");
  assert.equal(parseInsightPreset("custom"), "7");
});

test("최근 7일은 직전 7일과 연속되고 겹치지 않는다", () => {
  const now = new Date("2026-07-10T04:00:00.000Z");
  const pair = buildInsightPeriodPair("7", "Asia/Seoul", now);
  assert.equal(pair.current.to.toISOString(), now.toISOString());
  assert.equal(pair.previous.to.toISOString(), pair.current.from.toISOString());
  assert.equal(pair.current.to.getTime() - pair.current.from.getTime(), 7 * 86_400_000);
  assert.equal(pair.previous.to.getTime() - pair.previous.from.getTime(), 7 * 86_400_000);
});

test("이번 주는 지난주의 같은 경과 길이와 비교한다", () => {
  const now = new Date("2026-07-08T03:30:00.000Z");
  const pair = buildInsightPeriodPair("week", "Asia/Seoul", now);
  assert.equal(pair.current.to.toISOString(), now.toISOString());
  assert.equal(
    pair.current.to.getTime() - pair.current.from.getTime(),
    pair.previous.to.getTime() - pair.previous.from.getTime(),
  );
  assert.equal(pair.previous.to.getTime() <= pair.current.from.getTime(), true);
});

test("이번 달은 지난달 말일을 넘기지 않는다", () => {
  const now = new Date("2026-03-31T12:00:00.000Z");
  const pair = buildInsightPeriodPair("month", "UTC", now);
  assert.equal(pair.previous.to.toISOString(), "2026-03-01T00:00:00.000Z");
  assert.equal(pair.previous.from.toISOString(), "2026-02-01T00:00:00.000Z");
});

test("같은 10분 버킷의 요청 시각은 같은 인사이트 anchor를 사용한다", () => {
  const first = getInsightPeriodAnchor(new Date("2026-07-10T04:21:01.000Z"));
  const last = getInsightPeriodAnchor(new Date("2026-07-10T04:29:59.999Z"));

  assert.equal(first.toISOString(), "2026-07-10T04:20:00.000Z");
  assert.equal(last.toISOString(), first.toISOString());
});

test("다음 10분 버킷은 다른 인사이트 anchor를 사용한다", () => {
  const current = getInsightPeriodAnchor(new Date("2026-07-10T04:29:59.999Z"));
  const next = getInsightPeriodAnchor(new Date("2026-07-10T04:30:00.000Z"));

  assert.notEqual(next.toISOString(), current.toISOString());
  assert.equal(next.toISOString(), "2026-07-10T04:30:00.000Z");
});
