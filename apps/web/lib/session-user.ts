import { auth } from "@/auth";
import { getCurrentUserId } from "@/lib/current-user";
import { getPool } from "./db";

export type SessionUser = {
  id: string;
  email: string;
  role: string;
  teamRole: "member" | "leader";
  teamId: string | null;
  teamName: string | null;
  teamOnboardingCompletedAt: Date | null;
  sessionId?: string | null;
};

async function getUserById(id: string, sessionId: string | null): Promise<SessionUser | null> {
  const r = await getPool().query<{
    email: string;
    role: string;
    team_role: "member" | "leader";
    team_id: string | null;
    team_name: string | null;
    team_onboarding_completed_at: Date | null;
  }>(
    `SELECT u.email, u.role, u.team_role, u.team_id, u.team_onboarding_completed_at, t.name AS team_name
     FROM users u
     LEFT JOIN teams t ON t.id = u.team_id
     WHERE u.id = $1`,
    [id],
  );
  const row = r.rows[0];
  return row
    ? {
        id,
        email: row.email,
        role: row.role,
        teamRole: row.team_id ? row.team_role : "member",
        teamId: row.team_id,
        teamName: row.team_name,
        teamOnboardingCompletedAt: row.team_onboarding_completed_at,
        sessionId,
      }
    : null;
}

/** 현재 로그인 사용자(세션 기반) + DB 의 role. 미로그인이면 null. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) return null;
  return getUserById(id, session.mfaSessionId ?? null);
}

/** 대시보드 표시용 사용자. open 모드에서는 기존 getCurrentUserId 폴백을 사용한다. */
export async function getDashboardViewer(): Promise<SessionUser | null> {
  const sessionUser = await getSessionUser();
  if (sessionUser) return sessionUser;
  if ((process.env.AUTH_MODE ?? "oauth") !== "open") return null;
  const id = await getCurrentUserId();
  return id ? getUserById(id, null) : null;
}
