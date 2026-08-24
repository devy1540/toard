import { createHmac } from "node:crypto";
import type { Pool } from "pg";
import { getPool } from "./db";

export type CredentialChannel = "login" | "signup";

type CredentialRateLimitInput = {
  channel: CredentialChannel;
  email: string;
  clientIdentity: string;
};

type CredentialRateLimitDeps = {
  pool: Pick<Pool, "query">;
  secret: string;
};

type ConsumeRow = { is_allowed: boolean; retry_after_seconds: number };

export class CredentialRateLimitError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super("CREDENTIAL_RATE_LIMITED");
    this.name = "CredentialRateLimitError";
  }
}

function normalizeIdentity(value: string | null | undefined): string | null {
  const normalized = value?.split(",", 1)[0]?.trim();
  return normalized ? normalized.slice(0, 255) : null;
}

/** trusted reverse proxy가 덮어쓴 연결 header를 우선 사용한다. account/global limit은 항상 함께 적용된다. */
export function credentialClientIdentity(headers: Pick<Headers, "get">): string {
  return normalizeIdentity(headers.get("cf-connecting-ip"))
    ?? normalizeIdentity(headers.get("x-real-ip"))
    ?? normalizeIdentity(headers.get("x-forwarded-for"))
    ?? "unknown";
}

function rateLimitKey(secret: string, material: string): Buffer {
  if (!secret) throw new Error("AUTH_SECRET_REQUIRED_FOR_CREDENTIAL_RATE_LIMIT");
  return createHmac("sha256", secret).update(material).digest();
}

function accountKey(input: CredentialRateLimitInput, secret: string): Buffer {
  const email = input.email.toLowerCase().trim();
  return rateLimitKey(secret, `credentials\0account\0${input.channel}\0${email}`);
}

function runtimeDeps(): CredentialRateLimitDeps {
  return { pool: getPool(), secret: process.env.AUTH_SECRET ?? "" };
}

/** blocked preflight 뒤 channel별 account → client IP → global budget을 한 DB 함수에서 원자 소비한다. */
export async function consumeCredentialAttempt(
  input: CredentialRateLimitInput,
  deps: CredentialRateLimitDeps = runtimeDeps(),
): Promise<void> {
  const result = await deps.pool.query<ConsumeRow>(
    "SELECT is_allowed, retry_after_seconds FROM consume_credential_rate_limits($1, $2, $3)",
    [
      rateLimitKey(deps.secret, "credentials\0global"),
      rateLimitKey(deps.secret, `credentials\0ip\0${input.clientIdentity}`),
      accountKey(input, deps.secret),
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error("CREDENTIAL_RATE_LIMIT_RESULT_MISSING");
  if (!row.is_allowed) throw new CredentialRateLimitError(row.retry_after_seconds);
}

/** 성공한 login/signup의 channel별 account backoff만 해제한다. IP/global budget은 window 동안 유지한다. */
export async function clearCredentialAccountLimit(
  input: Pick<CredentialRateLimitInput, "channel" | "email">,
  deps: CredentialRateLimitDeps = runtimeDeps(),
): Promise<void> {
  await deps.pool.query("SELECT clear_credential_account_rate_limit($1)", [accountKey({
    ...input,
    clientIdentity: "unused",
  }, deps.secret)]);
}
