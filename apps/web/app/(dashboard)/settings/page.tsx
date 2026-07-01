import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getPool } from "@/lib/db";
import { listPendingInvites } from "@/lib/invites";
import { getPublicBaseUrl } from "@/lib/public-url";
import { InvitePanel } from "./invite-panel";
import { PasswordForm } from "./password-form";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  // 실제 세션 필수 — 폴백 신원으로는 접근 불가.
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) redirect("/login");

  const r = await getPool().query<{ email: string; password_hash: string | null; role: string }>(
    "SELECT email, password_hash, role FROM users WHERE id = $1",
    [userId],
  );
  const email = r.rows[0]?.email ?? null;
  const hasPassword = Boolean(r.rows[0]?.password_hash);
  const isAdmin = r.rows[0]?.role === "admin";

  const [baseUrl, pending] = isAdmin
    ? await Promise.all([getPublicBaseUrl(), listPendingInvites()])
    : ["", []];

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div>
        <h1 className="text-2xl font-bold">설정</h1>
        {email ? <p className="text-muted-foreground text-sm">{email}</p> : null}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{hasPassword ? "비밀번호 변경" : "비밀번호 설정"}</CardTitle>
          <CardDescription>
            {hasPassword
              ? "현재 비밀번호를 확인한 뒤 새 비밀번호로 변경합니다."
              : "이 계정에 비밀번호를 설정하면 id/pw 로그인이 가능합니다."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PasswordForm hasPassword={hasPassword} />
        </CardContent>
      </Card>

      {isAdmin ? (
        <Card>
          <CardHeader>
            <CardTitle>멤버 초대</CardTitle>
            <CardDescription>
              초대 링크를 만들어 전달하면, 받은 사람이 비밀번호를 설정해 가입하고 설치까지 이어집니다.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <InvitePanel
              baseUrl={baseUrl}
              pending={pending.map((p) => ({
                email: p.email,
                role: p.role,
                expiresAt: p.expiresAt.toISOString(),
              }))}
            />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
