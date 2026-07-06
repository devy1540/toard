import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { Activity, ArrowUpDown, DollarSign, Inbox } from "lucide-react";
import { UsageAreaChart } from "@/components/charts/usage-area-chart";
import { AutoRefresh } from "@/components/dashboard/auto-refresh";
import { DashboardFilters } from "@/components/dashboard/dashboard-filters";
import { PageHeader } from "@/components/dashboard/page-header";
import { PricingNotice } from "@/components/dashboard/pricing-notice";
import { StatCard } from "@/components/dashboard/stat-card";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getCurrentUserId } from "@/lib/current-user";
import { fmtCompact, fmtNum, fmtUsd } from "@/lib/format";
import { parseFilters, type DashboardSearchParams } from "@/lib/period";
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

  const period = parseFilters(await searchParams);
  const [{ overview, daily, byModel, byHost }, providers, tokenMeta] = await Promise.all([
    getStorage().getUserUsage(userId, period),
    getEnabledProviders(),
    getActiveTokenMeta(userId),
  ]);
  // 미설치 추정: 토큰이 없거나 한 번도 수신된 적 없음 → 빈 상태에서 설치 CTA 노출
  const notInstalled = !tokenMeta || !tokenMeta.lastUsedAt;

  return (
    <div className="space-y-6">
      <PageHeader title={t("myUsageTitle")} description={t("myUsageDescription")} actions={<AutoRefresh />} />

      <DashboardFilters providers={providers} />

      <PricingNotice />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label={t("myCost")} value={fmtUsd(overview.totalCostUsd)} icon={<DollarSign className="size-4" />} />
        <StatCard label={t("mySessions")} value={fmtNum(overview.totalSessions)} icon={<Activity className="size-4" />} />
        <StatCard
          label={t("myTokens")}
          value={fmtCompact(overview.totalInputTokens + overview.totalOutputTokens)}
          icon={<ArrowUpDown className="size-4" />}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("dailyTokens")}</CardTitle>
        </CardHeader>
        <CardContent>
          {daily.length > 0 ? (
            <UsageAreaChart data={daily} metric="tokens" />
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
                    <TableCell className="font-medium">{m.model}</TableCell>
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

      {byHost.length > 0 && (
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
