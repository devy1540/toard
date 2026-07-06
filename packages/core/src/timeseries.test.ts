import assert from "node:assert/strict";
import { test } from "node:test";
import type { DailyPoint } from "./storage";
import { fillHourlyGaps, hourKey } from "./timeseries";

const pt = (day: string, tokens = 100): DailyPoint => ({
  day,
  sessions: 1,
  costUsd: 1,
  inputTokens: tokens,
  outputTokens: 0,
});

test("hourKey — 타임존 벽시계 기준 'YYYY-MM-DD HH:00'", () => {
  const at = new Date("2026-07-06T05:30:45Z");
  assert.equal(hourKey(at, "UTC"), "2026-07-06 05:00");
  assert.equal(hourKey(at, "Asia/Seoul"), "2026-07-06 14:00"); // UTC+9
  // 자정 경계 — h23 이므로 '24:00' 이 아니라 다음날 '00:00'
  assert.equal(hourKey(new Date("2026-07-06T15:00:00Z"), "Asia/Seoul"), "2026-07-07 00:00");
});

test("fillHourlyGaps — 자정부터 now 가 속한 시간까지 빈 버킷을 0 으로 채운다", () => {
  const from = new Date("2026-07-06T00:00:00Z");
  const now = new Date("2026-07-06T05:30:00Z");
  const filled = fillHourlyGaps(
    [pt("2026-07-06 02:00"), pt("2026-07-06 05:00")],
    { from, to: now }, // 오늘 필터: to = now
    "UTC",
    now,
  );
  assert.deepEqual(
    filled.map((p) => p.day),
    ["2026-07-06 00:00", "2026-07-06 01:00", "2026-07-06 02:00", "2026-07-06 03:00", "2026-07-06 04:00", "2026-07-06 05:00"],
  );
  // 실데이터는 보존, 나머지는 0
  assert.equal(filled[2]!.inputTokens, 100);
  assert.equal(filled[0]!.inputTokens, 0);
  assert.equal(filled[0]!.sessions, 0);
});

test("fillHourlyGaps — 과거 하루짜리 커스텀 범위는 24시간 전부 채운다", () => {
  const from = new Date("2026-07-01T00:00:00Z");
  const to = new Date("2026-07-02T00:00:00Z"); // exclusive 상한
  const now = new Date("2026-07-06T12:00:00Z");
  const filled = fillHourlyGaps([pt("2026-07-01 23:00")], { from, to }, "UTC", now);
  assert.equal(filled.length, 24, "00시~23시 24개 버킷");
  assert.equal(filled[0]!.day, "2026-07-01 00:00");
  assert.equal(filled[23]!.day, "2026-07-01 23:00");
  assert.equal(filled[23]!.inputTokens, 100);
});

test("fillHourlyGaps — 조직 타임존 자정 경계로 채운다 (Asia/Seoul)", () => {
  // 서울 2026-07-06 00:00 = UTC 2026-07-05 15:00
  const from = new Date("2026-07-05T15:00:00Z");
  const now = new Date("2026-07-05T17:10:00Z"); // 서울 02:10
  const filled = fillHourlyGaps([], { from, to: now }, "Asia/Seoul", now);
  assert.deepEqual(
    filled.map((p) => p.day),
    ["2026-07-06 00:00", "2026-07-06 01:00", "2026-07-06 02:00"],
  );
});

test("fillHourlyGaps — 생성 범위 밖 키는 버리지 않고 정렬 병합", () => {
  const from = new Date("2026-07-06T00:00:00Z");
  const now = new Date("2026-07-06T01:30:00Z");
  const filled = fillHourlyGaps([pt("2026-07-06 03:00")], { from, to: now }, "UTC", now);
  assert.deepEqual(
    filled.map((p) => p.day),
    ["2026-07-06 00:00", "2026-07-06 01:00", "2026-07-06 03:00"],
  );
});
