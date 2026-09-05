"use server";

import { getTranslations } from "next-intl/server";

export type TeamOnboardingState = { error?: string };

/** Old forms cannot grant their user membership in an arbitrary team. */
export async function chooseTeamAction(_prev: TeamOnboardingState, _formData: FormData): Promise<TeamOnboardingState> {
  const t = await getTranslations("auth");
  return { error: t("errors.teamAssignmentByAdmin") };
}
