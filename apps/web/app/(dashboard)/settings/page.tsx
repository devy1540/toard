import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getCurrentUserId } from "@/lib/current-user";
import { getPool } from "@/lib/db";
import { PasswordForm } from "./password-form";

export default async function SettingsPage() {
  const userId = await getCurrentUserId();
  let email: string | null = null;
  let hasPassword = false;
  if (userId) {
    const r = await getPool().query<{ email: string; password_hash: string | null }>(
      "SELECT email, password_hash FROM users WHERE id = $1",
      [userId],
    );
    email = r.rows[0]?.email ?? null;
    hasPassword = Boolean(r.rows[0]?.password_hash);
  }

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
    </div>
  );
}
