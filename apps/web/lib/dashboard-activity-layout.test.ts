import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("내 사용량은 최근 세션을 제거하고 AI 활동과 시간대 리듬을 한 줄로 배치한다", () => {
  const overview = source("../components/dashboard/overview-view.tsx");
  const toolCard = source("../components/dashboard/tool-activity-card.tsx");
  assert.doesNotMatch(overview, /getMyHistorySessions|recentSessionsTitle|server_v1/);
  assert.match(overview, /xl:grid-cols-\[minmax\(0,1\.2fr\)_minmax\(0,1fr\)\]/);
  assert.ok(overview.indexOf("<ToolActivityCard") < overview.indexOf('t("rhythmTitle")'));
  assert.match(toolCard, /className\?: string/);
});

test("레거시 히스토리 reader는 server_v1만 조회한다", () => {
  const promptHistory = source("./prompt-history.ts");
  assert.match(promptHistory, /encryption_scheme = 'server_v1'/);
});
