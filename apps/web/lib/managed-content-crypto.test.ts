import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import type { PromptRecordWire } from "./prompt-wire";
import {
  canonicalManagedContentAad,
  decryptManagedContent,
  encryptManagedContent,
  type ManagedEncryptedContent,
} from "./managed-content-crypto";

const UCK = Buffer.alloc(32, 7);
const INSTALLATION_ID = "019f7250-dc4d-78fd-98e8-a5465d0f5b69";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const RECORD: PromptRecordWire = {
  dedupKey: "managed-record-1",
  sessionId: "session-1",
  providerKey: "codex",
  turnRole: "user",
  ts: new Date("2026-07-17T03:04:05.678Z"),
  text: "managed secret",
};

type ManagedRow = PromptRecordWire & ManagedEncryptedContent;

function encryptedRow(): ManagedRow {
  return { ...RECORD, ...encryptManagedContent(RECORD, UCK, INSTALLATION_ID, USER_ID, 1) };
}

function flipped(input: Buffer): Buffer {
  const output = Buffer.from(input);
  output[0] = (output[0] ?? 0) ^ 1;
  return output;
}

function assertDecryptFailed(
  row: ManagedRow,
  uck = UCK,
  installationId = INSTALLATION_ID,
  userId = USER_ID,
): void {
  assert.throws(
    () => decryptManagedContent(row, uck, installationId, userId),
    (error: unknown) =>
      error instanceof Error
      && error.message === "CONTENT_DECRYPT_FAILED"
      && !/authenticate|cipher|key|secret/i.test(error.message),
  );
}

test("managed AAD는 승인된 필드를 결정적 순서로 직렬화한다", () => {
  const aad = canonicalManagedContentAad({
    installationId: INSTALLATION_ID,
    userId: USER_ID,
    keyVersion: 1,
    ...RECORD,
  });

  assert.equal(
    aad.toString("utf8"),
    `{"schema":"managed_v1","installationId":"${INSTALLATION_ID}","userId":"${USER_ID}","dedupKey":"managed-record-1","providerKey":"codex","turnRole":"user","ts":"2026-07-17T03:04:05.678Z","contentKeyVersion":1}`,
  );
});

test("managed record는 metadata와 사용자에 결합되고 nonce가 분리된다", () => {
  const encrypted = encryptManagedContent(RECORD, UCK, INSTALLATION_ID, USER_ID, 1);
  assert.equal(encrypted.encryptionScheme, "managed_v1");
  assert.equal(encrypted.aadVersion, 2);
  assert.equal(encrypted.contentKeyVersion, 1);
  assert.equal(encrypted.iv.length, 12);
  assert.equal(encrypted.dekWrapIv.length, 12);
  assert.equal(encrypted.authTag.length, 16);
  assert.equal(encrypted.dekWrapAuthTag.length, 16);
  assert.equal(encrypted.wrappedDek.length, 32);
  assert.notDeepEqual(encrypted.iv, encrypted.dekWrapIv);
  assert.equal(
    decryptManagedContent({ ...RECORD, ...encrypted }, UCK, INSTALLATION_ID, USER_ID),
    RECORD.text,
  );

  assertDecryptFailed({ ...RECORD, providerKey: "claude", ...encrypted });
  assertDecryptFailed({ ...RECORD, ...encrypted }, UCK, INSTALLATION_ID, "other-user");
});

test("예상 밖 record 필드는 trusted AAD context와 반환 key version을 덮지 못한다", () => {
  const attackerInstallationId = "attacker-installation";
  const attackerUserId = "attacker-user";
  const poisonedRecord = {
    ...RECORD,
    installationId: attackerInstallationId,
    userId: attackerUserId,
    keyVersion: 9,
    contentKeyVersion: 9,
    schema: "managed_v1",
    aadVersion: 99,
    sessionId: "attacker-session",
  } as PromptRecordWire & Record<string, unknown>;

  const encrypted = encryptManagedContent(poisonedRecord, UCK, INSTALLATION_ID, USER_ID, 3);
  const row = { ...poisonedRecord, ...encrypted } as ManagedRow & Record<string, unknown>;

  assert.equal(encrypted.contentKeyVersion, 3);
  assert.equal(decryptManagedContent(row, UCK, INSTALLATION_ID, USER_ID), RECORD.text);
  assertDecryptFailed(row, UCK, attackerInstallationId, attackerUserId);
  assertDecryptFailed(
    { ...row, contentKeyVersion: 9 },
    UCK,
    attackerInstallationId,
    attackerUserId,
  );
});

