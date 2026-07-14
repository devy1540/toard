import { canonicalContentAad, type E2eePromptRecordWire } from "./e2ee-contract";
import { Aes256Gcm, CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from "@hpke/core";
import { mnemonicToEntropy, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import type { DeviceEnvelopeWire } from "./e2ee-contract";

const AES_GCM = "AES-GCM";
const HPKE_INFO = new TextEncoder().encode("toard/content-device/v1");
const HPKE_AAD = new TextEncoder().encode("toard/content-key/v1");
const RECOVERY_INFO = new TextEncoder().encode("toard/recovery-wrap/v1");

function hpkeSuite(): CipherSuite {
  return new CipherSuite({
    kem: new DhkemP256HkdfSha256(),
    kdf: new HkdfSha256(),
    aead: new Aes256Gcm(),
  });
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const decoded = atob(padded);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return bytes;
}

function join(left: Uint8Array, right: Uint8Array): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(left.length + right.length);
  output.set(left, 0);
  output.set(right, left.length);
  return output;
}

async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  const owned = new Uint8Array(raw.byteLength);
  owned.set(raw);
  return crypto.subtle.importKey("raw", owned, { name: AES_GCM }, false, ["decrypt"]);
}

export async function decryptE2eeRecord(
  uck: Uint8Array,
  record: E2eePromptRecordWire,
): Promise<Uint8Array<ArrayBuffer>> {
  try {
    if (uck.byteLength !== 32) throw new Error("invalid UCK");
    const aad = new Uint8Array(canonicalContentAad(record));
    const uckKey = await importAesKey(uck);
    const dek = await crypto.subtle.decrypt(
      { name: AES_GCM, iv: fromBase64Url(record.dekWrapIv), additionalData: aad, tagLength: 128 },
      uckKey,
      join(fromBase64Url(record.wrappedDek), fromBase64Url(record.dekWrapAuthTag)),
    );
    const dekKey = await importAesKey(new Uint8Array(dek));
    const plaintext = await crypto.subtle.decrypt(
      { name: AES_GCM, iv: fromBase64Url(record.iv), additionalData: aad, tagLength: 128 },
      dekKey,
      join(fromBase64Url(record.ciphertext), fromBase64Url(record.authTag)),
    );
    return new Uint8Array(plaintext);
  } catch {
    // 인증 태그 실패와 키/형식 오류를 구분하지 않아 복호화 oracle을 만들지 않는다.
    throw new Error("CONTENT_UNAVAILABLE");
  }
}

export async function generateBrowserDeviceKey(): Promise<CryptoKeyPair> {
  const keyPair = (await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  )) as CryptoKeyPair;
  if (keyPair.privateKey.extractable) throw new Error("PRIVATE_KEY_MUST_NOT_BE_EXTRACTABLE");
  return keyPair;
}

export async function exportBrowserPublicKey(publicKey: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey("raw", publicKey);
  let binary = "";
  for (const byte of new Uint8Array(raw)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function sealUckForDevice(
  publicKeyBase64: string,
  uck: Uint8Array,
): Promise<DeviceEnvelopeWire> {
  if (uck.byteLength !== 32) throw new Error("INVALID_UCK");
  const suite = hpkeSuite();
  const publicKeyBytes = fromBase64Url(publicKeyBase64);
  const recipientPublicKey = await suite.kem.importKey("raw", publicKeyBytes.buffer, true);
  const sealed = await suite.seal(
    { recipientPublicKey, info: HPKE_INFO },
    new Uint8Array(uck),
    HPKE_AAD,
  );
  return {
    algorithm: "hpke-p256-hkdf-sha256-aes256gcm-v1",
    encapsulatedKey: toBase64Url(sealed.enc),
    ciphertext: toBase64Url(sealed.ct),
  };
}

export async function openDeviceEnvelope(
  keyPair: CryptoKeyPair,
  envelope: DeviceEnvelopeWire,
): Promise<Uint8Array<ArrayBuffer>> {
  try {
    const suite = hpkeSuite();
    const plaintext = await suite.open(
      { recipientKey: keyPair, enc: fromBase64Url(envelope.encapsulatedKey), info: HPKE_INFO },
      fromBase64Url(envelope.ciphertext),
      HPKE_AAD,
    );
    if (plaintext.byteLength !== 32) throw new Error("invalid UCK");
    return new Uint8Array(plaintext);
  } catch {
    throw new Error("CONTENT_UNAVAILABLE");
  }
}

export async function recoverUckFromMnemonic(
  mnemonic: string,
  input: {
    contentOwnerId: string;
    contentKeyVersion: number;
    publicSaltOrInput: string;
    nonce: string;
    authTag: string;
    wrappedContentKey: string;
  },
): Promise<Uint8Array<ArrayBuffer>> {
  const normalized = mnemonic.trim().toLowerCase().replace(/\s+/g, " ");
  if (normalized.split(" ").length !== 24 || !validateMnemonic(normalized, wordlist)) {
    throw new Error("INVALID_RECOVERY_KIT");
  }
  const entropy = new Uint8Array(mnemonicToEntropy(normalized, wordlist));
  try {
    if (entropy.byteLength !== 32) throw new Error("INVALID_RECOVERY_KIT");
    const keyMaterial = await crypto.subtle.importKey("raw", entropy, "HKDF", false, ["deriveKey"]);
    const recoveryKey = await crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: fromBase64Url(input.publicSaltOrInput), info: RECOVERY_INFO },
      keyMaterial,
      { name: AES_GCM, length: 256 },
      false,
      ["decrypt"],
    );
    const aad = new TextEncoder().encode(
      `toard/recovery/v1\n${input.contentOwnerId}\n${input.contentKeyVersion}`,
    );
    const plaintext = await crypto.subtle.decrypt(
      { name: AES_GCM, iv: fromBase64Url(input.nonce), additionalData: aad, tagLength: 128 },
      recoveryKey,
      join(fromBase64Url(input.wrappedContentKey), fromBase64Url(input.authTag)),
    );
    if (plaintext.byteLength !== 32) throw new Error("CONTENT_UNAVAILABLE");
    return new Uint8Array(plaintext);
  } catch (error) {
    if (error instanceof Error && error.message === "INVALID_RECOVERY_KIT") throw error;
    throw new Error("CONTENT_UNAVAILABLE");
  } finally {
    entropy.fill(0);
  }
}

function toBase64Url(value: ArrayBufferLike): string {
  const bytes = new Uint8Array(value as ArrayBuffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
