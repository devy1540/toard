import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { AuthPageShell } from "@/components/auth/auth-page-shell";
import { Button } from "@/components/ui/button";
import { getSessionUser } from "@/lib/session-user";

export const dynamic = "force-dynamic";

export default async function TeamOnboardingPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const t = await getTranslations("auth");
  return (
    <AuthPageShell title={t("teamOnboarding.title")} description={t("errors.teamAssignmentByAdmin")}>
      <Button asChild><Link href="/settings?tab=install">{t("teamOnboarding.continueInstall")}</Link></Button>
    </AuthPageShell>
  );
}
