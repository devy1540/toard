import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { auth, credentialsEnabled, oauthProviders, signIn } from "@/auth";
import { AuthPageShell } from "@/components/auth/auth-page-shell";
import { getValidInvite } from "@/lib/invites";
import { AcceptForm } from "./accept-form";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  // 이미 로그인 상태면 대시보드로.
  const session = await auth();
  if (session?.user) redirect("/");

  const { token } = await params;
  const invite = await getValidInvite(token);
  const t = await getTranslations("invite");

  return (
    <AuthPageShell
      title={t("title")}
      description={
        invite
          ? t("descriptionAdmission", { email: invite.email })
          : t("descriptionInvalid")
      }
    >
      {invite ? (
        <div className="flex flex-col gap-4">
          {oauthProviders.length > 0 ? (
            <div className="flex flex-col gap-2">
              <p className="text-muted-foreground text-sm">{t("verifiedOAuth", { email: invite.email })}</p>
              {oauthProviders.map((provider) => (
                <form key={provider} action={async () => {
                  "use server";
                  await signIn(provider, { redirectTo: "/settings?tab=install" });
                }}>
                  <Button variant="outline" type="submit" className="w-full">
                    {t("continueWith", { provider: provider === "github" ? "GitHub" : "Google" })}
                  </Button>
                </form>
              ))}
            </div>
          ) : null}
          {credentialsEnabled ? <AcceptForm token={token} email={invite.email} teamName={invite.teamName} /> : null}
        </div>
      ) : null}
    </AuthPageShell>
  );
}
