import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { ChevronRight, Inbox, Lock } from "lucide-react";
import type { SessionUsageSummary } from "@toard/core";
import { DashboardFilters } from "@/components/dashboard/dashboard-filters";
import { FeatureStatusBadge } from "@/components/dashboard/feature-status-badge";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Button } from "@/components/ui/button";
import { getCurrentUserId } from "@/lib/current-user";
import { getE2eeContentStatus } from "@/lib/e2ee-history";
import { getE2eeManagedMigrationStatus } from "@/lib/e2ee-to-managed-migration";
import { fmtUsd } from "@/lib/format";
import { parseFilters, type DashboardSearchParams } from "@/lib/period";
import { formatCostForCoverage } from "@/lib/pricing";
import {
  getMyHistorySessions,
  normalizeHistorySearchQuery,
  searchMyHistorySessions,
} from "@/lib/prompt-history";
import { getEnabledProviders } from "@/lib/providers";
import { getStorage } from "@/lib/storage";
import { getViewerTimezone } from "@/lib/viewer-time";
import { getHistoryMfaGate } from "@/lib/history-mfa";
import { decodeHistorySearchQueryToken } from "@/lib/history-search-token";
import { SessionDetail } from "./session-detail";
import { E2eeHistoryClient } from "./e2ee-history-client";
import { HistorySecurityLink } from "./history-security-link";
import { HistorySearchControls } from "./history-search-controls";
import { HistorySessionList } from "./history-session-list";
import type { HistoryListItem } from "./history-list-view";
import { HistoryMfaUnlock } from "./history-mfa-unlock";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 20;
function PageTitle({
  title,
  badgeLabel,
}: {
  title: string;
  badgeLabel: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <h1 className="text-sm font-medium">{title}</h1>
      <FeatureStatusBadge status="preview">{badgeLabel}</FeatureStatusBadge>
    </div>
  );
}

interface HistorySearchParams extends DashboardSearchParams {
  /** 열린 세션(그룹) 키 — 있으면 상세 뷰 */
  session?: string;
  /** 1-기반 페이지 번호 */
  page?: string;
  /** active E2EE 계정에서 명시적으로 고른 열람 소스 */
  source?: "e2ee" | "managed";
  /** 서버에서 암호화한 관리형/레거시 본문 검색어 */
  search?: string;
  /** 본문 검색의 서명된 다음 스캔 위치 */
  cursor?: string;
  /** 메인/서브에이전트 메타데이터 필터 */
  agent?: "main" | "subagent";
}

