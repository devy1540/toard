import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

const TOKEN_VERSION = "1";
const TOKEN_AAD = Buffer.from("toard:history-search-query:v1", "utf8");
const QUERY_LIMIT = 200;
const TOKEN_LIMIT = 2_048;
const USER_ID_LIMIT = 255;

function encryptionKey(secret: string): Buffer {
  if (!secret) throw new Error("HISTORY_SEARCH_TOKEN_SECRET_MISSING");
  return createHash("sha256")
    .update("toard:history-search-query:key:v1\0", "utf8")
    .update(secret, "utf8")
    .digest();
}

function tokenAad(userId: string): Buffer {
  if (!userId || userId.length > USER_ID_LIMIT) {
    throw new Error("HISTORY_SEARCH_TOKEN_USER_INVALID");
  }
  return Buffer.concat([TOKEN_AAD, Buffer.from("\0", "utf8"), Buffer.from(userId, "utf8")]);
}

export function sanitizeHistorySearchQuery(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, QUERY_LIMIT);
}

export function encodeHistorySearchQueryToken(query: string, secret: string, userId: string): string {
  const plaintext = sanitizeHistorySearchQuery(query);
  if (!plaintext) throw new Error("HISTORY_SEARCH_QUERY_EMPTY");
  const aad = tokenAad(userId);
  const key = encryptionKey(secret);
  const iv = randomBytes(12);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      TOKEN_VERSION,
      iv.toString("base64url"),
      ciphertext.toString("base64url"),
      tag.toString("base64url"),
    ].join(".");
  } finally {
    key.fill(0);
  }
}

export function decodeHistorySearchQueryToken(
  token: string | undefined,
  secret: string,
  userId: string,
): string | null {
  if (!token) return null;
  if (!secret) throw new Error("HISTORY_SEARCH_TOKEN_SECRET_MISSING");
  if (token.length > TOKEN_LIMIT) return null;
  const [version, encodedIv, encodedCiphertext, encodedTag, extra] = token.split(".");
  if (
    version !== TOKEN_VERSION
    || !encodedIv
    || !encodedCiphertext
    || !encodedTag
    || extra !== undefined
  ) {
    return null;
  }

  const aad = tokenAad(userId);
  const key = encryptionKey(secret);
  try {
    const iv = Buffer.from(encodedIv, "base64url");
    const ciphertext = Buffer.from(encodedCiphertext, "base64url");
    const tag = Buffer.from(encodedTag, "base64url");
    if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) return null;
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    const sanitized = sanitizeHistorySearchQuery(plaintext);
    return sanitized === plaintext && sanitized.length > 0 ? sanitized : null;
  } catch {
    return null;
  } finally {
    key.fill(0);
  }
}
