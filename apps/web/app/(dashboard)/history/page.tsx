import { Inbox, Lock } from "lucide-react";
import { PageHeader } from "@/components/dashboard/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { getCurrentUserId } from "@/lib/current-user";
import { getOrgTimezone } from "@/lib/org-time";
import { getMyPromptHistory } from "@/lib/prompt-history";

export const dynamic = "force-dynamic";

function fmtTs(ts: Date): string {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: getOrgTimezone(),
    dateStyle: "medium",
    timeStyle: "short",
  }).format(ts);
}

/** 내 히스토리 — 본인 프롬프트·응답만. 관리자·타 사용자는 조회 불가(RLS + at-rest 암호화). */
export default async function HistoryPage() {
  const userId = await getCurrentUserId();
  if (!userId) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Inbox />
          </EmptyMedia>
          <EmptyTitle>로그인이 필요합니다</EmptyTitle>
          <EmptyDescription>내 히스토리를 보려면 로그인하세요.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const { enabled, items } = await getMyPromptHistory(userId);

  return (
    <div className="space-y-6">
      <PageHeader title="내 히스토리" description="내 프롬프트·응답 — 나만 볼 수 있습니다" />

      {!enabled ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Lock />
            </EmptyMedia>
            <EmptyTitle>본문 수집이 비활성화되어 있습니다</EmptyTitle>
            <EmptyDescription>
              서버에 본문 암호화 키(TOARD_CONTENT_KEK_B64)가 설정되면 프롬프트·응답이 저장됩니다.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : items.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Inbox />
            </EmptyMedia>
            <EmptyTitle>아직 저장된 히스토리가 없습니다</EmptyTitle>
            <EmptyDescription>
              shim 에서 본문 수집(TOARD_SHIM_COLLECT_CONTENT=1)을 켜면 여기에 쌓입니다.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <p className="text-muted-foreground flex items-center gap-1.5 text-sm">
            <Lock className="size-3.5" />
            나만 볼 수 있습니다 — 관리자·다른 사용자는 이 내용을 조회할 수 없습니다.
          </p>
          <div className="space-y-3">
            {items.map((it) => (
              <Card key={it.dedupKey}>
                <CardContent className="space-y-2 py-4">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <Badge variant={it.role === "user" ? "default" : "secondary"}>
                      {it.role === "user" ? "프롬프트" : "응답"}
                    </Badge>
                    <span className="text-muted-foreground">{it.providerKey}</span>
                    {it.sessionId ? (
                      <span className="text-muted-foreground max-w-[16rem] truncate">
                        · {it.sessionId}
                      </span>
                    ) : null}
                    <span className="text-muted-foreground ml-auto">{fmtTs(it.ts)}</span>
                  </div>
                  <p className="text-sm break-words whitespace-pre-wrap">{it.text}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
