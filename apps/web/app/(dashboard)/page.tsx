import { getTranslations } from "next-intl/server";
import { cookies } from "next/headers";
import { Inbox } from "lucide-react";
import { AutoRefresh } from "@/components/dashboard/auto-refresh";
import { ClassicView } from "@/components/dashboard/classic-view";
import { DashboardFilters } from "@/components/dashboard/dashboard-filters";
import type { ChartMetric } from "@/components/dashboard/metric-toggle";
import { PricingNotice } from "@/components/dashboard/pricing-notice";
import { StatsView } from "@/components/dashboard/stats-view";
import { ViewToggle } from "@/components/dashboard/view-toggle";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { getCurrentUserId } from "@/lib/current-user";
import { DEFAULT_VIEW, VIEW_COOKIE, isDashboardView, type DashboardView } from "@/lib/dashboard-view";
import { parseFilters, type DashboardSearchParams } from "@/lib/period";
import { getEnabledProviders } from "@/lib/providers";
import { getViewerTimezone } from "@/lib/viewer-time";

export const dynamic = "force-dynamic";

/** 랜딩 = 내 사용량 (역할 축 개편 — 멤버가 매일 보는 건 자기 데이터). 전체 현황은 /org.
 *  뷰(클래식/스탯)는 쿠키 기반 개인 설정 — 툴바 토글·설정의 기본 뷰가 같은 쿠키를 쓴다. */
export default async function MyUsagePage({
  searchParams,
}: {
  searchParams: Promise<DashboardSearchParams>;
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
          <EmptyTitle>{t("loginRequiredTitle")}</EmptyTitle>
          <EmptyDescription>{t("loginRequiredDescription")}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const sp = await searchParams;
  const period = parseFilters(sp, await getViewerTimezone());
  const metric: ChartMetric = sp.metric === "cost" ? "cost" : "tokens";
  const providers = await getEnabledProviders();
  const viewCookie = (await cookies()).get(VIEW_COOKIE)?.value;
  const view: DashboardView = isDashboardView(viewCookie) ? viewCookie : DEFAULT_VIEW;

  return (
    <div className="space-y-6">
      <DashboardFilters
        providers={providers}
        timezone={period.timezone}
        title={t("myUsageTitle")}
        trailing={
          <>
            <ViewToggle view={view} />
            <AutoRefresh />
          </>
        }
      />

      <PricingNotice />

      {view === "stats" ? (
        <StatsView userId={userId} period={period} metric={metric} />
      ) : (
        <ClassicView userId={userId} period={period} metric={metric} />
      )}
    </div>
  );
}
