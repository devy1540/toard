import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { Activity, ArrowUpDown, DollarSign, Inbox } from "lucide-react";
import { UsageAreaChart } from "@/components/charts/usage-area-chart";
import { AutoRefresh } from "@/components/dashboard/auto-refresh";
import { DashboardFilters } from "@/components/dashboard/dashboard-filters";
import { MetricToggle, type ChartMetric } from "@/components/dashboard/metric-toggle";
import { PageHeader } from "@/components/dashboard/page-header";
import { PricingNotice } from "@/components/dashboard/pricing-notice";
import { StatCard } from "@/components/dashboard/stat-card";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getCurrentUserId } from "@/lib/current-user";
import { fmtCompact, fmtNum, fmtUsd } from "@/lib/format";
import { formatModelName } from "@/lib/model-names";
import { fillSeriesGaps, parseFilters, previousPeriod, type DashboardSearchParams } from "@/lib/period";
import { getEnabledProviders } from "@/lib/providers";
import { getStorage } from "@/lib/storage";
import { getActiveTokenMeta } from "@/lib/tokens";

export const dynamic = "force-dynamic";

/** 랜딩 = 내 사용량 (역할 축 개편 — 멤버가 매일 보는 건 자기 데이터). 전체 현황은 /org. */
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
  const period = parseFilters(sp);
  const metric: ChartMetric = sp.metric === "cost" ? "cost" : "tokens";
  const storage = getStorage();
  const [{ overview, daily, byModel, byHost }, prevOverview, providers, tokenMeta] = await Promise.all([
    storage.getUserUsage(userId, period),
    storage.getOverview({ ...previousPeriod(period), userId }),
    getEnabledProviders(),
    getActiveTokenMeta(userId),
  ]);
  // 미설치 추정: 토큰이 없거나 한 번도 수신된 적 없음 → 빈 상태에서 설치 CTA 노출
  const notInstalled = !tokenMeta || !tokenMeta.lastUsedAt;

  // 직전 동일 길이 기간 대비 비용 증감 — 비교 기준(0)이 없으면 힌트 생략.
  // 직전 기간이 극소량이면 수만 % 로 폭주해 오히려 노이즈 — ±999% 로 클램프해 표시.
  const rawDelta =
    prevOverview.totalCostUsd > 0
      ? Math.round(((overview.totalCostUsd - prevOverview.totalCostUsd) / prevOverview.totalCostUsd) * 100)
      : null;
  const costDelta = rawDelta == null ? null : Math.max(-999, Math.min(999, rawDelta));
  const deltaPct =
    costDelta == null ? null : `${rawDelta !== costDelta ? ">" : ""}${costDelta >= 0 ? "+" : ""}${costDelta}%`;
  // 기기 라벨이 전부 없으면(전부 null) 섹션 자체가 정보 0 — 숨긴다
  const hasNamedHost = byHost.some((h) => h.host != null);

  return (
    <div className="space-y-6">
      <PageHeader title={t("myUsageTitle")} description={t("myUsageDescription")} actions={<AutoRefresh />} />

      <DashboardFilters providers={providers} />

      <PricingNotice />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label={t(`costLabel.${period.preset}`)}
          value={fmtUsd(overview.totalCostUsd)}
          hint={
            deltaPct != null
              ? t(period.preset === "today" ? "costDeltaToday" : "costDeltaPrev", { pct: deltaPct })
              : undefined
          }
          icon={<DollarSign className="size-4" />}
        />
        <StatCard
          label={t("statSessions")}
          value={fmtNum(overview.totalSessions)}
          hint={t("sessionsHint")}
          icon={<Activity className="size-4" />}
        />
        <StatCard
          label={t("statTokens")}
          value={fmtCompact(overview.totalInputTokens + overview.totalOutputTokens)}
          hint={t("tokensHint", {
            in: fmtCompact(overview.totalInputTokens),
            out: fmtCompact(overview.totalOutputTokens),
            cache: fmtCompact(overview.totalCacheReadTokens + overview.totalCacheCreationTokens),
          })}
          icon={<ArrowUpDown className="size-4" />}
        />
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>{t(period.bucket === "hour" ? "hourlyUsage" : "dailyUsage")}</CardTitle>
          <MetricToggle value={metric} />
        </CardHeader>
        <CardContent>
          {daily.length > 0 ? (
            <UsageAreaChart data={fillSeriesGaps(daily, period)} metric={metric} bucket={period.bucket} />
          ) : notInstalled ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Inbox />
                </EmptyMedia>
                <EmptyTitle>{t("noCollectedUsageTitle")}</EmptyTitle>
                <EmptyDescription>
                  {t("noCollectedUsageDescription")}
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button asChild size="sm">
                  <Link href="/settings?tab=install">{t("installShim")}</Link>
                </Button>
              </EmptyContent>
            </Empty>
          ) : (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Inbox />
                </EmptyMedia>
                <EmptyTitle>{t("noDataTitle")}</EmptyTitle>
                <EmptyDescription>{t("noMyUsageDescription")}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("byModelTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          {byModel.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("model")}</TableHead>
                  <TableHead className="text-right">{t("sessions")}</TableHead>
                  <TableHead className="text-right">{t("tokens")}</TableHead>
                  <TableHead className="text-right">{t("cost")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {byModel.map((m) => (
                  <TableRow key={m.model}>
                    <TableCell className="font-medium">
                      {formatModelName(m.model) ?? m.model}
                      {formatModelName(m.model) && (
                        <div className="text-muted-foreground font-mono text-xs font-normal">{m.model}</div>
                      )}
                    </TableCell>
                    <TableCell className="text-right">{fmtNum(m.sessions)}</TableCell>
                    <TableCell className="text-right">{fmtCompact(m.totalTokens)}</TableCell>
                    <TableCell className="text-right">{fmtUsd(m.costUsd)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Inbox />
                </EmptyMedia>
                <EmptyTitle>{t("noModelDataTitle")}</EmptyTitle>
              </EmptyHeader>
            </Empty>
          )}
        </CardContent>
      </Card>

      {hasNamedHost && (
        <Card>
          <CardHeader>
            <CardTitle>{t("byHostTitle")}</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("computer")}</TableHead>
                  <TableHead className="text-right">{t("sessions")}</TableHead>
                  <TableHead className="text-right">{t("tokens")}</TableHead>
                  <TableHead className="text-right">{t("cost")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {byHost.map((h) => (
                  <TableRow key={h.host ?? "__unknown__"}>
                    <TableCell className={h.host ? "font-medium" : "text-muted-foreground"}>
                      {h.host ?? t("unknownHost")}
                    </TableCell>
                    <TableCell className="text-right">{fmtNum(h.sessions)}</TableCell>
                    <TableCell className="text-right">{fmtCompact(h.totalTokens)}</TableCell>
                    <TableCell className="text-right">{fmtUsd(h.costUsd)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
