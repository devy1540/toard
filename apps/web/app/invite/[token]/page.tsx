import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { auth } from "@/auth";
import { AuthPageShell } from "@/components/auth/auth-page-shell";
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
    <AuthPageShell
      title={t("title")}
      description={
        invite
          ? t("descriptionValid", { email: invite.email })
          : t("descriptionInvalid")
      }
    >
      {invite ? <AcceptForm token={token} email={invite.email} teamName={invite.teamName} /> : null}
    </AuthPageShell>
  );
}
