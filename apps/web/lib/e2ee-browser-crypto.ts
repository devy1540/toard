import { canonicalContentAad, type E2eePromptRecordWire } from "./e2ee-contract";

const AES_GCM = "AES-GCM";

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
