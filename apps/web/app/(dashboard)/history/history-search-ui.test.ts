import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

test("managed history renders submit-based content search and agent filtering in the shared toolbar", () => {
  const page = source("./page.tsx");
  const controls = source("./history-search-controls.tsx");
  const actions = source("./history-search-actions.ts");
  assert.match(page, /filterTrailing=\{<HistorySearchControls initialQuery=\{searchQuery\} \/>\}/);
  assert.match(page, /searchMyHistorySessions/);
  assert.match(page, /decodeHistorySearchQueryToken/);
  assert.match(page, /searchMode=\{isSearch\}/);
  assert.match(controls, /role="search"/);
  assert.match(controls, /action=\{submitHistorySearch\}/);
  assert.match(controls, /next\.delete\("cursor"\)/);
  assert.match(actions, /getCurrentUserId/);
  assert.match(actions, /encodeHistorySearchQueryToken/);
  assert.match(actions, /AUTH_SECRET[\s\S]*userId/);
  assert.match(page, /decodeHistorySearchQueryToken\([\s\S]*userId/);
  assert.doesNotMatch(controls, /next\.set\("q"/);
  assert.match(controls, /min-w-32/);
  assert.match(controls, /SelectItem value="main"/);
  assert.match(controls, /SelectItem value="subagent"/);
});

test("history search keeps Korean and English UI contracts symmetric", () => {
  const ko = JSON.parse(source("../../../messages/ko/dashboard.json")).history as Record<string, unknown>;
  const en = JSON.parse(source("../../../messages/en/dashboard.json")).history as Record<string, unknown>;
  const keys = [
    "searchLabel",
    "searchPlaceholder",
    "searchSubmit",
    "searchClear",
    "searchResults",
    "searchEmptyTitle",
    "searchEmptyDescription",
    "searchNext",
    "agentFilterLabel",
    "agentFilterAll",
    "agentFilterMain",
    "agentFilterSubagent",
  ];
  for (const key of keys) {
    assert.equal(typeof ko[key], "string", `missing Korean ${key}`);
    assert.equal(typeof en[key], "string", `missing English ${key}`);
  }
});
