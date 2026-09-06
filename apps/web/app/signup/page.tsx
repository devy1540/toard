import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { auth } from "@/auth";
import { AuthPageShell } from "@/components/auth/auth-page-shell";
import { hasAdminUser } from "@/lib/setup";
import { registrationMode } from "@/lib/registration";

export default async function SignupPage() {
  const session = await auth();
  if (session?.user) redirect("/");
  if (!(await hasAdminUser())) redirect("/setup");

  const t = await getTranslations("auth");

  return (
    <AuthPageShell
      title={t("signup.title")}
      description={
        registrationMode() === "verified_oauth"
          ? t("signup.verifiedOAuthDescription")
          : t("signup.inviteOnlyDescription")
      }
      contentClassName="flex flex-col gap-4"
    >
      <p className="text-muted-foreground text-center text-sm">
        {t("signup.haveAccount")}{" "}
        <Link href="/login" className="text-primary underline-offset-4 hover:underline">
          {t("signup.loginLink")}
        </Link>
      </p>
    </AuthPageShell>
  );
}
