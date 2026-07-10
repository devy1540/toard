import assert from "node:assert/strict";
import test from "node:test";
import { DASHBOARD_VIEWS, DEFAULT_VIEW, isDashboardView } from "./dashboard-view";

test("my usage exposes overview and classic layouts", () => {
  assert.deepEqual(DASHBOARD_VIEWS, ["overview", "classic"]);
  assert.equal(DEFAULT_VIEW, "overview");
});

test("legacy stats preference falls back to the overview layout", () => {
  assert.equal(isDashboardView("overview"), true);
  assert.equal(isDashboardView("classic"), true);
  assert.equal(isDashboardView("stats"), false);
});
