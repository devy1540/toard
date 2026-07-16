import { createHash, timingSafeEqual } from "node:crypto";
import type { KeyContext } from "./types";

const MAGIC = Buffer.from("TUK1");
const CONTEXT_DIGEST_LENGTH = 32;
const USER_KEY_LENGTH = 32;
const PAYLOAD_LENGTH = MAGIC.length + CONTEXT_DIGEST_LENGTH + USER_KEY_LENGTH;

export function canonicalKeyContext(context: KeyContext): Buffer {
  return Buffer.from(JSON.stringify({
    installationId: context.installationId,
    userId: context.userId,
    keyVersion: context.keyVersion,
    purpose: context.purpose,
  }), "utf8");
}

export function encodeUserKeyPayload(uck: Buffer, context: KeyContext): Buffer {
  if (uck.length !== USER_KEY_LENGTH) throw new Error("USER_KEY_LENGTH_INVALID");
  const contextDigest = createHash("sha256").update(canonicalKeyContext(context)).digest();
  return Buffer.concat([MAGIC, contextDigest, uck], PAYLOAD_LENGTH);
}

export function decodeUserKeyPayload(payload: Buffer, context: KeyContext): Buffer {
  if (
    payload.length !== PAYLOAD_LENGTH
    || !timingSafeEqual(payload.subarray(0, MAGIC.length), MAGIC)
  ) {
    throw new Error("USER_KEY_PAYLOAD_INVALID");
  }
  const expected = createHash("sha256").update(canonicalKeyContext(context)).digest();
  if (!timingSafeEqual(payload.subarray(MAGIC.length, MAGIC.length + expected.length), expected)) {
    throw new Error("USER_KEY_CONTEXT_MISMATCH");
  }
  return Buffer.from(payload.subarray(MAGIC.length + expected.length));
}
