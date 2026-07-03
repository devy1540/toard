import Link from "next/link";
import { redirect } from "next/navigation";
import { auth, credentialsEnabled, oauthProviders, signIn } from "@/auth";
import { LogoMark } from "@/components/logo-mark";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { hasAnyUser } from "@/lib/setup";
import { LoginForm } from "./login-form";

const PROVIDER_LABELS: Record<string, string> = { github: "GitHub", google: "Google" };

export default async function LoginPage() {
  const session = await auth();
  if (session?.user) redirect("/");
  // 첫 실행(사용자 0명): 초기 설정으로 유도
  if (!(await hasAnyUser())) redirect("/setup");

  const hasOAuth = oauthProviders.length > 0;

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <LogoMark size={32} className="mb-1" />
          <CardTitle className="text-xl">toard 로그인</CardTitle>
          <CardDescription>AI 사용량 대시보드</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
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
                    {PROVIDER_LABELS[id] ?? id}로 계속
                  </Button>
                </form>
              ))}
            </div>
          ) : null}

          {hasOAuth && credentialsEnabled ? (
            <div className="text-muted-foreground flex items-center gap-3 text-xs">
              <span className="bg-border h-px flex-1" />
              또는
              <span className="bg-border h-px flex-1" />
            </div>
          ) : null}

          {credentialsEnabled ? (
            <>
              <LoginForm />
              <p className="text-muted-foreground text-center text-sm">
                계정이 없나요?{" "}
                <Link href="/signup" className="text-primary underline-offset-4 hover:underline">
                  가입
                </Link>
              </p>
            </>
          ) : null}

          {!credentialsEnabled && !hasOAuth ? (
            <p className="text-muted-foreground text-sm">
              구성된 로그인 수단이 없습니다. 관리자에게 문의하세요.
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
