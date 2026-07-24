import assert from "node:assert/strict";
import test from "node:test";
import type { ToolActivityEvent } from "@toard/core";
import {
  getOrgToolSummaryWithDb,
  getUtilizationToolDaysWithDb,
  insertToolActivityWithDb,
  replaceDeviceInventoryWithDb,
  type ToolMetadataDb,
} from "./tool-metadata";

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

test("활용 지수 도구 집계는 지원 provider의 일별 결과와 30분 이내 복구를 반환한다", async () => {
  const db = new RecordingDb([
    {
      user_id: "user-1",
      day: "2026-07-10",
      successes: "7",
      failures: "3",
      unknown: "2",
      repeated_failures: "1",
      recovery_attempts: "2",
      successful_recoveries: "1",
      session_tool_known_calls: "10",
      tool_active_sessions: "2",
      distinct_tools: "3",
    },
  ]);

  const result = await getUtilizationToolDaysWithDb(
    db,
    { from: new Date("2026-07-01T00:00:00Z"), to: new Date("2026-07-11T00:00:00Z") },
    "Asia/Seoul",
    "user-1",
  );

  assert.match(db.calls[0]?.sql ?? "", /LAG\(outcome\)/);
  assert.match(db.calls[0]?.sql ?? "", /INTERVAL '30 minutes'/);
  assert.match(
    db.calls[0]?.sql ?? "",
    /PARTITION BY user_id, session_id, activity_kind, item_key/,
  );
  assert.match(db.calls[0]?.sql ?? "", /session_id IS NOT NULL/);
  assert.match(db.calls[0]?.sql ?? "", /provider_key = ANY\(\$4::text\[\]\)/);
  assert.deepEqual(db.calls[0]?.params, [
    new Date("2026-07-01T00:00:00Z"),
    new Date("2026-07-11T00:00:00Z"),
    "Asia/Seoul",
    ["claude_code", "codex", "cursor"],
    "user-1",
  ]);
  assert.deepEqual(result[0], {
    userId: "user-1",
    day: "2026-07-10",
    successes: 7,
    failures: 3,
    unknown: 2,
    repeatedFailures: 1,
    recoveryAttempts: 2,
    successfulRecoveries: 1,
    sessionToolKnownCalls: 10,
    toolActiveSessions: 2,
    distinctTools: 3,
  });
});

test("기기 인벤토리는 안정 fingerprint로 upsert하고 같은 기기의 변경 항목도 교체한다", async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const db: ToolMetadataDb = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes("RETURNING id")) return { rows: [{ id: 41 }] };
      return { rows: [] };
    },
  };

  const result = await replaceDeviceInventoryWithDb(
    db,
    { userId: "user-1", tokenId: "token-1" },
    {
      host: "renamed-host",
      fingerprint: "a".repeat(64),
      observedAt: new Date("2026-07-24T00:00:00.000Z"),
      items: [
        {
          kind: "skill",
          itemKey: "review",
          displayName: "Review",
          sourceProvider: "codex",
          pluginKey: null,
          version: null,
          enabled: true,
        },
      ],
    },
  );

  assert.deepEqual(result, { unchanged: false, items: 1 });
  assert.equal(calls.length, 3);
  assert.match(calls[0]!.sql, /ON CONFLICT \(ingest_token_id, fingerprint\)/);
  assert.match(calls[0]!.sql, /host = EXCLUDED\.host/);
  assert.match(calls[1]!.sql, /DELETE FROM device_tool_inventory_items/);
  assert.match(calls[2]!.sql, /INSERT INTO device_tool_inventory_items/);
});
