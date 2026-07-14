import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { decryptE2eeRecord } from "./e2ee-browser-crypto";

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

test("browser metadata tamper fails closed", async () => {
  await assert.rejects(
    decryptE2eeRecord(Buffer.from(vector.uck, "base64url"), { ...record, providerKey: "claude" }),
    /CONTENT_UNAVAILABLE/,
  );
});
