import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const pageSource = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const clientSource = readFileSync(new URL("./e2ee-history-client.tsx", import.meta.url), "utf8");

test("active E2EE history returns before the legacy history query", () => {
  const branch = pageSource.indexOf("contentStatus.state !== \"off\"");
  const legacyQuery = pageSource.indexOf("getMyHistorySessions(");

  assert.ok(branch >= 0, "missing E2EE state branch");
  assert.ok(legacyQuery > branch, "legacy history query must stay after the E2EE early return");
});

test("E2EE history uses the shared filters and session list", () => {
  assert.match(clientSource, /DashboardFilters/);
  assert.match(clientSource, /HistorySessionList/);
  assert.doesNotMatch(clientSource, /<h2[^>]*>\{t\("title"\)\}<\/h2>/);
});
