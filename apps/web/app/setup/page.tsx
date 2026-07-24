import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { AuthPageShell } from "@/components/auth/auth-page-shell";
import { hasAnyUser } from "@/lib/setup";
import { SetupForm } from "./setup-form";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  // 첫 실행 전용 — 이미 사용자가 있으면 잠긴다.
  if (await hasAnyUser()) redirect("/login");

  const t = await getTranslations("auth");

  return (
    <AuthPageShell title={t("setup.title")} description={t("setup.description")}>
      <SetupForm />
    </AuthPageShell>
  );
}
