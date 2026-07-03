import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { LogoMark } from "@/components/logo-mark";
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

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <LogoMark size={32} className="mb-1" />
          <CardTitle className="text-xl">toard 초대</CardTitle>
          <CardDescription>
            {invite
              ? `${invite.email} 로 초대되었습니다. 비밀번호를 설정해 가입하세요.`
              : "유효하지 않거나 만료된 초대 링크입니다. 관리자에게 다시 요청하세요."}
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
