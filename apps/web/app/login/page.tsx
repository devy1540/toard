import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { auth, credentialsEnabled, oauthProviders, signIn } from "@/auth";
import { AuthPageShell } from "@/components/auth/auth-page-shell";
import { Button } from "@/components/ui/button";
import { hasAnyUser } from "@/lib/setup";
import { LoginForm } from "./login-form";

const PROVIDER_LABELS: Record<string, string> = { github: "GitHub", google: "Google" };

export default async function LoginPage() {
  const session = await auth();
  if (session?.user) redirect("/");
  // 첫 실행(사용자 0명): 초기 설정으로 유도
  if (!(await hasAnyUser())) redirect("/setup");

  const t = await getTranslations("auth");
  const hasOAuth = oauthProviders.length > 0;

  return (
    <AuthPageShell
      title={t("login.title")}
      description={t("login.description")}
      contentClassName="flex flex-col gap-4"
    >
      {hasOAuth ? (
        <div className="flex flex-col gap-2">
          {oauthProviders.map((id) => (
            <form
              key={id}
              action={async () => {
                "use server";
                await signIn(id, { redirectTo: "/" });
              }}
            >
              <Button type="submit" variant="outline" className="w-full">
                {t("login.continueWith", { provider: PROVIDER_LABELS[id] ?? id })}
              </Button>
            </form>
          ))}
        </div>
      ) : null}

      {hasOAuth && credentialsEnabled ? (
        <div className="text-muted-foreground flex items-center gap-3 text-xs">
          <span className="bg-border h-px flex-1" />
          {t("login.or")}
          <span className="bg-border h-px flex-1" />
        </div>
      ) : null}

      {credentialsEnabled ? (
        <>
          <LoginForm />
          <p className="text-muted-foreground text-center text-sm">
            {t("login.noAccount")}{" "}
            <Link href="/signup" className="text-primary underline-offset-4 hover:underline">
              {t("login.signupLink")}
            </Link>
          </p>
        </>
      ) : null}

      {!credentialsEnabled && !hasOAuth ? (
        <p className="text-muted-foreground text-sm">{t("login.noLoginMethod")}</p>
      ) : null}
    </AuthPageShell>
  );
}
