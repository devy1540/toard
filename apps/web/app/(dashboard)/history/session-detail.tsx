import { Fragment } from "react";
import { getLocale, getTranslations } from "next-intl/server";
import Link from "next/link";
import { ArrowLeft, Inbox, Lock, Sparkles, Terminal } from "lucide-react";
import { ProviderIcon } from "@/components/dashboard/provider-icon";
import { TurnText } from "@/components/dashboard/turn-text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Disclosure } from "@/components/ui/disclosure";
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
import { costCoverageForStatus, formatCostForCoverage } from "@/lib/pricing";
import { DETAIL_TURN_LIMIT, getMyHistorySession } from "@/lib/prompt-history";
import { getStorage } from "@/lib/storage";
import { detectMetaTurn } from "@/lib/turn-meta";
import { getViewerTimezone } from "@/lib/viewer-time";

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
  const costLabels = {
    partial: t("costCoverage.partial"),
    unpriced: t("costCoverage.unpriced"),
    legacy: t("costCoverage.legacy"),
  };
  const locale = await getLocale();
  const tz = await getViewerTimezone();
  const fmtTs = (ts: Date): string =>
    new Intl.DateTimeFormat(locale, { timeZone: tz, dateStyle: "medium", timeStyle: "short" }).format(ts);
  const fmtTime = (ts: Date): string =>
    new Intl.DateTimeFormat(locale, { timeZone: tz, timeStyle: "short" }).format(ts);
  const fmtDay = (ts: Date): string =>
    new Intl.DateTimeFormat(locale, { timeZone: tz, dateStyle: "medium" }).format(ts);

  const { enabled, session } = await getMyHistorySession(userId, sessionKey);
  if (!enabled) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Lock />
          </EmptyMedia>
          <EmptyTitle>{t("history.disabledTitle")}</EmptyTitle>
          <EmptyDescription>{t("history.disabledDescription")}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button asChild size="sm" variant="outline">
            <Link href={backHref}>{t("history.backToList")}</Link>
          </Button>
        </EmptyContent>
      </Empty>
    );
  }
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
      {
        label: t("cost"),
        value: formatCostForCoverage(fmtUsd(summary.costUsd), summary.costCoverage, costLabels),
      },
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

      {session.turns.length >= DETAIL_TURN_LIMIT ? (
        <p className="text-muted-foreground text-xs">
          {t("history.truncatedNote", { limit: DETAIL_TURN_LIMIT })}
        </p>
      ) : null}

      {/* 세션 정보는 넓은 화면에서 우측 sticky 패널, 좁은 화면에선 대화 위로 접힌다.
          DOM 은 [패널, 대화] 순서라 모바일에선 패널이 먼저, lg 의 flex-row-reverse 로 우측 배치. */}
      <div className="flex min-w-0 flex-col gap-4 lg:flex-row-reverse">
        <Card className="min-w-0 py-0 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:w-64 lg:shrink-0 lg:self-start lg:overflow-auto">
          <CardContent className="space-y-3 px-4 py-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary">{providerLabel(session.providerKey)}</Badge>
              {summary?.models.map((m) => (
                <Badge key={m} variant="outline" className="font-mono text-[11px]">
                  {m}
                </Badge>
              ))}
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 text-sm lg:grid-cols-1">
              {stats.map((s) => (
                <div key={s.label}>
                  <dt className="text-muted-foreground text-xs">{s.label}</dt>
                  <dd className="font-medium">{s.value}</dd>
                </div>
              ))}
            </dl>
            {session.isSession ? (
              <div className="text-muted-foreground border-t pt-2.5 font-mono text-xs">
                {t("history.sessionLabel")} #{session.key.slice(0, 8)}
              </div>
            ) : null}
          </CardContent>
        </Card>

        <div className="min-w-0 flex-1">
          {/* 턴 — 채팅 뷰: 프롬프트는 오른쪽 버블, 응답은 왼쪽 버블, CLI 가 끼워 넣은
              시스템·명령 메시지는 가운데 접힌 칩(details — JS 없이 동작)으로 분리 */}
          <Card className="min-w-0 py-0">
            <CardContent className="space-y-4 px-4 py-5 sm:px-6">
              {session.turns.map((turn, ti) => {
                const isUser = turn.role === "user";
                const usage = turnUsage.get(turn.dedupKey);
                const meta = isUser && !turn.contentUnavailable ? detectMetaTurn(turn.text) : null;
                const day = fmtDay(turn.ts);
                const prevTurn = ti > 0 ? session.turns[ti - 1] : undefined;
                const showDay = prevTurn !== undefined && fmtDay(prevTurn.ts) !== day;
                const content = turn.contentUnavailable ? (
                  <p className="text-muted-foreground text-sm italic">{t("history.contentUnavailable")}</p>
                ) : (
                  <TurnText
                    id={`tt-${ti}`}
                    text={turn.text}
                    more={t("history.showMore")}
                    less={t("history.showLess")}
                  />
                );
                return (
                  <Fragment key={turn.dedupKey}>
                    {showDay ? (
                      <div className="flex items-center gap-3 py-1">
                        <div className="bg-border h-px flex-1" />
                        <span className="text-muted-foreground text-xs">{day}</span>
                        <div className="bg-border h-px flex-1" />
                      </div>
                    ) : null}
                    {meta ? (
                      <Disclosure
                        className="text-center"
                        trigger={
                          <>
                          <Terminal className="size-3 shrink-0" />
                          <span className="truncate font-mono">
                            {meta.command ?? t("history.metaSystem")}
                          </span>
                          </>
                        }
                        triggerClassName="text-muted-foreground hover:text-foreground bg-muted/40 rounded-full border px-3 py-1 text-xs"
                      >
                        <pre className="bg-muted/40 mt-2 overflow-x-auto rounded-lg border p-3 text-left font-mono text-xs break-words whitespace-pre-wrap">
                          {turn.text}
                        </pre>
                      </Disclosure>
                    ) : isUser ? (
                      <div className="flex flex-col items-end">
                        <div className="bg-primary/10 max-w-[85%] rounded-2xl rounded-br-md px-3.5 py-2.5 sm:max-w-[70%]">
                          <span className="sr-only">{t("history.rolePrompt")}</span>
                          {content}
                        </div>
                        <span className="text-muted-foreground mt-1 text-[11px] tabular-nums">
                          {fmtTime(turn.ts)}
                        </span>
                      </div>
                    ) : (
                      <div className="flex max-w-[95%] gap-2.5 sm:max-w-[88%]">
                        <div className="bg-muted text-muted-foreground mt-1 flex size-6 shrink-0 items-center justify-center rounded-full border">
                          <ProviderIcon
                            providerKey={turn.providerKey}
                            className="size-3.5"
                            fallback={<Sparkles className="size-3.5" />}
                          />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="bg-muted/40 rounded-2xl rounded-tl-md border px-3.5 py-2.5">
                            <span className="sr-only">{t("history.roleResponse")}</span>
                            {content}
                          </div>
                          <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]">
                            {usage ? (
                              <span className="font-mono">
                                {usage.model ? `${usage.model} · ` : ""}↑{fmtCompact(usage.inputTokens)}{" "}
                                ↓{fmtCompact(usage.outputTokens)} ·{" "}
                                {formatCostForCoverage(
                                  fmtUsd(usage.costUsd),
                                  costCoverageForStatus(usage.costStatus),
                                  costLabels,
                                )}
                              </span>
                            ) : null}
                            <span className="tabular-nums">{fmtTime(turn.ts)}</span>
                          </div>
                        </div>
                      </div>
                    )}
                  </Fragment>
                );
              })}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
