import assert from "node:assert/strict";
import test from "node:test";
import {
  activateContentAccount,
  parseActivationInput,
  prepareContentAccount,
} from "./content-accounts";
import {
  VALID_ACTIVATION_INPUT,
  VALID_DEVICE_WRAPPER,
  VALID_RECOVERY_WRAPPER,
  createRecordingDb,
} from "./e2ee-test-fixtures";

test("activation requires recovery confirmation and both wrapper types", async () => {
  await assert.rejects(
    activateContentAccount(
      "user-1",
      { ...VALID_ACTIVATION_INPUT, recoveryConfirmed: false },
      createRecordingDb(),
    ),
    /RECOVERY_CONFIRMATION_REQUIRED/,
  );
  await assert.rejects(
    activateContentAccount(
      "user-1",
      { ...VALID_ACTIVATION_INPUT, wrappers: [VALID_RECOVERY_WRAPPER] },
      createRecordingDb(),
    ),
    /DEVICE_AND_RECOVERY_WRAPPERS_REQUIRED/,
  );
});

test("activation input rejects mnemonic, UCK, recovery secret, and unknown fields", () => {
  for (const field of ["mnemonic", "uck", "recoverySecret", "plaintext"]) {
    assert.throws(
      () => parseActivationInput({ ...VALID_ACTIVATION_INPUT, [field]: "secret prompt" }),
      new RegExp(`허용되지 않은 필드: ${field}`),
    );
  }
});

test("prepare is idempotent and returns only public account material", async () => {
  const db = createRecordingDb();
  const prepared = await prepareContentAccount("user-1", db);
  assert.deepEqual(Object.keys(prepared).sort(), [
    "activeKeyVersion",
    "contentOwnerId",
    "recoverySalt",
    "state",
  ]);
  assert.match(db.calls[0]?.sql ?? "", /INSERT INTO content_accounts/);
  assert.match(db.calls[0]?.sql ?? "", /ON CONFLICT \(user_id\) DO UPDATE/);
});

test("activation stores the device and wrappers before marking the account active", async () => {
  const db = createRecordingDb();
  const result = await activateContentAccount("user-1", VALID_ACTIVATION_INPUT, db);
  assert.equal(result.state, "active");
  const statements = db.calls.map((call) => call.sql);
  const device = statements.findIndex((sql) => /INSERT INTO content_devices/.test(sql));
  const wrappers = statements.filter((sql) => /INSERT INTO content_key_wrappers/.test(sql));
  const activate = statements.findIndex((sql) => /UPDATE content_accounts/.test(sql));
  assert.ok(device >= 0);
  assert.equal(wrappers.length, 2);
  assert.ok(activate > device);
  assert.equal(db.calls.some((call) => call.params.includes("secret prompt")), false);
  assert.equal(db.calls.some((call) => call.params.includes(VALID_DEVICE_WRAPPER.wrappedContentKey)), false);
});
