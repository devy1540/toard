import assert from "node:assert/strict";
import test from "node:test";
import { csvCell } from "./report-csv";
test("spreadsheet formulas are escaped as text while negative numeric deltas remain numeric", () => {
  for (const value of ["=2+2", "+cmd", "-formula", "@SUM(A1)", " \t=HYPERLINK(\"x\")", "\r=1"]) assert.ok(csvCell(value).startsWith('"\''));
  assert.equal(csvCell(-1.25), "-1.25");
  assert.equal(csvCell('model,"test"\nsecond'), '"model,""test""\nsecond"');
  assert.equal(csvCell(null), "");
  assert.throws(() => csvCell(Infinity));
});
