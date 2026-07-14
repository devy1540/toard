import assert from "node:assert/strict";
import test from "node:test";
import { fromBase64Url } from "./e2ee-contract";
import { VALID_E2EE_RECORD, createRecordingDb } from "./e2ee-test-fixtures";
import { saveE2eePromptRecords } from "./prompt-records";

test("e2ee records are inserted byte-for-byte without server plaintext or KEK", async () => {
  const db = createRecordingDb({ contentState: "active" });
  const result = await saveE2eePromptRecords("user-1", [VALID_E2EE_RECORD], db);
  assert.deepEqual(result, { inserted: 1, deduped: 0 });
  const insert = db.calls.find((call) => /INSERT INTO prompt_records/.test(call.sql));
  assert.ok(insert);
  assert.equal(insert.sql.includes("secret prompt"), false);
  assert.equal(insert.params.includes("secret prompt"), false);
  assert.deepEqual(
    insert.params.find((value) => Buffer.isBuffer(value) && value.length === 24),
    fromBase64Url(VALID_E2EE_RECORD.ciphertext, "ciphertext"),
  );
});

test("e2ee owner must be active and belong to the ingest-token user", async () => {
  const mismatch = createRecordingDb({ ownerUserId: "user-a", contentState: "active" });
  await assert.rejects(
    saveE2eePromptRecords("user-b", [VALID_E2EE_RECORD], mismatch),
    /CONTENT_OWNER_MISMATCH/,
  );
  const pending = createRecordingDb({ contentState: "pending" });
  await assert.rejects(
    saveE2eePromptRecords("user-1", [VALID_E2EE_RECORD], pending),
    /CONTENT_ACCOUNT_INACTIVE/,
  );
});