test("managed record는 모든 AAD metadata와 key version tamper를 거부한다", () => {
  const row = encryptedRow();

  assertDecryptFailed({ ...row, dedupKey: "other-dedup" });
  assertDecryptFailed({ ...row, providerKey: "claude" });
  assertDecryptFailed({ ...row, turnRole: "assistant" });
  assertDecryptFailed({ ...row, ts: new Date("2026-07-17T03:04:06.678Z") });
  assertDecryptFailed({ ...row, contentKeyVersion: 2 });
  assertDecryptFailed(row, UCK, "other-installation", USER_ID);
  assertDecryptFailed(row, UCK, INSTALLATION_ID, "other-user");
});

test("managed record는 scheme, AAD version, nonce, tag, ciphertext tamper를 fail-closed 한다", () => {
  const row = encryptedRow();

  assertDecryptFailed({ ...row, encryptionScheme: "managed_v1-tampered" as "managed_v1" });
  assertDecryptFailed({ ...row, aadVersion: 1 as 2 });
  assertDecryptFailed({ ...row, wrappedDek: flipped(row.wrappedDek) });
  assertDecryptFailed({ ...row, dekWrapIv: flipped(row.dekWrapIv) });
  assertDecryptFailed({ ...row, dekWrapAuthTag: flipped(row.dekWrapAuthTag) });
  assertDecryptFailed({ ...row, iv: flipped(row.iv) });
  assertDecryptFailed({ ...row, ciphertext: flipped(row.ciphertext) });
  assertDecryptFailed({ ...row, authTag: flipped(row.authTag) });
});

test("managed decrypt는 잘못된 UCK와 필드 길이를 비민감 오류로 거부한다", () => {
  const row = encryptedRow();

  assertDecryptFailed(row, Buffer.alloc(31));
  assertDecryptFailed({ ...row, wrappedDek: Buffer.alloc(31) });
  assertDecryptFailed({ ...row, dekWrapIv: Buffer.alloc(11) });
  assertDecryptFailed({ ...row, dekWrapAuthTag: Buffer.alloc(15) });
  assertDecryptFailed({ ...row, iv: Buffer.alloc(11) });
  assertDecryptFailed({ ...row, ciphertext: Buffer.alloc(0) });
  assertDecryptFailed({ ...row, authTag: Buffer.alloc(15) });
});

test("managed encrypt는 32바이트 UCK만 허용한다", () => {
  assert.throws(
    () => encryptManagedContent(RECORD, Buffer.alloc(31), INSTALLATION_ID, USER_ID, 1),
    /CONTENT_ENCRYPT_FAILED/,
  );
});

test("managed encrypt는 성공과 실패 모두에서 DEK를 zeroize한다", (t) => {
  const successDek = Buffer.alloc(32, 0xa5);
  const successValues = [successDek, Buffer.alloc(12, 1), Buffer.alloc(12, 2)];
  let call = 0;
  t.mock.method(crypto, "randomBytes", () => successValues[call++]!);

  encryptManagedContent(RECORD, UCK, INSTALLATION_ID, USER_ID, 1);
  assert.deepEqual(successDek, Buffer.alloc(32));

  t.mock.restoreAll();
  const failedDek = Buffer.alloc(32, 0x5a);
  const failedValues = [failedDek, Buffer.alloc(12, 1), Buffer.alloc(8, 2)];
  call = 0;
  t.mock.method(crypto, "randomBytes", () => failedValues[call++]!);

  assert.throws(
    () => encryptManagedContent(RECORD, UCK, INSTALLATION_ID, USER_ID, 1),
    /CONTENT_ENCRYPT_FAILED/,
  );
  assert.deepEqual(failedDek, Buffer.alloc(32));
});
