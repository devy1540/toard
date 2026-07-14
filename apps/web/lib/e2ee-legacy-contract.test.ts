import assert from "node:assert/strict";
import test from "node:test";
import { VALID_E2EE_RECORD } from "./e2ee-test-fixtures";
import { parseLegacyMigrationCommit } from "./e2ee-legacy-contract";

const validItem = {
  id: "42",
  sourceDigest: Buffer.alloc(32, 7).toString("base64url"),
  record: VALID_E2EE_RECORD,
};

test("legacy migration commit accepts an exact valid item", () => {
  assert.deepEqual(parseLegacyMigrationCommit({ items: [validItem] }), [validItem]);
});

test("legacy migration commit rejects oversized batches and invalid identifiers", () => {
  assert.throws(() => parseLegacyMigrationCommit({ items: Array(26).fill(validItem) }), /1~25건/);
  assert.throws(() => parseLegacyMigrationCommit({ items: [{ ...validItem, id: "0" }] }), /id/);
  assert.throws(
    () => parseLegacyMigrationCommit({ items: [{ ...validItem, sourceDigest: "bad" }] }),
    /sourceDigest/,
  );
});

test("legacy migration commit rejects unknown fields", () => {
  assert.throws(
    () => parseLegacyMigrationCommit({ items: [{ ...validItem, text: "plaintext" }] }),
    /허용되지 않은 필드/,
  );
});
