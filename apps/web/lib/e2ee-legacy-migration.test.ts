import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { encryptContent } from "./content-crypto";
import { VALID_E2EE_RECORD } from "./e2ee-test-fixtures";
import {
  commitLegacyMigrationBatch,
  getLegacyMigrationPage,
  getLegacyMigrationStatus,
  LegacyMigrationError,
} from "./e2ee-legacy-migration";

const userId = "11111111-1111-4111-8111-111111111111";
const browserId = "22222222-2222-4222-8222-222222222222";
const kek = Buffer.alloc(32, 9);
const legacy = encryptContent("legacy secret", kek);
const legacyRow = {
  id: "42",
  dedup_key: VALID_E2EE_RECORD.dedupKey,
  session_id: VALID_E2EE_RECORD.sessionId,
  provider_key: VALID_E2EE_RECORD.providerKey,
  turn_role: VALID_E2EE_RECORD.turnRole,
  ts: new Date(VALID_E2EE_RECORD.ts),
  encryption_scheme: "server_v1",
  content_owner_id: null,
  content_key_version: null,
  key_version: legacy.keyVersion,
  wrapped_dek: legacy.wrappedDek,
  iv: legacy.iv,
  ciphertext: legacy.ciphertext,
  auth_tag: legacy.authTag,
};

function fakeDb() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  return {
    calls,
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      if (sql.includes("COUNT(record.id)")) {
        return { rows: [{ content_owner_id: VALID_E2EE_RECORD.contentOwnerId, active_key_version: 1, legacy_records: "1", e2ee_records: "2" }] };
      }
      if (sql.includes("FROM content_devices")) {
        return { rows: [{ content_owner_id: VALID_E2EE_RECORD.contentOwnerId, active_key_version: 1 }] };
      }
      if (sql.includes("FROM prompt_records") && sql.includes("FOR UPDATE")) return { rows: [legacyRow] };
      if (sql.includes("FROM prompt_records") && sql.includes("ORDER BY id")) return { rows: [legacyRow] };
      if (sql.startsWith("UPDATE prompt_records")) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
}

test("legacy migration status returns active owner and scheme counts", async () => {
  const status = await getLegacyMigrationStatus(userId, true, fakeDb());
  assert.deepEqual(status, {
    state: "pending",
    contentOwnerId: VALID_E2EE_RECORD.contentOwnerId,
    contentKeyVersion: 1,
    legacyRecords: 1,
    e2eeRecords: 2,
    totalRecords: 3,
  });
});

test("legacy page requires an approved browser and returns a plaintext digest", async () => {
  const db = fakeDb();
  const page = await getLegacyMigrationPage(userId, browserId, kek, 25, db);
  assert.equal(page.records[0]?.text, "legacy secret");
  assert.equal(
    page.records[0]?.sourceDigest,
    createHash("sha256").update("legacy secret", "utf8").digest("base64url"),
  );
  assert.ok(db.calls.some((call) => call.sql.includes("approved_at IS NOT NULL")));
});

test("legacy commit updates the same row after digest and metadata validation", async () => {
  const db = fakeDb();
  const sourceDigest = createHash("sha256").update("legacy secret", "utf8").digest("base64url");
  const result = await commitLegacyMigrationBatch(
    userId,
    browserId,
    [{ id: "42", sourceDigest, record: VALID_E2EE_RECORD }],
    kek,
    db,
  );
  assert.deepEqual(result, { migrated: 1, alreadyMigrated: 0 });
  assert.ok(db.calls.some((call) => call.sql.startsWith("UPDATE prompt_records")));
});

test("legacy commit rejects a changed source without updating", async () => {
  const db = fakeDb();
  await assert.rejects(
    commitLegacyMigrationBatch(
      userId,
      browserId,
      [{ id: "42", sourceDigest: Buffer.alloc(32).toString("base64url"), record: VALID_E2EE_RECORD }],
      kek,
      db,
    ),
    (error: unknown) => error instanceof LegacyMigrationError && error.code === "LEGACY_SOURCE_CHANGED",
  );
  assert.equal(db.calls.some((call) => call.sql.startsWith("UPDATE prompt_records")), false);
});
