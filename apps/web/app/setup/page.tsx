import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { LogoMark } from "@/components/logo-mark";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { hasAnyUser } from "@/lib/setup";
import { SetupForm } from "./setup-form";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  // 첫 실행 전용 — 이미 사용자가 있으면 잠긴다.
  if (await hasAnyUser()) redirect("/login");

  const t = await getTranslations("auth");

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <LogoMark size={32} className="mb-1" />
          <CardTitle className="text-xl">{t("setup.title")}</CardTitle>
          <CardDescription>{t("setup.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <SetupForm />
        </CardContent>
      </Card>
    </div>
  );
}