/** 현재 필터를 보존한 /history URL — overrides 로 일부만 바꾼다(null = 제거). */
function historyHref(sp: HistorySearchParams, overrides: Record<string, string | null>): string {
  const p = new URLSearchParams();
  for (const k of [
    "period", "provider", "from", "to", "page", "session", "source", "search", "cursor", "agent",
  ] as const) {
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

function totalUsageTokens(usage: SessionUsageSummary): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
}

/** 내 히스토리 — 본인 프롬프트·응답만. 관리자·타 사용자는 조회 불가(RLS + at-rest 암호화).
 *  목록(세션 요약 + usage 조인) ↔ 상세(?session=, 턴 전체) 두 뷰로 나뉜다. */
export default async function HistoryPage({
  searchParams,
}: {
  searchParams: Promise<HistorySearchParams>;
}) {
  const t = await getTranslations("dashboard");
  const navT = await getTranslations("nav");
  const costLabels = {
    partial: t("costCoverage.partial"),
    unpriced: t("costCoverage.unpriced"),
    legacy: t("costCoverage.legacy"),
  };
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
  const authEnabled = (process.env.AUTH_MODE ?? "oauth") !== "open";
  if (authEnabled) {
    const historyMfa = await getHistoryMfaGate(userId);
    if (historyMfa.required && !historyMfa.verified) {
      return <HistoryMfaUnlock returnTo={historyHref(sp, {})} />;
    }
  }
  const e2eeAllowed = authEnabled;
  const providers = await getEnabledProviders();
  const providerLabel = (key: string): string => providers.find((p) => p.key === key)?.label ?? key;
  const locale = await getLocale();
  const timezone = await getViewerTimezone();
  if (e2eeAllowed) {
    const contentStatus = await getE2eeContentStatus(userId);
    if (contentStatus.state === "active") {
      const migrationStatus = await getE2eeManagedMigrationStatus(userId);
      if (migrationStatus.state !== "complete") {
        return (
          <E2eeHistoryClient
            providers={providers}
            timezone={timezone}
            previewBadgeLabel={navT("badge.preview")}
          />
        );
      }
    }
  }

  // ── 상세 뷰 ──
  if (sp.session) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <PageTitle title={t("history.title")} badgeLabel={navT("badge.preview")} />
          <HistorySecurityLink label={t("history.securityInfo")} className="ml-auto" />
        </div>
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
  const parsedFilter = parseFilters(sp, timezone, "all");
  const agentScope = sp.agent === "main" || sp.agent === "subagent" ? sp.agent : undefined;
  const filter = {
    ...parsedFilter,
    ...(agentScope ? { agentScope } : {}),
    searchRangeKey: JSON.stringify({
      preset: parsedFilter.preset,
      timezone,
      from: sp.from ?? null,
      to: sp.to ?? null,
    }),
  };
  const searchQuery = decodeHistorySearchQueryToken(
    sp.search,
    process.env.AUTH_SECRET ?? "",
    userId,
  ) ?? "";
  const query = normalizeHistorySearchQuery(searchQuery);
  const isSearch = query.length > 0;
  const page = isSearch ? 0 : Math.max(0, (Number.parseInt(sp.page ?? "", 10) || 1) - 1);
  const result = isSearch
    ? await searchMyHistorySessions(
        userId,
        filter,
        query,
        sp.cursor,
        process.env.AUTH_SECRET ?? "",
        PAGE_SIZE,
      )
    : await getMyHistorySessions(userId, filter, page, PAGE_SIZE);
  const { enabled, sessions } = result;
  const totalSessions = "totalSessions" in result ? result.totalSessions : sessions.length;
  const nextSearchCursor = "nextCursor" in result ? result.nextCursor : null;

  if (!enabled) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <PageTitle title={t("history.title")} badgeLabel={navT("badge.preview")} />
        </div>
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
  const nextHref = isSearch
    ? nextSearchCursor
      ? historyHref(sp, { cursor: nextSearchCursor, page: null, session: null })
      : null
    : historyHref(sp, { page: String(page + 2) });
  // 기본 필터(전체 기간·전체 도구) 그대로인데 0건 = 수집 자체가 없는 것
  const noFilter = (!sp.period || sp.period === "all")
    && (!sp.provider || sp.provider === "all")
    && !agentScope
    && !isSearch;
  const listItems: HistoryListItem[] = sessions.map((session) => {
    const usage = usageByKey.get(session.key);
    return {
      key: session.key,
      href: historyHref(sp, { session: session.key }),
      providerKey: session.providerKey,
      providerLabel: providerLabel(session.providerKey),
      models: usage?.models ?? [],
      preview: session.preview || t("history.previewUnavailable"),
      turnLabel: t("history.turns", { count: session.turnCount }),
      totalTokens: usage ? totalUsageTokens(usage) : null,
      tokenUnit: t("tokens"),
      hosts: usage?.hosts ?? [],
      costLabel: usage
        ? formatCostForCoverage(fmtUsd(usage.costUsd), usage.costCoverage, costLabels)
        : null,
      noUsageLabel: t("history.noUsage"),
      latestTs: session.latestTs.toISOString(),
    };
  });

  return (
    <div className="space-y-6">
      <DashboardFilters
        providers={providers}
        defaultPeriod="all"
        showAllPreset
        resetKeys={["page", "session", "cursor"]}
        timezone={timezone}
        title={t("history.title")}
        statusBadge={{ status: "preview", label: navT("badge.preview") }}
        filterTrailing={<HistorySearchControls initialQuery={searchQuery} />}
        trailing={<HistorySecurityLink label={t("history.securityInfo")} />}
      />

      {totalSessions === 0 ? (
        <>
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Inbox />
              </EmptyMedia>
              <EmptyTitle>
                {isSearch
                  ? t("history.searchEmptyTitle")
                  : noFilter
                    ? t("history.emptyTitle")
                    : t("history.noMatchTitle")}
              </EmptyTitle>
              <EmptyDescription>
                {isSearch
                  ? t("history.searchEmptyDescription")
                  : noFilter
                    ? t("history.emptyDescription")
                    : t("history.noMatchDescription")}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
          {isSearch && nextHref ? (
            <div className="flex justify-end">
              <Button asChild variant="outline" size="sm">
                <Link href={nextHref}>{t("history.searchNext")}<ChevronRight className="size-4" /></Link>
              </Button>
            </div>
          ) : null}
        </>
      ) : (
        <>
          <HistorySessionList
            items={listItems}
            totalSessions={totalSessions}
            page={page + 1}
            prevHref={page > 0 ? prevHref : null}
            nextHref={isSearch ? nextHref : page + 1 < totalPages ? nextHref : null}
            locale={locale}
            timezone={timezone}
            labels={{
              total: isSearch ? t("history.searchResults") : t("history.listTotal", { count: totalSessions }),
              prev: t("history.prev"),
              next: isSearch ? t("history.searchNext") : t("history.next"),
              pageInfo: t("history.pageInfo", { page: page + 1, totalPages }),
            }}
            searchMode={isSearch}
          />
        </>
      )}
    </div>
  );
}
