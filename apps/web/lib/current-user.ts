import { auth } from "@/auth";
import { getPool } from "@/lib/db";

/**
 * 현재 사용자 id. Auth.js 세션 우선.
 * dev 에서 로그인 미구성(providers 빈 배열) 시 화면 확인용으로 첫 user 로 폴백.
 */
export async function getCurrentUserId(): Promise<string | null> {
  const session = await auth();
  const sessionUserId = (session?.user as { id?: string } | undefined)?.id;
  if (sessionUserId) return sessionUserId;

  if (process.env.NODE_ENV !== "production") {
    const r = await getPool().query<{ id: string }>("SELECT id FROM users ORDER BY created_at LIMIT 1");
    return r.rows[0]?.id ?? null;
  }
  return null;
}
