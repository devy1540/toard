import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getIngestEndpoint, getPublicBaseUrl } from "@/lib/public-url";
import { getActiveTokenMeta } from "@/lib/tokens";
import { OnboardingPanel } from "./onboarding-panel";

export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  // 실제 세션 필수(폴백 신원 금지) — 토큰은 로그인한 본인에게 귀속.
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) redirect("/login");

  const [meta, endpoint, baseUrl] = await Promise.all([
    getActiveTokenMeta(userId),
    getIngestEndpoint(),
    getPublicBaseUrl(),
  ]);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">설치 · 온보딩</h1>
        <p className="text-muted-foreground text-sm">
          내 사용량을 toard 로 보내도록 <code>claude</code>/<code>codex</code> 래퍼(shim)를 설치합니다.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>1. 내 토큰 발급 · 설치</CardTitle>
          <CardDescription>
            토큰은 본인에게 귀속되어 사용량이 <b>내 계정</b>으로 집계됩니다. 관리자는 이 페이지 링크만
            공유하면 됩니다.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <OnboardingPanel
            baseUrl={baseUrl}
            endpoint={endpoint}
            hasToken={Boolean(meta)}
            createdAt={meta?.createdAt.toISOString() ?? null}
            lastUsedAt={meta?.lastUsedAt?.toISOString() ?? null}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>2. 확인</CardTitle>
          <CardDescription>설치가 되었는지 점검합니다.</CardDescription>
        </CardHeader>
        <CardContent className="text-muted-foreground space-y-1 text-sm">
          <p>
            • <code>which claude</code> → <code>~/.toard/bin/claude</code> 가 먼저 잡혀야 합니다(shim
            우선).
          </p>
          <p>
            • 이후 <code>claude</code> 사용 시 <a className="text-primary underline-offset-4 hover:underline" href="/me">마이페이지</a> 에 사용량이 쌓입니다.
          </p>
          <p>• 전제: 실제 Claude Code/Codex 가 설치되어 있어야 하며, 그 CLI 의 텔레메트리를 수집합니다.</p>
        </CardContent>
      </Card>
    </div>
  );
}
