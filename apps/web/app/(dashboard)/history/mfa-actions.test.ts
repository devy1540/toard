import assert from "node:assert/strict";
import test from "node:test";
import { safeHistoryReturnTo } from "./history-return";

test("history MFA return path stays inside My history", () => {
  assert.equal(safeHistoryReturnTo("/history"), "/history");
  assert.equal(safeHistoryReturnTo("/history?session=s1"), "/history?session=s1");
  assert.equal(safeHistoryReturnTo("https://example.com"), "/history");
  assert.equal(safeHistoryReturnTo("/history-archive"), "/history");
});
