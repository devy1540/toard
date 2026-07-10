import assert from "node:assert/strict";
import test from "node:test";
import { insightCacheArgs } from "./user-insights";

test("인사이트 캐시 인자에 사용자·기간·provider·타임존이 모두 포함된다", () => {
  const args = insightCacheArgs(
    "user-a",
    {
      preset: "7",
      current: { from: new Date("2026-07-03T00:00:00Z"), to: new Date("2026-07-10T00:00:00Z") },
      previous: { from: new Date("2026-06-26T00:00:00Z"), to: new Date("2026-07-03T00:00:00Z") },
      timezone: "Asia/Seoul",
    },
    "codex",
  );

  assert.deepEqual(args, [
    "user-a",
    "2026-07-03T00:00:00.000Z",
    "2026-07-10T00:00:00.000Z",
    "2026-06-26T00:00:00.000Z",
    "2026-07-03T00:00:00.000Z",
    "codex",
    "Asia/Seoul",
  ]);
});
