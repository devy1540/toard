import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { AuthPageShell } from "@/components/auth/auth-page-shell";
import { getSessionUser } from "@/lib/session-user";
import { isTeamOnboardingPending, listTeamOptions } from "@/lib/team-onboarding";
import { TeamOnboardingForm } from "./team-form";

export const dynamic = "force-dynamic";

export default async function TeamOnboardingPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const teams = await listTeamOptions();
  if (!isTeamOnboardingPending(user) || teams.length === 0) redirect("/settings?tab=install");

  const t = await getTranslations("auth");

  return (
    <AuthPageShell
      title={t("teamOnboarding.title")}
      description={t("teamOnboarding.description")}
    >
      <TeamOnboardingForm teams={teams} />
    </AuthPageShell>
  );
}
