import assert from "node:assert/strict";
import test from "node:test";
import { VALID_E2EE_RECORD } from "./e2ee-test-fixtures";
import {
  LEGACY_MIGRATION_MAX_BATCH_SIZE,
  LEGACY_MIGRATION_MAX_PAYLOAD_BYTES,
  boundLegacyMigrationPage,
  parseLegacyMigrationCommit,
  parseLegacyMigrationLimit,
} from "./e2ee-legacy-contract";

const validItem = {
  id: "42",
  sourceDigest: Buffer.alloc(32, 7).toString("base64url"),
  record: VALID_E2EE_RECORD,
};

test("legacy migration commit accepts an exact valid item", () => {
  assert.deepEqual(parseLegacyMigrationCommit({ items: [validItem] }), [validItem]);
});

test("legacy migration commit rejects oversized batches and invalid identifiers", () => {
  assert.equal(parseLegacyMigrationCommit({ items: Array(LEGACY_MIGRATION_MAX_BATCH_SIZE).fill(validItem) }).length, 100);
  assert.throws(
    () => parseLegacyMigrationCommit({ items: Array(LEGACY_MIGRATION_MAX_BATCH_SIZE + 1).fill(validItem) }),
    /1~100건/,
  );
  assert.throws(() => parseLegacyMigrationCommit({ items: [{ ...validItem, id: "0" }] }), /id/);
  assert.throws(
    () => parseLegacyMigrationCommit({ items: [{ ...validItem, sourceDigest: "bad" }] }),
    /sourceDigest/,
  );
});

test("legacy migration limit accepts 1~100 and rejects values outside the range", () => {
  assert.equal(parseLegacyMigrationLimit("1"), 1);
  assert.equal(parseLegacyMigrationLimit("100"), 100);
  assert.throws(() => parseLegacyMigrationLimit("0"), /limit/);
  assert.throws(() => parseLegacyMigrationLimit("101"), /limit/);
});

test("legacy migration page stays within the 4MB JSON response budget", () => {
  const records = Array.from({ length: 100 }, (_, index) => ({
    id: String(index + 1),
    dedupKey: `legacy-${index + 1}`,
    sessionId: null,
    providerKey: "codex",
    turnRole: "user" as const,
    ts: "2026-07-14T00:00:00.000Z",
    text: "가".repeat(30_000),
    sourceDigest: Buffer.alloc(32, index).toString("base64url"),
  }));

  const bounded = boundLegacyMigrationPage(records);
  assert.ok(bounded.length > 25);
  assert.ok(bounded.length < records.length);
  assert.ok(Buffer.byteLength(JSON.stringify({ records: bounded }), "utf8") <= LEGACY_MIGRATION_MAX_PAYLOAD_BYTES);
});

test("legacy migration page rejects a single record larger than its response budget", () => {
  const oversized = {
    id: "1",
    dedupKey: "legacy-1",
    sessionId: null,
    providerKey: "codex",
    turnRole: "user" as const,
    ts: "2026-07-14T00:00:00.000Z",
    text: "x".repeat(1024),
    sourceDigest: Buffer.alloc(32).toString("base64url"),
  };
  assert.throws(() => boundLegacyMigrationPage([oversized], 512), /response budget/);
});

test("legacy migration commit rejects unknown fields", () => {
  assert.throws(
    () => parseLegacyMigrationCommit({ items: [{ ...validItem, text: "plaintext" }] }),
    /허용되지 않은 필드/,
  );
});
