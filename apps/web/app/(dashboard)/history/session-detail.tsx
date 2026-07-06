import { getLocale, getTranslations } from "next-intl/server";
import Link from "next/link";
import { ArrowLeft, Inbox, Sparkles, User } from "lucide-react";
import { TurnText } from "@/components/dashboard/turn-text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { fmtCompact, fmtUsd } from "@/lib/format";
import { matchTurnUsage } from "@/lib/history-grouping";
import { getOrgTimezone } from "@/lib/org-time";
import { DETAIL_TURN_LIMIT, getMyHistorySession } from "@/lib/prompt-history";
import { getStorage } from "@/lib/storage";

/** 세션 상세 — 한 대화의 전체 턴 + usage 조인(세션 합계 헤더, assistant 턴별 모델·토큰·비용). */
export async function SessionDetail({
  userId,
  sessionKey,
  backHref,
  providerLabel,
}: {
  userId: string;
  sessionKey: string;
  backHref: string;
  providerLabel: (key: string) => string;
}) {
  const t = await getTranslations("dashboard");
  const locale = await getLocale();
  const tz = getOrgTimezone();
  const fmtTs = (ts: Date): string =>
    new Intl.DateTimeFormat(locale, { timeZone: tz, dateStyle: "medium", timeStyle: "short" }).format(ts);
  const fmtTime = (ts: Date): string =>
    new Intl.DateTimeFormat(locale, { timeZone: tz, timeStyle: "short" }).format(ts);

  const { session } = await getMyHistorySession(userId, sessionKey);
  if (!session) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Inbox />
          </EmptyMedia>
          <EmptyTitle>{t("history.notFoundTitle")}</EmptyTitle>
          <EmptyDescription>{t("history.notFoundDescription")}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button asChild size="sm" variant="outline">
            <Link href={backHref}>{t("history.backToList")}</Link>
          </Button>
        </EmptyContent>
      </Empty>
    );
  }

  // usage 조인 — 세션 합계(요약)와 턴별 매칭용 이벤트를 병렬로. solo 턴은 session_id 가 없어 스킵.
  const [summaries, events] = session.isSession
    ? await Promise.all([
        getStorage().getSessionUsageSummaries(userId, [session.key]),
        getStorage().getSessionUsageEvents(userId, session.key),
      ])
    : [[], []];
  const summary = summaries[0];
  const turnUsage = matchTurnUsage(session.turns, events);

  const stats: Array<{ label: string; value: string }> = [
    { label: t("history.startedAt"), value: fmtTs(session.firstTs) },
    { label: t("history.endedAt"), value: fmtTs(session.latestTs) },
    { label: t("history.turnCount"), value: String(session.turns.length) },
  ];
  if (summary) {
    stats.push(
      {
        label: t("tokens"),
        value: `${t("history.inputShort")} ${fmtCompact(summary.inputTokens)} · ${t("history.outputShort")} ${fmtCompact(summary.outputTokens)} · ${t("history.cacheShort")} ${fmtCompact(summary.cacheReadTokens + summary.cacheCreationTokens)}`,
      },
      { label: t("cost"), value: fmtUsd(summary.costUsd) },
    );
    if (summary.hosts.length > 0) {
      stats.push({ label: t("computer"), value: summary.hosts.join(", ") });
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <Button asChild size="sm" variant="ghost" className="text-muted-foreground -ml-2">
          <Link href={backHref}>
            <ArrowLeft className="size-4" />
            {t("history.backToList")}
          </Link>
        </Button>
      </div>

      {/* 세션 요약 헤더 */}
      <Card>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{providerLabel(session.providerKey)}</Badge>
            {summary?.models.map((m) => (
              <Badge key={m} variant="outline" className="font-mono text-[11px]">
                {m}
              </Badge>
            ))}
            {session.isSession ? (
              <span className="text-muted-foreground ml-auto font-mono text-xs">
                {t("history.sessionLabel")} #{session.key.slice(0, 8)}
              </span>
            ) : null}
          </div>
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
            {stats.map((s) => (
              <div key={s.label}>
                <dt className="text-muted-foreground text-xs">{s.label}</dt>
                <dd className="font-medium">{s.value}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>

      {session.turns.length >= DETAIL_TURN_LIMIT ? (
        <p className="text-muted-foreground text-xs">
          {t("history.truncatedNote", { limit: DETAIL_TURN_LIMIT })}
        </p>
      ) : null}

      {/* 턴 — 프롬프트→응답 시간순, assistant 턴에 usage 칩 */}
      <Card className="overflow-hidden py-0">
        <CardContent className="p-0">
          <div className="divide-y">
            {session.turns.map((turn, ti) => {
              const isUser = turn.role === "user";
              const usage = turnUsage.get(turn.dedupKey);
              return (
                <div key={turn.dedupKey} className={`flex gap-3 px-4 py-3 ${isUser ? "" : "bg-muted/30"}`}>
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
                    <div className="text-muted-foreground mb-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                      <span className="font-medium">
                        {isUser ? t("history.rolePrompt") : t("history.roleResponse")}
                      </span>
                      {usage ? (
                        <span className="font-mono text-[11px]">
                          {usage.model ? `${usage.model} · ` : ""}↑{fmtCompact(usage.inputTokens)} ↓
                          {fmtCompact(usage.outputTokens)} · {fmtUsd(usage.costUsd)}
                        </span>
                      ) : null}
                      <span className="ml-auto tabular-nums">{fmtTime(turn.ts)}</span>
                    </div>
                    <TurnText
                      id={`tt-${ti}`}
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
    </div>
  );
}
