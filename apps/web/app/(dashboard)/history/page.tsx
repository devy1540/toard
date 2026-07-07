import { getLocale, getTranslations } from "next-intl/server";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Inbox, Lock } from "lucide-react";
import { DashboardFilters } from "@/components/dashboard/dashboard-filters";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { getCurrentUserId } from "@/lib/current-user";
import { fmtCompact, fmtUsd } from "@/lib/format";
import { parseFilters, type DashboardSearchParams } from "@/lib/period";
import { getMyHistorySessions } from "@/lib/prompt-history";
import { getEnabledProviders } from "@/lib/providers";
import { getStorage } from "@/lib/storage";
import { getViewerTimezone } from "@/lib/viewer-time";
import { SessionDetail } from "./session-detail";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 20;
/** 목록 배지로 노출할 모델 수 상한 — 넘치면 "+N" 로 접는다 */
const MODEL_BADGE_MAX = 2;

interface HistorySearchParams extends DashboardSearchParams {
  /** 열린 세션(그룹) 키 — 있으면 상세 뷰 */
  session?: string;
  /** 1-기반 페이지 번호 */
  page?: string;
}

/** 현재 필터를 보존한 /history URL — overrides 로 일부만 바꾼다(null = 제거). */
function historyHref(sp: HistorySearchParams, overrides: Record<string, string | null>): string {
  const p = new URLSearchParams();
  for (const k of ["period", "provider", "from", "to", "page", "session"] as const) {
    const v = sp[k];
    if (v) p.set(k, v);
  }
  for (const [k, v] of Object.entries(overrides)) {
    if (v === null) p.delete(k);
    else p.set(k, v);
  }
  const s = p.toString();
  return s ? `/history?${s}` : "/history";
}

/** 내 히스토리 — 본인 프롬프트·응답만. 관리자·타 사용자는 조회 불가(RLS + at-rest 암호화).
 *  목록(세션 요약 + usage 조인) ↔ 상세(?session=, 턴 전체) 두 뷰로 나뉜다. */
