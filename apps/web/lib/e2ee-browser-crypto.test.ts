import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  decryptE2eeRecord,
  exportBrowserPublicKey,
  generateBrowserDeviceKey,
  openDeviceEnvelope,
  recoverUckFromMnemonic,
  sealUckForDevice,
} from "./e2ee-browser-crypto";

const vector = JSON.parse(
  readFileSync(resolve(process.cwd(), "../../fixtures/e2ee-v1-golden.json"), "utf8"),
);
const record = {
  schema: "e2ee_v1" as const,
  algorithm: "AES-256-GCM" as const,
  aadVersion: 1 as const,
  contentOwnerId: vector.metadata.contentOwnerId,
  contentKeyVersion: 1,
  dedupKey: vector.metadata.dedupKey,
  sessionId: null,
  providerKey: vector.metadata.providerKey,
  turnRole: vector.metadata.turnRole,
  ts: vector.metadata.ts,
  wrappedDek: vector.wrappedDek,
  dekWrapIv: vector.dekWrapIv,
  dekWrapAuthTag: vector.dekWrapAuthTag,
  iv: vector.contentIv,
  ciphertext: vector.ciphertext,
  authTag: vector.authTag,
};

test("browser decrypts the Rust e2ee_v1 golden vector", async () => {
  const plaintext = await decryptE2eeRecord(Buffer.from(vector.uck, "base64url"), record);
  assert.equal(new TextDecoder().decode(plaintext), "secret prompt");
});

test("24-word Recovery Kit unwraps UCK only in the browser", async () => {
  const mnemonic = `${"abandon ".repeat(23)}art`.trim();
  const salt = new Uint8Array(32).fill(7);
  const nonce = new Uint8Array(12).fill(3);
  const uck = new Uint8Array(32).fill(9);
  const material = await crypto.subtle.importKey("raw", new Uint8Array(32), "HKDF", false, ["deriveKey"]);
  const recoveryKey = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode("toard/recovery-wrap/v1") },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const owner = "018f47d0-4d47-7b04-950b-7d18a86e1b43";
  const sealed = new Uint8Array(await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonce,
      additionalData: new TextEncoder().encode(`toard/recovery/v1\n${owner}\n1`),
      tagLength: 128,
    },
    recoveryKey,
    uck,
  ));
  const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
  const recovered = await recoverUckFromMnemonic(mnemonic, {
    contentOwnerId: owner,
    contentKeyVersion: 1,
    publicSaltOrInput: b64(salt),
    nonce: b64(nonce),
    wrappedContentKey: b64(sealed.slice(0, -16)),
    authTag: b64(sealed.slice(-16)),
  });
  assert.deepEqual(recovered, uck);
  await assert.rejects(
    recoverUckFromMnemonic("abandon abandon", {
      contentOwnerId: owner,
      contentKeyVersion: 1,
      publicSaltOrInput: b64(salt),
      nonce: b64(nonce),
      wrappedContentKey: b64(sealed.slice(0, -16)),
      authTag: b64(sealed.slice(-16)),
    }),
    /INVALID_RECOVERY_KIT/,
  );
});

test("browser metadata tamper fails closed", async () => {
  await assert.rejects(
    decryptE2eeRecord(Buffer.from(vector.uck, "base64url"), { ...record, providerKey: "claude" }),
    /CONTENT_UNAVAILABLE/,
  );
});

test("browser device key is non-extractable and HPKE unwraps UCK", async () => {
  const keyPair = await generateBrowserDeviceKey();
  assert.equal(keyPair.privateKey.extractable, false);
  const publicKey = await exportBrowserPublicKey(keyPair.publicKey);
  const uck = crypto.getRandomValues(new Uint8Array(32));
  const envelope = await sealUckForDevice(publicKey, uck);

  assert.deepEqual(await openDeviceEnvelope(keyPair, envelope), uck);
  await assert.rejects(
    openDeviceEnvelope(keyPair, { ...envelope, ciphertext: `${envelope.ciphertext.slice(0, -1)}A` }),
    /CONTENT_UNAVAILABLE/,
  );
});
