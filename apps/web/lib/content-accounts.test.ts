import assert from "node:assert/strict";
import test from "node:test";
import {
  activateContentAccount,
  approveRequest,
  consumeApprovedEnvelope,
  createApprovalRequest,
  parseActivationInput,
  prepareContentAccount,
  registerRecoveredBrowser,
} from "./content-accounts";
import {
  VALID_ACTIVATION_INPUT,
  VALID_BROWSER,
  VALID_DEVICE_ENVELOPE,
  VALID_DEVICE_WRAPPER,
  VALID_RECOVERY_WRAPPER,
  createRecordingDb,
} from "./e2ee-test-fixtures";

const NOW = new Date("2026-07-14T00:00:00.000Z");

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

test("approval expires after five minutes", async () => {
  const db = createRecordingDb({ contentState: "active" });
  const request = await createApprovalRequest("user-1", VALID_BROWSER, NOW, db);
  assert.equal(request.expiresAt, new Date(NOW.getTime() + 300_000).toISOString());

  const approvalDb = {
    async query(sql: string) {
      if (/FOR UPDATE/.test(sql)) {
        return {
          rows: [{
            id: request.id,
            requested_device_id: request.deviceId,
            confirmation_code_hash: Buffer.alloc(32),
            expires_at: new Date(NOW.getTime() + 300_000),
            approved_at: null,
            consumed_at: null,
            active_key_version: 1,
          }],
        };
      }
      return { rows: [] };
    },
  };
  await assert.rejects(
    approveRequest(
      "user-1",
      request.id,
      request.code,
      VALID_DEVICE_ENVELOPE,
      new Date(NOW.getTime() + 300_001),
      approvalDb,
    ),
    /DEVICE_APPROVAL_EXPIRED/,
  );
});

test("approved envelope is consumed once", async () => {
  let consumed = false;
  const db = {
    async query(sql: string) {
      if (/FOR UPDATE/.test(sql)) {
        return {
          rows: [{
            requested_device_id: VALID_DEVICE_WRAPPER.wrapperRef,
            expires_at: new Date(NOW.getTime() + 300_000),
            approved_at: NOW,
            consumed_at: consumed ? NOW : null,
            encapsulated_key: Buffer.from(VALID_DEVICE_ENVELOPE.encapsulatedKey, "base64url"),
            encrypted_envelope: Buffer.from(VALID_DEVICE_ENVELOPE.ciphertext, "base64url"),
          }],
        };
      }
      if (/UPDATE content_device_approval_requests/.test(sql)) consumed = true;
      return { rows: [] };
    },
  };
  assert.deepEqual(
    await consumeApprovedEnvelope("user-1", "018f47d0-4d47-7b04-950b-7d18a86e1b45", NOW, db),
    { deviceId: VALID_DEVICE_WRAPPER.wrapperRef, envelope: VALID_DEVICE_ENVELOPE },
  );
  await assert.rejects(
    consumeApprovedEnvelope("user-1", "018f47d0-4d47-7b04-950b-7d18a86e1b45", NOW, db),
    /DEVICE_APPROVAL_CONSUMED/,
  );
});

test("approval rejects a wrong code and another user", async () => {
  const createDb = createRecordingDb({ contentState: "active" });
  const request = await createApprovalRequest("user-1", VALID_BROWSER, NOW, createDb);
  const storedHash = createDb.calls.find((call) => /INSERT INTO content_device_approval_requests/.test(call.sql))
    ?.params[3];
  assert.ok(Buffer.isBuffer(storedHash));
  const ownerDb = {
    async query(sql: string) {
      if (/FOR UPDATE/.test(sql)) {
        return { rows: [{
          requested_device_id: request.deviceId,
          confirmation_code_hash: storedHash,
          expires_at: new Date(NOW.getTime() + 300_000),
          approved_at: null,
          consumed_at: null,
          active_key_version: 1,
        }] };
      }
      return { rows: [] };
    },
  };
  const wrong = request.code === "000000" ? "000001" : "000000";
  await assert.rejects(
    approveRequest("user-1", request.id, wrong, VALID_DEVICE_ENVELOPE, NOW, ownerDb),
    /DEVICE_APPROVAL_CODE_INVALID/,
  );
  await assert.rejects(
    approveRequest("user-2", request.id, request.code, VALID_DEVICE_ENVELOPE, NOW, {
      async query() { return { rows: [] }; },
    }),
    /DEVICE_APPROVAL_NOT_FOUND/,
  );
});

test("recovery registers a browser without sending the recovery secret", async () => {
  const db = createRecordingDb({ contentState: "active" });
  const result = await registerRecoveredBrowser(
    "user-1",
    { device: VALID_BROWSER, deviceWrapper: VALID_DEVICE_WRAPPER },
    db,
  );
  assert.equal(result.approved, true);
  assert.equal(JSON.stringify(db.calls).includes("abandon"), false);
  assert.equal(db.calls.some((call) => call.params.includes("secret prompt")), false);
  await assert.rejects(
    registerRecoveredBrowser("user-1", {
      device: VALID_BROWSER,
      deviceWrapper: VALID_DEVICE_WRAPPER,
      mnemonic: "abandon",
    }, db),
    /INVALID_RECOVERY_COMPLETION/,
  );
});
