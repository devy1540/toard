"use server";

import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session-user";
import { isTeamOnboardingPending } from "@/lib/team-onboarding";

export type TeamOnboardingState = { error?: string };

export async function chooseTeamAction(
  _prev: TeamOnboardingState,
  formData: FormData,
): Promise<TeamOnboardingState> {
  const t = await getTranslations("auth");
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (!isTeamOnboardingPending(user)) redirect("/settings?tab=install");

  const teamId = String(formData.get("teamId") ?? "");
  if (!teamId) return { error: t("errors.teamRequired") };

  let redirectTo: string | null = null;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<{
      role: string;
      team_id: string | null;
      team_onboarding_completed_at: Date | null;
    }>(
      "SELECT role, team_id, team_onboarding_completed_at FROM users WHERE id = $1 FOR UPDATE",
      [user.id],
    );
    const row = current.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      redirectTo = "/login";
    } else if (row.role !== "member" || row.team_id || row.team_onboarding_completed_at) {
      await client.query("COMMIT");
      redirectTo = "/settings?tab=install";
    } else {
      const team = await client.query("SELECT 1 FROM teams WHERE id = $1", [teamId]);
      if ((team.rowCount ?? 0) === 0) {
        await client.query("ROLLBACK");
        return { error: t("errors.teamNotFound") };
      }
      await client.query(
        "UPDATE users SET team_id = $2, team_onboarding_completed_at = now() WHERE id = $1",
        [user.id, teamId],
      );
      await client.query("COMMIT");
      redirectTo = "/settings?tab=install";
    }
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  if (redirectTo) redirect(redirectTo);
  return {};
}
