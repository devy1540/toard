import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

const SIGNED_TOKEN_VERSION = 1;

export type MfaTokenPurpose = "credential-challenge" | "credential-ticket" | "history-access";

export type MfaTokenPayload = {
  version: typeof SIGNED_TOKEN_VERSION;
  purpose: MfaTokenPurpose;
  userId: string;
  expiresAt: number;
  nonce: string;
  mfaVersion?: number;
};

export function createSignedMfaToken(
  input: Omit<MfaTokenPayload, "version" | "nonce"> & { nonce?: string },
  masterSecret = requireMasterSecret(),
): string {
  const payload: MfaTokenPayload = {
    version: SIGNED_TOKEN_VERSION,
    purpose: input.purpose,
    userId: input.userId,
    expiresAt: input.expiresAt,
    nonce: input.nonce ?? randomBytes(16).toString("base64url"),
    ...(input.mfaVersion === undefined ? {} : { mfaVersion: input.mfaVersion }),
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${signToken(encoded, masterSecret)}`;
}

export function verifySignedMfaToken(
  token: string,
  purpose: MfaTokenPurpose,
  nowMs = Date.now(),
  masterSecret = requireMasterSecret(),
): MfaTokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [encoded, signature] = parts;
  if (!encoded || !signature) return null;
  const expected = Buffer.from(signToken(encoded, masterSecret));
  const provided = Buffer.from(signature);
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) return null;
  try {
    const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Partial<MfaTokenPayload>;
    if (
      value.version !== SIGNED_TOKEN_VERSION || value.purpose !== purpose ||
      typeof value.userId !== "string" || !value.userId ||
      typeof value.expiresAt !== "number" || value.expiresAt <= nowMs ||
      typeof value.nonce !== "string" || !value.nonce ||
      (value.mfaVersion !== undefined && (!Number.isInteger(value.mfaVersion) || value.mfaVersion < 1))
    ) return null;
    return value as MfaTokenPayload;
  } catch {
    return null;
  }
}

function signToken(encoded: string, masterSecret: string): string {
  return createHmac("sha256", deriveKey(masterSecret)).update(encoded).digest("base64url");
}

function deriveKey(masterSecret: string): Buffer {
  if (!masterSecret) throw new Error("MFA_AUTH_SECRET_REQUIRED");
  return Buffer.from(hkdfSync("sha256", Buffer.from(masterSecret), Buffer.from("toard-mfa-v1"), Buffer.from("signed-token"), 32));
}

function requireMasterSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("MFA_AUTH_SECRET_REQUIRED");
  return secret;
}
