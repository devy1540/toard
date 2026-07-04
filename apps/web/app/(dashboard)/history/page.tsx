import { getLocale, getTranslations } from "next-intl/server";
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

/** 내 히스토리 — 본인 프롬프트·응답만. 관리자·타 사용자는 조회 불가(RLS + at-rest 암호화). */
export default async function HistoryPage() {
  const t = await getTranslations("dashboard");
  const locale = await getLocale();
  const fmtTs = (ts: Date): string =>
    new Intl.DateTimeFormat(locale, {
      timeZone: getOrgTimezone(),
      dateStyle: "medium",
      timeStyle: "short",
    }).format(ts);

  const userId = await getCurrentUserId();
  if (!userId) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Inbox />
          </EmptyMedia>
          <EmptyTitle>{t("history.loginRequiredTitle")}</EmptyTitle>
          <EmptyDescription>{t("history.loginRequiredDescription")}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const { enabled, items } = await getMyPromptHistory(userId);

  return (
    <div className="space-y-6">
      <PageHeader title={t("history.title")} description={t("history.description")} />

      {!enabled ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Lock />
            </EmptyMedia>
            <EmptyTitle>{t("history.disabledTitle")}</EmptyTitle>
            <EmptyDescription>{t("history.disabledDescription")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : items.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Inbox />
            </EmptyMedia>
            <EmptyTitle>{t("history.emptyTitle")}</EmptyTitle>
            <EmptyDescription>{t("history.emptyDescription")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <p className="text-muted-foreground flex items-center gap-1.5 text-sm">
            <Lock className="size-3.5" />
            {t("history.privacyNote")}
          </p>
          <div className="space-y-3">
            {items.map((it) => (
              <Card key={it.dedupKey}>
                <CardContent className="space-y-2 py-4">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <Badge variant={it.role === "user" ? "default" : "secondary"}>
                      {it.role === "user" ? t("history.rolePrompt") : t("history.roleResponse")}
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
