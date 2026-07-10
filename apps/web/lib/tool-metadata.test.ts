import assert from "node:assert/strict";
import test from "node:test";
import type { ToolActivityEvent } from "@toard/core";
import { getOrgToolSummaryWithDb, insertToolActivityWithDb } from "./tool-metadata";

type Call = { sql: string; params?: unknown[] };

class RecordingDb {
  readonly calls: Call[] = [];
  constructor(private readonly rows: Record<string, unknown>[] = []) {}
  async query(sql: string, params?: unknown[]) {
    this.calls.push({ sql, params });
    return { rows: this.rows, rowCount: this.rows.length };
  }
}

const event: ToolActivityEvent = {
  dedupKey: "a".repeat(64),
  providerKey: "codex",
  sessionId: "session-1",
  host: "macbook.local",
  ts: new Date("2026-07-10T00:00:00Z"),
  activityKind: "skill",
  itemKey: "brainstorming",
  displayName: "brainstorming",
  pluginKey: "superpowers",
  outcome: "unknown",
  detection: "derived_load",
};

test("도구 활동 저장은 인증된 사용자와 토큰 소유권을 사용한다", async () => {
  const db = new RecordingDb();
  const result = await insertToolActivityWithDb(db, { userId: "user-auth", tokenId: "token-auth" }, [event]);

  assert.deepEqual(result, { inserted: 0, deduped: 1 });
  assert.deepEqual(db.calls[0]?.params?.slice(0, 2), ["user-auth", "token-auth"]);
  assert.doesNotMatch(db.calls[0]?.sql ?? "", /arguments|output|payload/i);
  assert.match(db.calls[0]?.sql ?? "", /ON CONFLICT \(dedup_key\) DO NOTHING/);
});

test("조직 도구 집계는 범주 숫자만 반환한다", async () => {
  const db = new RecordingDb([
    { mcp_calls: "4", distinct_skills: "2", distinct_plugins: "1", failures: "1", active_users: "2", active_devices: "2" },
  ]);

  const result = await getOrgToolSummaryWithDb(
    db,
    { from: new Date("2026-07-01T00:00:00Z"), to: new Date("2026-07-11T00:00:00Z") },
  );

  assert.deepEqual(result, {
    mcpCalls: 4,
    distinctSkills: 2,
    distinctPlugins: 1,
    failures: 1,
    activeUsers: 2,
    activeDevices: 2,
  });
  const json = JSON.stringify(result);
  for (const forbidden of ["itemKey", "displayName", "userId", "tokenId", "host", "sessionId"]) {
    assert.equal(json.includes(forbidden), false);
  }
  assert.doesNotMatch(db.calls[0]?.sql ?? "", /SELECT\s+(?:item_key|display_name|session_id)\b/i);
});
