import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFilters } from "./period";

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
