import { clearCredentialAccountLimit, consumeCredentialAttempt } from "./credential-rate-limit";
import { getPool } from "./db";
import { DUMMY_PASSWORD_HASH, verifyPassword } from "./password";

export type CredentialUser = {
  id: string;
  email: string;
  name: string | null;
};

/** 미존재 사용자와 OAuth 전용 계정도 같은 bcrypt 비용으로 처리한다. */
export async function verifyCredentialUser(
  emailInput: string,
  password: string,
  context: { clientIdentity: string },
): Promise<CredentialUser | null> {
  const email = emailInput.toLowerCase().trim();
  if (!email || !password) return null;
  await consumeCredentialAttempt({ channel: "login", email, clientIdentity: context.clientIdentity });
  const result = await getPool().query<CredentialUser & { password_hash: string | null }>(
    "SELECT id, email, name, password_hash FROM users WHERE email = $1",
    [email],
  );
  const row = result.rows[0];
  const valid = await verifyPassword(password, row?.password_hash ?? DUMMY_PASSWORD_HASH);
  if (!valid || !row?.password_hash) return null;
  await clearCredentialAccountLimit({ channel: "login", email });
  return { id: row.id, email: row.email, name: row.name };
}

export async function getCredentialUserById(userId: string): Promise<CredentialUser | null> {
  const result = await getPool().query<CredentialUser & { password_hash: string | null }>(
    "SELECT id, email, name, password_hash FROM users WHERE id = $1",
    [userId],
  );
  const row = result.rows[0];
  if (!row?.password_hash) return null;
  return { id: row.id, email: row.email, name: row.name };
}
