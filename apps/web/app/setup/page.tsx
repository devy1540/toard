import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { credentialsEnabled, oauthConfigured } from "@/auth";
import { AuthPageShell } from "@/components/auth/auth-page-shell";
import { browserSetupConfigured, hasAdminUser } from "@/lib/setup";
import { SetupForm } from "./setup-form";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  // 첫 admin 생성 전용 — 일반 member는 setup을 잠그지 않는다.
  if (await hasAdminUser()) redirect("/login");

  const t = await getTranslations("auth");

  return (
    <AuthPageShell title={t("setup.title")} description={t("setup.description")}>
      {browserSetupConfigured() && (credentialsEnabled || oauthConfigured)
        ? <SetupForm credentialsEnabled={credentialsEnabled} />
        : <p className="text-muted-foreground text-sm">{t(credentialsEnabled || oauthConfigured ? "setup.configurationRequired" : "login.noLoginMethod")}</p>}
    </AuthPageShell>
  );
}
