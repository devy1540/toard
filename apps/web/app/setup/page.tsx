import { redirect } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { hasAnyUser } from "@/lib/setup";
import { SetupForm } from "./setup-form";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  // 첫 실행 전용 — 이미 사용자가 있으면 잠긴다.
  if (await hasAnyUser()) redirect("/login");

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">toard 초기 설정</CardTitle>
          <CardDescription>
            첫 관리자 계정을 만듭니다. 이 계정이 대시보드를 운영합니다.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SetupForm />
        </CardContent>
      </Card>
    </div>
  );
}
