import Link from "next/link";
import { redirect } from "next/navigation";
import { auth, credentialsEnabled } from "@/auth";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { allowedDomains } from "@/lib/auth-policy";
import { SignupForm } from "./signup-form";

export default async function SignupPage() {
  const session = await auth();
  if (session?.user) redirect("/");
  // 비번 가입이 꺼져 있으면 로그인 페이지로.
  if (!credentialsEnabled) redirect("/login");

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">toard 가입</CardTitle>
          <CardDescription>
            {allowedDomains.length > 0
              ? `${allowedDomains.join(", ")} 도메인 이메일로 가입할 수 있습니다.`
              : "이메일과 비밀번호로 가입합니다."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <SignupForm />
          <p className="text-muted-foreground text-center text-sm">
            이미 계정이 있나요?{" "}
            <Link href="/login" className="text-primary underline-offset-4 hover:underline">
              로그인
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
