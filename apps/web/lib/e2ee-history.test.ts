import assert from "node:assert/strict";
import test from "node:test";
import {
  getE2eeContentStatus,
  getE2eeHistorySession,
  getE2eeHistorySessions,
  type E2eeHistoryDb,
} from "./e2ee-history";

function fakeDb(rowsByCall: Record<string, unknown>[][]): E2eeHistoryDb & { sql: string[] } {
  const sql: string[] = [];
  return {
    sql,
    async query(statement) {
      sql.push(statement);
      return { rows: rowsByCall.shift() ?? [] };
    },
  };
}

const encryptedRow = {
  dedup_key: "dedup-1",
  session_id: "session-1",
  provider_key: "codex",
  turn_role: "user",
  ts: new Date("2026-07-14T00:00:00.000Z"),
  content_owner_id: "11111111-1111-4111-8111-111111111111",
  content_key_version: 1,
  wrapped_dek: Buffer.alloc(32, 1),
  dek_wrap_iv: Buffer.alloc(12, 2),
  dek_wrap_auth_tag: Buffer.alloc(16, 3),
  iv: Buffer.alloc(12, 4),
  ciphertext: Buffer.from("ciphertext"),
  auth_tag: Buffer.alloc(16, 5),
  aad_version: 1,
};

test("E2EE history list returns ciphertext only and excludes server_v1", async () => {
  const db = fakeDb([[
    {
      gkey: "session-1",
      turn_count: "2",
      first_ts: new Date("2026-07-14T00:00:00.000Z"),
      latest_ts: new Date("2026-07-14T00:01:00.000Z"),
      total_groups: "1",
      ...encryptedRow,
    },
  ]]);
  const page = await getE2eeHistorySessions("user-1", { limit: 20, offset: 0 }, db);

  assert.equal(page.sessions[0]?.previewRecord?.ciphertext, Buffer.from("ciphertext").toString("base64url"));
  assert.equal(page.totalSessions, 1);
  assert.match(db.sql[0]!, /encryption_scheme = 'e2ee_v1'/);
  assert.doesNotMatch(db.sql[0]!, /decrypt/i);
  assert.equal(JSON.stringify(page).includes("secret prompt"), false);
});

test("E2EE history detail is bounded to 500 turns", async () => {
  const db = fakeDb([[...Array.from({ length: 501 }, () => encryptedRow)]]);
  const detail = await getE2eeHistorySession("user-1", "session-1", db);

  assert.equal(detail?.turns.length, 500);
  assert.equal(detail?.truncated, true);
  assert.match(db.sql[0]!, /encryption_scheme = 'e2ee_v1'/);
});

test("content status does not expose wrappers or keys", async () => {
  const db = fakeDb([[
    {
      state: "active",
      active_key_version: 1,
      recovery_confirmed_at: new Date("2026-07-14T00:00:00.000Z"),
      approved_device_count: "2",
    },
  ]]);
  const status = await getE2eeContentStatus("user-1", db);

  assert.deepEqual(status, {
    state: "active",
    keyVersion: 1,
    approvedDeviceCount: 2,
    recoveryConfirmedAt: "2026-07-14T00:00:00.000Z",
  });
  assert.equal(JSON.stringify(status).includes("wrapper"), false);
});
