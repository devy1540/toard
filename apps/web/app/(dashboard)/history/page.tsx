import { getLocale, getTranslations } from "next-intl/server";
import { Inbox, Lock, Sparkles, User } from "lucide-react";
import { PageHeader } from "@/components/dashboard/page-header";
import { TurnText } from "@/components/dashboard/turn-text";
import { Card, CardContent } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { getCurrentUserId } from "@/lib/current-user";
import { groupBySession } from "@/lib/history-grouping";
import { getOrgTimezone } from "@/lib/org-time";
import { getMyPromptHistory } from "@/lib/prompt-history";

export const dynamic = "force-dynamic";

/** 내 히스토리 — 본인 프롬프트·응답만. 관리자·타 사용자는 조회 불가(RLS + at-rest 암호화).
 *  대화(세션) 단위로 묶어 프롬프트→응답 시간순으로 보여준다. */
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
  const sessions = groupBySession(items);

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
          <div className="space-y-4">
            {sessions.map((s, si) => (
              <Card key={s.key} className="overflow-hidden py-0">
                <CardContent className="p-0">
                  {/* 세션 헤더 — provider · 짧은 세션 id · 시각 */}
                  <div className="text-muted-foreground bg-muted/40 flex items-center gap-2 border-b px-4 py-2 text-xs">
                    <span className="text-foreground font-medium">{s.provider}</span>
                    {s.shortId ? <span className="font-mono">#{s.shortId}</span> : null}
                    <span className="ml-auto">{fmtTs(s.latest)}</span>
                  </div>
                  {/* 턴 — 프롬프트→응답 시간순 */}
                  <div className="divide-y">
                    {s.turns.map((turn, ti) => {
                      const isUser = turn.role === "user";
                      return (
                        <div
                          key={turn.dedupKey}
                          className={`flex gap-3 px-4 py-3 ${isUser ? "" : "bg-muted/30"}`}
                        >
                          <div
                            className={`mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full ${
                              isUser
                                ? "bg-primary text-primary-foreground"
                                : "bg-muted text-muted-foreground border"
                            }`}
                          >
                            {isUser ? <User className="size-3.5" /> : <Sparkles className="size-3.5" />}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="text-muted-foreground mb-1 text-xs font-medium">
                              {isUser ? t("history.rolePrompt") : t("history.roleResponse")}
                            </div>
                            <TurnText
                              id={`tt-${si}-${ti}`}
                              text={turn.text}
                              more={t("history.showMore")}
                              less={t("history.showLess")}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
