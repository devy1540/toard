import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const pageSource = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const clientSource = readFileSync(new URL("./e2ee-history-client.tsx", import.meta.url), "utf8");

test("active E2EE source returns before the managed server history query", () => {
  const branch = pageSource.indexOf("contentStatus.state === \"active\"");
  const managedQuery = pageSource.indexOf("getMyHistorySessions(");

  assert.ok(branch >= 0, "missing E2EE state branch");
  assert.ok(managedQuery > branch, "managed history query must stay after the E2EE early return");
});

test("E2EE history uses the shared filters and session list", () => {
  assert.match(clientSource, /DashboardFilters/);
  assert.match(clientSource, /HistorySessionList/);
  assert.doesNotMatch(clientSource, /<h2[^>]*>\{t\("title"\)\}<\/h2>/);
});

test("active E2EE migration cannot be bypassed to paginate partial managed history", () => {
  assert.match(pageSource, /getE2eeManagedMigrationStatus/);
  assert.match(pageSource, /contentStatus\.state === "active"[\s\S]*migrationStatus\.state !== "complete"[\s\S]*return \([\s\S]*<E2eeHistoryClient/);
  assert.doesNotMatch(pageSource, /contentStatus\.state === "active" && sp\.source !== "managed"/);
  assert.doesNotMatch(pageSource, /source: "managed"[\s\S]*history\.managedSourceLabel/);
});

test("pending E2EE setup falls through to managed server history instead of E2EE fatal UI", () => {
  assert.doesNotMatch(pageSource, /contentStatus\.state !== "off"[\s\S]*<E2eeHistoryClient/);
  assert.match(pageSource, /contentStatus\.state === "active"/);
});

test("E2EE API filter query removes the UI-only source parameter", () => {
  assert.match(clientSource, /params\.delete\("source"\)/);
});

test("E2EE to managed migration replaces the legacy auto-worker and hides partial history", () => {
  assert.doesNotMatch(clientSource, /runLegacyMigrationBatch|nextLegacyMigrationBatchLimit/);
  assert.match(clientSource, /createE2eeToManagedLoop/);
  assert.match(clientSource, /ManagedMigrationPanel/);
  assert.match(clientSource, /onComplete:[\s\S]*lock\(false\)[\s\S]*router\.refresh\(\)/);
  assert.match(clientSource, /const migrationPanel = managedMigrationVisible[\s\S]*<ManagedMigrationPanel/);
  assert.match(clientSource, /if \(managedMigrationVisible\)[\s\S]*return \([\s\S]*\{migrationPanel\}/);
});
