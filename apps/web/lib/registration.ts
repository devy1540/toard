import type { Adapter, AdapterUser } from "next-auth/adapters";
import type { Pool } from "pg";
import { isEmailDomainAllowed, isValidEmail } from "./auth-policy";

export type RegistrationMode = "invite_only" | "verified_oauth";

/** Unknown or omitted values fail closed. Password self-registration is never enabled. */
export function registrationMode(
  env: Readonly<Record<string, string | undefined>> = process.env,
): RegistrationMode {
  return env.AUTH_REGISTRATION_MODE === "verified_oauth" ? "verified_oauth" : "invite_only";
}

type RegistrationProfile = Partial<AdapterUser> & {
  email: string;
  /** Set only by our verified provider profile mappers, never by browser input. */
  toardEmailVerified?: boolean;
};

export async function canSignInWithOAuth(
  pool: Pick<Pool, "query">,
  email: string,
  mode = registrationMode(),
  account?: { provider: string; providerAccountId: string },
): Promise<boolean> {
  const normalized = email.trim().toLowerCase();
  if (!isValidEmail(normalized)) return false;
  if (account) {
    const linked = await pool.query(
      `SELECT 1 FROM accounts a JOIN users u ON u.id = a."userId"
       WHERE a.provider = $1 AND a."providerAccountId" = $2`,
      [account.provider, account.providerAccountId],
    );
    if ((linked.rowCount ?? 0) > 0) return true;
  }
  const existing = await pool.query("SELECT 1 FROM users WHERE email = $1", [normalized]);
  // Auth.js still checks provider/account ownership and refuses implicit member linking.
  if ((existing.rowCount ?? 0) > 0) return true;
  const invited = await pool.query(
    "SELECT 1 FROM invites WHERE email = $1 AND accepted_at IS NULL AND expires_at > now()",
    [normalized],
  );
  return (invited.rowCount ?? 0) > 0 || (mode === "verified_oauth" && isEmailDomainAllowed(normalized));
}

/** Recheck admission in the transaction that creates the user and consumes the invite.
 * An earlier signIn callback alone cannot guard this write boundary. */
export async function createOAuthMember(
  pool: Pick<Pool, "connect">,
  profile: RegistrationProfile,
  mode = registrationMode(),
): Promise<AdapterUser> {
  const email = profile.email.trim().toLowerCase();
  if (profile.toardEmailVerified !== true || !isValidEmail(email)) {
    throw new Error("VERIFIED_EMAIL_REQUIRED");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 1541))", [email]);
    const existing = await client.query("SELECT 1 FROM users WHERE email = $1", [email]);
    if ((existing.rowCount ?? 0) > 0) throw new Error("REGISTRATION_EMAIL_EXISTS");
    const invitations = await client.query<{ id: string; role: string; team_id: string | null; created_by: string | null }>(
      `SELECT id, role, team_id, created_by FROM invites
       WHERE email = $1 AND accepted_at IS NULL AND expires_at > clock_timestamp()
       ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [email],
    );
    const invite = invitations.rows[0];
    if (!invite && (mode !== "verified_oauth" || !isEmailDomainAllowed(email))) {
      throw new Error("INVITATION_REQUIRED");
    }
    const inserted = await client.query<AdapterUser>(
      `INSERT INTO users (email, name, image, "emailVerified", role, team_id, team_onboarding_completed_at)
       VALUES ($1, $2, $3, now(), $4, $5, now())
       RETURNING id, email, name, image, "emailVerified"`,
      [email, profile.name ?? null, profile.image ?? null, invite?.role === "admin" ? "admin" : "member", invite?.team_id ?? null],
    );
    const user = inserted.rows[0]!;
    if (invite?.team_id) {
      await client.query(
        `INSERT INTO user_team_assignments (user_id, team_id, effective_from, assignment_kind, created_by)
         VALUES ($1, $2, now(), 'admin', $3)`,
        [user.id, invite.team_id, invite.created_by],
      );
    }
    if (invite) await client.query("UPDATE invites SET accepted_at = now() WHERE id = $1", [invite.id]);
    await client.query("COMMIT");
    return user;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function registrationAdapter(adapter: Adapter, pool: Pool): Adapter {
  return { ...adapter, createUser: (user) => createOAuthMember(pool, user) };
}
