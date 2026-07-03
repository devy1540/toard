import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { auth, credentialsEnabled } from "@/auth";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { allowedDomains } from "@/lib/auth-policy";
import { SignupForm } from "./signup-form";

export default async function SignupPage() {
  const session = await auth();
  if (session?.user) redirect("/");
  // 비번 가입이 꺼져 있으면 로그인 페이지로.
  if (!credentialsEnabled) redirect("/login");

  const t = await getTranslations("auth");

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">{t("signup.title")}</CardTitle>
          <CardDescription>
            {allowedDomains.length > 0
              ? t("signup.descriptionWithDomains", { domains: allowedDomains.join(", ") })
              : t("signup.descriptionNoDomains")}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <SignupForm />
          <p className="text-muted-foreground text-center text-sm">
            {t("signup.haveAccount")}{" "}
            <Link href="/login" className="text-primary underline-offset-4 hover:underline">
              {t("signup.loginLink")}
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
