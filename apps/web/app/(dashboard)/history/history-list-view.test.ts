import assert from "node:assert/strict";
import test from "node:test";
import { historyDayKey, historyPagination } from "./history-list-view";

test("history day keys respect viewer timezone", () => {
  assert.equal(historyDayKey("2026-07-14T15:30:00.000Z", "Asia/Seoul"), "2026-07-15");
  assert.equal(historyDayKey("2026-07-14T15:30:00.000Z", "UTC"), "2026-07-14");
});

test("history pagination uses twenty rows and exposes both directions", () => {
  assert.deepEqual(historyPagination(2, 45), {
    page: 2,
    totalPages: 3,
    hasPrev: true,
    hasNext: true,
  });
});
