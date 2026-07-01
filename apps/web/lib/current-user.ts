import { auth, oauthConfigured } from "@/auth";
import { getPool } from "@/lib/db";

/** 인증 모드 (ADR-007). oauth(기본) | open. credentials·magic-link 는 확장 예정. */
const authMode = process.env.AUTH_MODE ?? "oauth";

/**
 * 현재 사용자 id.
 *  - `open`: 인증 없이 지정(AUTH_OPEN_USER_EMAIL) 또는 첫 user (**내부망 전제** — 대시보드 공개).
 *  - 그 외: Auth.js JWT 세션 우선. OAuth 미구성 + dev 면 첫 user 폴백(화면 확인용).
 */
export async function getCurrentUserId(): Promise<string | null> {
  if (authMode === "open") {
    const email = process.env.AUTH_OPEN_USER_EMAIL;
    const r = email
      ? await getPool().query<{ id: string }>("SELECT id FROM users WHERE email = $1", [email])
      : await getPool().query<{ id: string }>("SELECT id FROM users ORDER BY created_at LIMIT 1");
    return r.rows[0]?.id ?? null;
  }

  const session = await auth();
  const sessionUserId = (session?.user as { id?: string } | undefined)?.id;
  if (sessionUserId) return sessionUserId;

  if (!oauthConfigured && process.env.NODE_ENV !== "production") {
    const r = await getPool().query<{ id: string }>(
      "SELECT id FROM users ORDER BY created_at LIMIT 1",
    );
    return r.rows[0]?.id ?? null;
  }
  return null;
}
