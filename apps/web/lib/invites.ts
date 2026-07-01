import { createHash, randomBytes } from "node:crypto";
import { getPool } from "./db";

export type Invite = { id: string; email: string; role: string; expiresAt: Date };
export type PendingInvite = { email: string; role: string; createdAt: Date; expiresAt: Date };

function genToken(): string {
  return `inv_${randomBytes(24).toString("hex")}`;
}
function hashToken(t: string): string {
  return createHash("sha256").update(t).digest("hex");
}

/**
 * 초대 생성 → 평문 토큰 반환(1회). 같은 이메일의 미수락 초대는 폐기 후 재발급.
 * 이미 가입된 이메일이면 null(초대 불필요).
 */
export async function createInvite(
  email: string,
  role: string,
  createdBy: string,
): Promise<string | null> {
  const token = genToken();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const ex = await client.query("SELECT 1 FROM users WHERE email = $1", [email]);
    if ((ex.rowCount ?? 0) > 0) {
      await client.query("ROLLBACK");
      return null;
    }
    await client.query("DELETE FROM invites WHERE email = $1 AND accepted_at IS NULL", [email]);
    await client.query(
      "INSERT INTO invites (email, token_hash, role, created_by) VALUES ($1, $2, $3, $4)",
      [email, hashToken(token), role === "admin" ? "admin" : "member", createdBy],
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  return token;
}

/** 유효한 초대(미수락·미만료) 조회. */
export async function getValidInvite(token: string): Promise<Invite | null> {
  const r = await getPool().query<{ id: string; email: string; role: string; expires_at: Date }>(
    `SELECT id, email, role, expires_at FROM invites
     WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > now()`,
    [hashToken(token)],
  );
  const row = r.rows[0];
  return row ? { id: row.id, email: row.email, role: row.role, expiresAt: row.expires_at } : null;
}

/** 초대 수락: 유저 생성 + 초대 소진(원자적). 성공 시 {email}, 실패(무효/중복) 시 null. */
export async function acceptInvite(
  token: string,
  name: string,
  passwordHash: string,
): Promise<{ email: string } | null> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const inv = await client.query<{ id: string; email: string; role: string }>(
      `SELECT id, email, role FROM invites
       WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > now() FOR UPDATE`,
      [hashToken(token)],
    );
    const row = inv.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return null;
    }
    const ex = await client.query("SELECT 1 FROM users WHERE email = $1", [row.email]);
    if ((ex.rowCount ?? 0) > 0) {
      await client.query("ROLLBACK");
      return null;
    }
    await client.query(
      "INSERT INTO users (email, name, password_hash, role) VALUES ($1, $2, $3, $4)",
      [row.email, name || null, passwordHash, row.role],
    );
    await client.query("UPDATE invites SET accepted_at = now() WHERE id = $1", [row.id]);
    await client.query("COMMIT");
    return { email: row.email };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/** 대기 중(미수락·미만료) 초대 목록. */
export async function listPendingInvites(): Promise<PendingInvite[]> {
  const r = await getPool().query<{
    email: string;
    role: string;
    created_at: Date;
    expires_at: Date;
  }>(
    `SELECT email, role, created_at, expires_at FROM invites
     WHERE accepted_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 50`,
  );
  return r.rows.map((x) => ({
    email: x.email,
    role: x.role,
    createdAt: x.created_at,
    expiresAt: x.expires_at,
  }));
}
