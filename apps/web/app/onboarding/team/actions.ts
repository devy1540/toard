"use server";

import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session-user";
import { isTeamOnboardingPending } from "@/lib/team-onboarding";
import { changeUserTeam, TeamMembershipError } from "@/lib/team-membership";

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

  try {
    await changeUserTeam(getPool(), {
      userId: user.id,
      teamId,
      actorId: user.id,
      completeOnboarding: true,
    });
  } catch (error) {
    if (error instanceof TeamMembershipError) {
      if (error.code === "TEAM_NOT_FOUND") return { error: t("errors.teamNotFound") };
      if (error.code === "USER_NOT_FOUND") redirect("/login");
      return { error: t("errors.teamSaveFailed") };
    }
    throw error;
  }

  redirect("/settings?tab=install");
}
