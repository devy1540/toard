import { getLocale, getTranslations } from "next-intl/server";
import Link from "next/link";
import { Inbox, Lock } from "lucide-react";
import type { SessionUsageSummary } from "@toard/core";
import { DashboardFilters } from "@/components/dashboard/dashboard-filters";
import { FeatureStatusBadge } from "@/components/dashboard/feature-status-badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { getCurrentUserId } from "@/lib/current-user";
import { getE2eeContentStatus } from "@/lib/e2ee-history";
import { fmtUsd } from "@/lib/format";
import { parseFilters, type DashboardSearchParams } from "@/lib/period";
import { formatCostForCoverage } from "@/lib/pricing";
import { getMyHistorySessions } from "@/lib/prompt-history";
import { getEnabledProviders } from "@/lib/providers";
import { getStorage } from "@/lib/storage";
import { getViewerTimezone } from "@/lib/viewer-time";
import { SessionDetail } from "./session-detail";
import { E2eeHistoryClient } from "./e2ee-history-client";
import { HistorySessionList } from "./history-session-list";
import type { HistoryListItem } from "./history-list-view";

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
}

/** 현재 필터를 보존한 /history URL — overrides 로 일부만 바꾼다(null = 제거). */
function historyHref(sp: HistorySearchParams, overrides: Record<string, string | null>): string {
  const p = new URLSearchParams();
  for (const k of ["period", "provider", "from", "to", "page", "session", "source"] as const) {
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
  const e2eeAllowed = (process.env.AUTH_MODE ?? "oauth") !== "open";
  const providers = await getEnabledProviders();
  const providerLabel = (key: string): string => providers.find((p) => p.key === key)?.label ?? key;
  const locale = await getLocale();
  const timezone = await getViewerTimezone();
  let e2eeActive = false;

  if (e2eeAllowed) {
    const contentStatus = await getE2eeContentStatus(userId);
    e2eeActive = contentStatus.state === "active";
    if (contentStatus.state === "active" && sp.source !== "managed") {
      return (
        <div className="space-y-4">
          <div className="flex justify-end">
            <Button asChild size="sm" variant="outline">
              <Link href={historyHref(sp, {
                source: "managed",
                session: null,
                page: null,
              })}>
                {t("history.managedSourceLabel")}
              </Link>
            </Button>
          </div>
          <E2eeHistoryClient
            providers={providers}
            timezone={timezone}
            previewBadgeLabel={navT("badge.preview")}
          />
        </div>
      );
    }
  }

  const e2eeSourceControl = e2eeActive ? (
    <Button asChild size="sm" variant="outline">
      <Link href={historyHref(sp, {
        source: "e2ee",
        session: null,
        page: null,
      })}>
        {t("history.e2eeSourceLabel")}
      </Link>
    </Button>
  ) : null;

  // ── 상세 뷰 ──
  if (sp.session) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between gap-3">
          <PageTitle title={t("history.title")} badgeLabel={navT("badge.preview")} />
          {e2eeSourceControl}
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
  const filter = parseFilters(sp, timezone, "all");
  const page = Math.max(0, (Number.parseInt(sp.page ?? "", 10) || 1) - 1);
  const {
    enabled,
    hasManagedContent,
    hasLegacyContent,
    sessions,
    totalSessions,
  } = await getMyHistorySessions(
    userId,
    filter,
    page,
    PAGE_SIZE,
  );

  if (!enabled) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between gap-3">
          <PageTitle title={t("history.title")} badgeLabel={navT("badge.preview")} />
          {e2eeSourceControl}
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
  const nextHref = historyHref(sp, { page: String(page + 2) });
  // 기본 필터(전체 기간·전체 도구) 그대로인데 0건 = 수집 자체가 없는 것
  const noFilter = (!sp.period || sp.period === "all") && (!sp.provider || sp.provider === "all");
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
      {e2eeSourceControl ? (
        <div className="flex justify-end">{e2eeSourceControl}</div>
      ) : null}
      <DashboardFilters
        providers={providers}
        defaultPeriod="all"
        showAllPreset
        resetKeys={["page", "session"]}
        timezone={timezone}
        title={t("history.title")}
        statusBadge={{ status: "preview", label: navT("badge.preview") }}
        trailing={
          <div className="text-muted-foreground flex max-w-xl items-start gap-1.5 text-xs">
            <Lock className="size-3.5" />
            <span>
              {t("history.privacyNote")}
              {hasManagedContent ? ` ${t("history.managedPrivacyNote")}` : ""}
              {hasLegacyContent ? ` ${t("history.legacyPrivacyNote")}` : ""}
            </span>
          </div>
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
          <HistorySessionList
            items={listItems}
            totalSessions={totalSessions}
            page={page + 1}
            prevHref={page > 0 ? prevHref : null}
            nextHref={page + 1 < totalPages ? nextHref : null}
            locale={locale}
            timezone={timezone}
            labels={{
              total: t("history.listTotal", { count: totalSessions }),
              prev: t("history.prev"),
              next: t("history.next"),
              pageInfo: t("history.pageInfo", { page: page + 1, totalPages }),
            }}
          />
        </>
      )}
    </div>
  );
}
