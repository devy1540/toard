import { auth } from "@/auth";
import { getPool } from "./db";

export type SessionUser = { id: string; email: string; role: string };

/** 현재 로그인 사용자(세션 기반) + DB 의 role. 미로그인이면 null. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) return null;
  const r = await getPool().query<{ email: string; role: string }>(
    "SELECT email, role FROM users WHERE id = $1",
    [id],
  );
  const row = r.rows[0];
  return row ? { id, email: row.email, role: row.role } : null;
}
