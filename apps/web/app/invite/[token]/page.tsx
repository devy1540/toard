import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { auth } from "@/auth";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getValidInvite } from "@/lib/invites";
import { AcceptForm } from "./accept-form";

export const dynamic = "force-dynamic";

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  // 이미 로그인 상태면 대시보드로.
  const session = await auth();
  if (session?.user) redirect("/");

  const { token } = await params;
  const invite = await getValidInvite(token);
  const t = await getTranslations("invite");

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">{t("title")}</CardTitle>
          <CardDescription>
            {invite
              ? t("descriptionValid", { email: invite.email })
              : t("descriptionInvalid")}
          </CardDescription>
        </CardHeader>
        {invite ? (
          <CardContent>
            <AcceptForm token={token} email={invite.email} />
          </CardContent>
        ) : null}
      </Card>
    </div>
  );
}
