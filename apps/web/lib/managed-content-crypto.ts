import crypto from "node:crypto";
import type { PromptRecordWire } from "./prompt-wire";

const AES_GCM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_KEY_VERSION = 32_767;

export interface ManagedEncryptedContent {
  encryptionScheme: "managed_v1";
  contentKeyVersion: number;
  aadVersion: 2;
  wrappedDek: Buffer;
  dekWrapIv: Buffer;
  dekWrapAuthTag: Buffer;
  iv: Buffer;
  ciphertext: Buffer;
  authTag: Buffer;
}

type ManagedContentAadInput = {
  installationId: string;
  userId: string;
  keyVersion: number;
  dedupKey: string;
  providerKey: string;
  turnRole: "user" | "assistant";
  ts: Date;
};

type ManagedEncryptedRow = Pick<
  PromptRecordWire,
  "dedupKey" | "providerKey" | "turnRole" | "ts"
> & ManagedEncryptedContent;

export function canonicalManagedContentAad(input: ManagedContentAadInput): Buffer {
  return Buffer.from(JSON.stringify({
    schema: "managed_v1",
    installationId: input.installationId,
    userId: input.userId,
    dedupKey: input.dedupKey,
    providerKey: input.providerKey,
    turnRole: input.turnRole,
    ts: input.ts.toISOString(),
    contentKeyVersion: input.keyVersion,
  }), "utf8");
}

export function encryptManagedContent(
  record: PromptRecordWire,
  uck: Buffer,
  installationId: string,
  userId: string,
  keyVersion: number,
): ManagedEncryptedContent {
  let dek: Buffer | undefined;
  try {
    assertKey(uck);
    const aadInput = managedContentAadInput(record, installationId, userId, keyVersion);
    assertAadInput(aadInput);
    if (typeof record.text !== "string" || Buffer.byteLength(record.text, "utf8") === 0) {
      throw new Error("INVALID_PLAINTEXT");
    }

    const aad = canonicalManagedContentAad(aadInput);
    dek = crypto.randomBytes(KEY_BYTES);
    const iv = crypto.randomBytes(IV_BYTES);
    const dekWrapIv = crypto.randomBytes(IV_BYTES);
    assertBufferLength(dek, KEY_BYTES);
    assertBufferLength(iv, IV_BYTES);
    assertBufferLength(dekWrapIv, IV_BYTES);

    const body = encryptAesGcm(dek, iv, aad, Buffer.from(record.text, "utf8"));
    const wrapped = encryptAesGcm(uck, dekWrapIv, aad, dek);
    return {
      encryptionScheme: "managed_v1",
      contentKeyVersion: keyVersion,
      aadVersion: 2,
      wrappedDek: wrapped.ciphertext,
      dekWrapIv,
      dekWrapAuthTag: wrapped.authTag,
      iv,
      ciphertext: body.ciphertext,
      authTag: body.authTag,
    };
  } catch {
    throw new Error("CONTENT_ENCRYPT_FAILED");
  } finally {
    dek?.fill(0);
  }
}

export function decryptManagedContent(
  row: ManagedEncryptedRow,
  uck: Buffer,
  installationId: string,
  userId: string,
): string {
  let dek: Buffer | undefined;
  try {
    if (row.encryptionScheme !== "managed_v1" || row.aadVersion !== 2) {
      throw new Error("INVALID_MANAGED_SCHEME");
    }
    assertKey(uck);
    const aadInput = managedContentAadInput(
      row,
      installationId,
      userId,
      row.contentKeyVersion,
    );
    assertAadInput(aadInput);
    assertBufferLength(row.wrappedDek, KEY_BYTES);
    assertBufferLength(row.dekWrapIv, IV_BYTES);
    assertBufferLength(row.dekWrapAuthTag, TAG_BYTES);
    assertBufferLength(row.iv, IV_BYTES);
    assertBufferLength(row.authTag, TAG_BYTES);
    if (!Buffer.isBuffer(row.ciphertext) || row.ciphertext.length === 0) {
      throw new Error("INVALID_CIPHERTEXT");
    }

    const aad = canonicalManagedContentAad(aadInput);
    dek = decryptAesGcm(uck, row.dekWrapIv, aad, row.wrappedDek, row.dekWrapAuthTag);
    assertBufferLength(dek, KEY_BYTES);
    return decryptAesGcm(dek, row.iv, aad, row.ciphertext, row.authTag).toString("utf8");
  } catch {
    throw new Error("CONTENT_DECRYPT_FAILED");
  } finally {
    dek?.fill(0);
  }
}

function encryptAesGcm(
  key: Buffer,
  iv: Buffer,
  aad: Buffer,
  plaintext: Buffer,
): { ciphertext: Buffer; authTag: Buffer } {
  const cipher = crypto.createCipheriv(AES_GCM, key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  assertBufferLength(authTag, TAG_BYTES);
  return { ciphertext, authTag };
}

function decryptAesGcm(
  key: Buffer,
  iv: Buffer,
  aad: Buffer,
  ciphertext: Buffer,
  authTag: Buffer,
): Buffer {
  const decipher = crypto.createDecipheriv(AES_GCM, key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function assertKey(key: Buffer): void {
  assertBufferLength(key, KEY_BYTES);
}

function managedContentAadInput(
  record: Pick<PromptRecordWire, "dedupKey" | "providerKey" | "turnRole" | "ts">,
  installationId: string,
  userId: string,
  keyVersion: number,
): ManagedContentAadInput {
  return {
    installationId,
    userId,
    keyVersion,
    dedupKey: record.dedupKey,
    providerKey: record.providerKey,
    turnRole: record.turnRole,
    ts: record.ts,
  };
}

function assertBufferLength(value: unknown, length: number): asserts value is Buffer {
  if (!Buffer.isBuffer(value) || value.length !== length) {
    throw new Error("INVALID_BUFFER_LENGTH");
  }
}

function assertAadInput(input: ManagedContentAadInput): void {
  if (
    typeof input.installationId !== "string"
    || input.installationId.length === 0
    || typeof input.userId !== "string"
    || input.userId.length === 0
    || typeof input.dedupKey !== "string"
    || input.dedupKey.length === 0
    || typeof input.providerKey !== "string"
    || input.providerKey.length === 0
    || (input.turnRole !== "user" && input.turnRole !== "assistant")
    || !(input.ts instanceof Date)
    || Number.isNaN(input.ts.getTime())
    || !Number.isSafeInteger(input.keyVersion)
    || input.keyVersion < 1
    || input.keyVersion > MAX_KEY_VERSION
  ) {
    throw new Error("INVALID_MANAGED_AAD");
  }
}