export default async function HistoryPage({
  searchParams,
}: {
  searchParams: Promise<HistorySearchParams>;
}) {
  const t = await getTranslations("dashboard");
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

  const sp = await searchParams;
  const providers = await getEnabledProviders();
  const providerLabel = (key: string): string => providers.find((p) => p.key === key)?.label ?? key;

  // ── 상세 뷰 ──
  if (sp.session) {
    return (
      <div className="space-y-6">
        <h1 className="text-sm font-medium">{t("history.title")}</h1>
        <SessionDetail
          userId={userId}
          sessionKey={sp.session}
          backHref={historyHref(sp, { session: null })}
          providerLabel={providerLabel}
        />
      </div>
    );
  }

  // ── 목록 뷰 ──
  const locale = await getLocale();
  const timezone = await getViewerTimezone();
  const fmtTs = (ts: Date): string =>
    new Intl.DateTimeFormat(locale, {
      timeZone: timezone,
      dateStyle: "medium",
      timeStyle: "short",
    }).format(ts);

  const filter = parseFilters(sp, timezone, "all");
  const page = Math.max(0, (Number.parseInt(sp.page ?? "", 10) || 1) - 1);
  const { enabled, sessions, totalSessions } = await getMyHistorySessions(
    userId,
    filter,
    page,
    PAGE_SIZE,
  );

  if (!enabled) {
    return (
      <div className="space-y-6">
        <h1 className="text-sm font-medium">{t("history.title")}</h1>
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Lock />
            </EmptyMedia>
            <EmptyTitle>{t("history.disabledTitle")}</EmptyTitle>
            <EmptyDescription>{t("history.disabledDescription")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  // usage 조인 — 이 페이지에 노출되는 세션만 (solo 턴은 session_id 없음 → 스킵)
  const sessionKeys = sessions.filter((s) => s.isSession).map((s) => s.key);
  const summaries =
    sessionKeys.length > 0 ? await getStorage().getSessionUsageSummaries(userId, sessionKeys) : [];
  const usageByKey = new Map(summaries.map((s) => [s.sessionId, s]));

  const totalPages = Math.max(1, Math.ceil(totalSessions / PAGE_SIZE));
  // page 파라미터는 1-기반 표시 번호 — 첫 페이지는 파라미터 제거로 URL 을 깔끔하게
  const prevHref = historyHref(sp, { page: page <= 1 ? null : String(page) });
  const nextHref = historyHref(sp, { page: String(page + 2) });
  // 기본 필터(전체 기간·전체 도구) 그대로인데 0건 = 수집 자체가 없는 것
  const noFilter = (!sp.period || sp.period === "all") && (!sp.provider || sp.provider === "all");

  return (
    <div className="space-y-6">
      <DashboardFilters
        providers={providers}
        defaultPeriod="all"
        showAllPreset
        resetKeys={["page", "session"]}
        timezone={timezone}
        title={t("history.title")}
        trailing={
          <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
            <Lock className="size-3.5" />
            {t("history.privacyNote")}
          </span>
        }
      />

      {totalSessions === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Inbox />
            </EmptyMedia>
            <EmptyTitle>{noFilter ? t("history.emptyTitle") : t("history.noMatchTitle")}</EmptyTitle>
            <EmptyDescription>
              {noFilter ? t("history.emptyDescription") : t("history.noMatchDescription")}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <Card className="overflow-hidden py-0">
            <CardContent className="p-0">
              <div className="divide-y">
                {sessions.map((s) => {
                  const usage = usageByKey.get(s.key);
                  const models = usage?.models ?? [];
                  return (
                    <Link
                      key={s.key}
                      href={historyHref(sp, { session: s.key })}
                      className="hover:bg-muted/40 block px-4 py-3 transition-colors"
                    >
                      <div className="flex items-baseline gap-3">
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">
                          {s.preview}
                        </span>
                        {usage ? (
                          <span className="shrink-0 text-sm tabular-nums">
                            {fmtUsd(usage.costUsd)}
                          </span>
                        ) : null}
                      </div>
                      <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                        <Badge variant="secondary" className="text-[11px]">
                          {providerLabel(s.providerKey)}
                        </Badge>
                        {models.slice(0, MODEL_BADGE_MAX).map((m) => (
                          <Badge key={m} variant="outline" className="font-mono text-[11px]">
                            {m}
                          </Badge>
                        ))}
                        {models.length > MODEL_BADGE_MAX ? (
                          <span>+{models.length - MODEL_BADGE_MAX}</span>
                        ) : null}
                        <span>{t("history.turns", { count: s.turnCount })}</span>
                        {usage ? (
                          <span>
                            {fmtCompact(
                              usage.inputTokens +
                                usage.outputTokens +
                                usage.cacheReadTokens +
                                usage.cacheCreationTokens,
                            )}{" "}
                            {t("tokens")}
                          </span>
                        ) : null}
                        {usage && usage.hosts.length > 0 ? <span>{usage.hosts.join(", ")}</span> : null}
                        <span className="ml-auto tabular-nums">{fmtTs(s.latestTs)}</span>
                      </div>
                    </Link>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-muted-foreground text-sm">
              {t("history.listTotal", { count: totalSessions })}
            </span>
            {totalPages > 1 ? (
              <div className="flex items-center gap-2">
                {page > 0 ? (
                  <Button asChild variant="outline" size="sm">
                    <Link href={prevHref}>
                      <ChevronLeft className="size-4" />
                      {t("history.prev")}
                    </Link>
                  </Button>
                ) : (
                  <Button variant="outline" size="sm" disabled>
                    <ChevronLeft className="size-4" />
                    {t("history.prev")}
                  </Button>
                )}
                <span className="text-muted-foreground text-sm tabular-nums">
                  {t("history.pageInfo", { page: page + 1, totalPages })}
                </span>
                {page + 1 < totalPages ? (
                  <Button asChild variant="outline" size="sm">
                    <Link href={nextHref}>
                      {t("history.next")}
                      <ChevronRight className="size-4" />
                    </Link>
                  </Button>
                ) : (
                  <Button variant="outline" size="sm" disabled>
                    {t("history.next")}
                    <ChevronRight className="size-4" />
                  </Button>
                )}
              </div>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
