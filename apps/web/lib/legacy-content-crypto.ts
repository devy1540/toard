import crypto from "node:crypto";

// 프롬프트/응답 본문의 at-rest 봉투 암호화 (설계: RLS + at-rest 트랙).
// - 레코드마다 랜덤 DEK 로 본문을 AES-256-GCM 암호화하고, DEK 는 KEK 로 감싼다.
// - KEK 는 앱 밖(KMS/Vault, 최소한 env)에만 존재하며 DB 에는 절대 저장하지 않는다.
//   → DB 덤프·백업·DBA 는 암호문만 본다. KEK 를 쥔 앱/운영자만 복호화 가능(= E2EE 아님, 의도된 경계).
// - KMS 도입 시 wrapDek/unwrapDek 두 함수만 kms.encrypt/decrypt 로 교체하면 된다.

export interface EncryptedContent {
  keyVersion: number;
  wrappedDek: Buffer;
  iv: Buffer;
  ciphertext: Buffer;
  authTag: Buffer;
}

const KEY_VERSION = 1;
const DEK_BYTES = 32; // AES-256
const IV_BYTES = 12; // GCM 표준 nonce
const TAG_BYTES = 16; // GCM 인증태그

/** legacy server_v1 행을 복호화할 수 있는 유효한 KEK가 설정됐는지. */
export function legacyContentKeyConfigured(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  try {
    loadKekFromEnvironment(env);
    return true;
  } catch {
    return false;
  }
}

/** env 에서 32바이트 KEK 로드. 미설정/길이 불일치는 조용히 넘기지 않고 즉시 실패. */
export function loadKek(): Buffer {
  return loadKekFromEnvironment(process.env);
}

function loadKekFromEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): Buffer {
  const b64 = env.TOARD_CONTENT_KEK_B64;
  if (!b64) {
    throw new Error("TOARD_CONTENT_KEK_B64 미설정 — 본문 암호화 KEK(base64 32바이트)가 필요합니다");
  }
  const kek = Buffer.from(b64, "base64");
  if (kek.length !== DEK_BYTES) {
    throw new Error(`KEK 는 32바이트여야 합니다 — 현재 ${kek.length}B (openssl rand -base64 32 로 생성)`);
  }
  return kek;
}

export function encryptContent(plaintext: string, kek: Buffer): EncryptedContent {
  const dek = crypto.randomBytes(DEK_BYTES);
  let plaintextBytes: Buffer | undefined;
  try {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv("aes-256-gcm", dek, iv);
    plaintextBytes = Buffer.from(plaintext, "utf8");
    const ciphertext = Buffer.concat([cipher.update(plaintextBytes), cipher.final()]);
    return {
      keyVersion: KEY_VERSION,
      wrappedDek: wrapDek(dek, kek),
      iv,
      ciphertext,
      authTag: cipher.getAuthTag(),
    };
  } finally {
    plaintextBytes?.fill(0);
    dek.fill(0);
  }
}

export function decryptContent(row: EncryptedContent, kek: Buffer): string {
  let dek: Buffer | undefined;
  let plaintext: Buffer | undefined;
  try {
    if (
      row.keyVersion !== KEY_VERSION
      || !Buffer.isBuffer(kek)
      || kek.length !== DEK_BYTES
      || !Buffer.isBuffer(row.wrappedDek)
      || row.wrappedDek.length !== IV_BYTES + TAG_BYTES + DEK_BYTES
      || !Buffer.isBuffer(row.iv)
      || row.iv.length !== IV_BYTES
      || !Buffer.isBuffer(row.ciphertext)
      || row.ciphertext.length === 0
      || !Buffer.isBuffer(row.authTag)
      || row.authTag.length !== TAG_BYTES
    ) {
      throw new Error("INVALID_LEGACY_CONTENT");
    }
    dek = unwrapDek(row.wrappedDek, kek);
    plaintext = decryptAesGcm(dek, row.iv, row.ciphertext, row.authTag);
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(plaintext);
  } finally {
    plaintext?.fill(0);
    dek?.fill(0);
  }
}

// 로컬 KEK wrap (KMS 미사용 시). 포맷: [iv 12B | tag 16B | enc DEK]
function wrapDek(dek: Buffer, kek: Buffer): Buffer {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", kek, iv);
  const enc = Buffer.concat([cipher.update(dek), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]);
}

function unwrapDek(wrapped: Buffer, kek: Buffer): Buffer {
  const iv = wrapped.subarray(0, IV_BYTES);
  const tag = wrapped.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const enc = wrapped.subarray(IV_BYTES + TAG_BYTES);
  return decryptAesGcm(kek, iv, enc, tag);
}

function decryptAesGcm(
  key: Buffer,
  iv: Buffer,
  ciphertext: Buffer,
  authTag: Buffer,
): Buffer {
  let updateChunk: Buffer | undefined;
  let finalChunk: Buffer | undefined;
  let plaintext: Buffer | undefined;
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    updateChunk = decipher.update(ciphertext);
    finalChunk = decipher.final();
    plaintext = Buffer.concat([updateChunk, finalChunk]);
    return plaintext;
  } catch (error) {
    plaintext?.fill(0);
    throw error;
  } finally {
    updateChunk?.fill(0);
    finalChunk?.fill(0);
  }
}
