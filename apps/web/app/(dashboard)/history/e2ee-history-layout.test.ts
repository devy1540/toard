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

test("active E2EE users can explicitly switch between E2EE and managed server history", () => {
  assert.match(pageSource, /contentStatus\.state === "active"[\s\S]*sp\.source !== "managed"/);
  assert.match(pageSource, /source: "managed"[\s\S]*history\.managedSourceLabel/);
  assert.match(pageSource, /source: "e2ee"[\s\S]*history\.e2eeSourceLabel/);
  assert.match(pageSource, /getMyHistorySessions\(/);
});

test("pending E2EE setup falls through to managed server history instead of E2EE fatal UI", () => {
  assert.doesNotMatch(pageSource, /contentStatus\.state !== "off"[\s\S]*<E2eeHistoryClient/);
  assert.match(pageSource, /contentStatus\.state === "active"/);
});

test("E2EE API filter query removes the UI-only source parameter", () => {
  assert.match(clientSource, /params\.delete\("source"\)/);
});
