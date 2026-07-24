import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { auth, credentialsEnabled } from "@/auth";
import { AuthPageShell } from "@/components/auth/auth-page-shell";
import { allowedDomains } from "@/lib/auth-policy";
import { SignupForm } from "./signup-form";

export default async function SignupPage() {
  const session = await auth();
  if (session?.user) redirect("/");
  // 비번 가입이 꺼져 있으면 로그인 페이지로.
  if (!credentialsEnabled) redirect("/login");

  const t = await getTranslations("auth");

  return (
    <AuthPageShell
      title={t("signup.title")}
      description={
        allowedDomains.length > 0
          ? t("signup.descriptionWithDomains", { domains: allowedDomains.join(", ") })
          : t("signup.descriptionNoDomains")
      }
      contentClassName="flex flex-col gap-4"
    >
      <SignupForm />
      <p className="text-muted-foreground text-center text-sm">
        {t("signup.haveAccount")}{" "}
        <Link href="/login" className="text-primary underline-offset-4 hover:underline">
          {t("signup.loginLink")}
        </Link>
      </p>
    </AuthPageShell>
  );
}
