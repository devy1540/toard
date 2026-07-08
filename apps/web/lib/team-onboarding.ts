import type { SessionUser } from "@/lib/session-user";
import { getPool } from "./db";

export type TeamOption = { id: string; name: string };

export function isTeamOnboardingPending(user: SessionUser | null): boolean {
  return Boolean(
    user &&
      user.role === "member" &&
      !user.teamId &&
      !user.teamOnboardingCompletedAt,
  );
}

export async function listTeamOptions(): Promise<TeamOption[]> {
  const r = await getPool().query<TeamOption>("SELECT id, name FROM teams ORDER BY name");
  return r.rows;
}

export async function hasTeams(): Promise<boolean> {
  const r = await getPool().query("SELECT 1 FROM teams LIMIT 1");
  return (r.rowCount ?? 0) > 0;
}
