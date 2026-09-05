import assert from "node:assert/strict";
import test from "node:test";
import { costCoverageForStatus, costCoverageState, formatCostForCoverage } from "./cost-coverage";

test("estimated events remain visible and cannot make an unpriced mix look empty", () => {
  const estimated = costCoverageForStatus("estimated");
  assert.equal(costCoverageState(estimated), "estimated");
  assert.equal(costCoverageState({ ...estimated, unpricedEvents: 1 }), "partial");
  assert.equal(formatCostForCoverage("$1.72", estimated, { partial: "partial", unpriced: "unpriced", legacy: "legacy", estimated: "assumptions" }), "$1.72 · assumptions");
});
