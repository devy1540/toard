import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { LogoMark } from "@/components/logo-mark";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
    <div className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <LogoMark size={32} className="mb-1" />
          <CardTitle className="text-xl">{t("teamOnboarding.title")}</CardTitle>
          <CardDescription>{t("teamOnboarding.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <TeamOnboardingForm teams={teams} />
        </CardContent>
      </Card>
    </div>
  );
}
