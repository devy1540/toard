import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { LinkTabs } from "@/components/dashboard/link-tabs";
import { PageHeader } from "@/components/dashboard/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { contentCollectionEnabled } from "@/lib/content-crypto";
import { getPool } from "@/lib/db";
import { getIngestEndpoint, getPublicBaseUrl } from "@/lib/public-url";
import { getActiveTokenMeta } from "@/lib/tokens";
import { ConnectionCheck } from "./connection-check";
import { OnboardingPanel } from "./onboarding-panel";
import { PasswordForm } from "./password-form";

export const dynamic = "force-dynamic";

type Tab = "account" | "install";

/** 설정 — 계정·설치 탭 (멤버 관리는 /admin 으로 분리, 역할 축 개편). */
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  // 실제 세션 필수 — 폴백 신원으로는 접근 불가.
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) redirect("/login");

  const r = await getPool().query<{ email: string; password_hash: string | null }>(
    "SELECT email, password_hash FROM users WHERE id = $1",
    [userId],
  );
  const email = r.rows[0]?.email ?? null;
  const hasPassword = Boolean(r.rows[0]?.password_hash);

  const tab: Tab = (await searchParams).tab === "install" ? "install" : "account";

  return (
    <div className="space-y-6">
      <PageHeader title="설정" description={email ?? undefined} />

      <LinkTabs
        active={tab}
        tabs={[
          { value: "account", label: "계정", href: "/settings?tab=account" },
          { value: "install", label: "설치 · 토큰", href: "/settings?tab=install" },
        ]}
      />

      {tab === "account" ? <AccountTab hasPassword={hasPassword} /> : <InstallTab userId={userId} />}
    </div>
  );
}

function AccountTab({ hasPassword }: { hasPassword: boolean }) {
  return (
    <div className="grid items-start gap-4 lg:grid-cols-2">
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

async function InstallTab({ userId }: { userId: string }) {
  const [meta, endpoint, baseUrl] = await Promise.all([
    getActiveTokenMeta(userId),
    getIngestEndpoint(),
    getPublicBaseUrl(),
  ]);
  const contentEnabled = contentCollectionEnabled();

  return (
    <div className="grid items-start gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle>내 토큰 발급 · 설치</CardTitle>
          <CardDescription>
            내 사용량을 toard 로 보내도록 <code>claude</code>/<code>codex</code> 래퍼(shim)를
            설치합니다. 토큰은 본인에게 귀속되어 사용량이 <b>내 계정</b>으로 집계됩니다.{" "}
            {contentEnabled ? (
              <>
                기본은 <b>프롬프트·코드 내용을 수집하지 않고</b> 사용량 메타데이터만 보냅니다 —
                아래에서 본문 수집을 켤 수 있습니다.
              </>
            ) : (
              <>
                <b>프롬프트·코드 내용은 수집하지 않습니다</b> — 토큰 수·모델·비용 등 사용량
                메타데이터만 전송됩니다.
              </>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <OnboardingPanel
            baseUrl={baseUrl}
            endpoint={endpoint}
            hasToken={Boolean(meta)}
            createdAt={meta?.createdAt.toISOString() ?? null}
            lastUsedAt={meta?.lastUsedAt?.toISOString() ?? null}
            contentEnabled={contentEnabled}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>연결 확인</CardTitle>
          <CardDescription>설치 후 데이터가 실제로 수신되는지 확인합니다.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ConnectionCheck
            initialHasToken={Boolean(meta)}
            initialLastUsedAt={meta?.lastUsedAt?.toISOString() ?? null}
          />
          <div className="text-muted-foreground space-y-1 border-t pt-3 text-sm">
            <p>
              • <code>which claude</code> → <code>~/.toard/bin/claude</code> 가 먼저 잡혀야
              합니다(shim 우선).
            </p>
            <p>
              • 이후 <code>claude</code> 사용 시 <a className="text-primary underline-offset-4 hover:underline" href="/">내 사용량</a> 에 쌓입니다.
            </p>
            <p>• 전제: 실제 Claude Code/Codex 가 설치되어 있어야 하며, 그 CLI 의 텔레메트리를 수집합니다.</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
