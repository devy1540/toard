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
  const userId = await getCurrentUserId();
  if (!userId) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Inbox />
          </EmptyMedia>
          <EmptyTitle>로그인이 필요합니다</EmptyTitle>
          <EmptyDescription>사용량을 보려면 로그인하세요.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const period = parseFilters(await searchParams);
  const [{ overview, daily, byModel }, providers, tokenMeta] = await Promise.all([
    getStorage().getUserUsage(userId, period),
    getEnabledProviders(),
    getActiveTokenMeta(userId),
  ]);
  // 미설치 추정: 토큰이 없거나 한 번도 수신된 적 없음 → 빈 상태에서 설치 CTA 노출
  const notInstalled = !tokenMeta || !tokenMeta.lastUsedAt;

  return (
    <div className="space-y-6">
      <PageHeader title="내 사용량" description="내 AI 도구 사용량·비용" actions={<AutoRefresh />} />

      <DashboardFilters providers={providers} />

      <PricingNotice />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="내 비용" value={fmtUsd(overview.totalCostUsd)} icon={<DollarSign className="size-4" />} />
        <StatCard label="내 세션" value={fmtNum(overview.totalSessions)} icon={<Activity className="size-4" />} />
        <StatCard
          label="내 토큰"
          value={fmtCompact(overview.totalInputTokens + overview.totalOutputTokens)}
          icon={<ArrowUpDown className="size-4" />}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>일별 토큰</CardTitle>
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
                <EmptyTitle>아직 수집된 사용량이 없습니다</EmptyTitle>
                <EmptyDescription>
                  shim 을 설치하면 claude/codex 사용량이 자동으로 수집됩니다.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button asChild size="sm">
                  <Link href="/settings?tab=install">shim 설치하기</Link>
                </Button>
              </EmptyContent>
            </Empty>
          ) : (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Inbox />
                </EmptyMedia>
                <EmptyTitle>데이터가 없습니다</EmptyTitle>
                <EmptyDescription>선택한 기간·도구에 내 사용량이 없습니다.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>모델별 분해</CardTitle>
        </CardHeader>
        <CardContent>
          {byModel.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>모델</TableHead>
                  <TableHead className="text-right">세션</TableHead>
                  <TableHead className="text-right">토큰</TableHead>
                  <TableHead className="text-right">비용</TableHead>
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
                <EmptyTitle>모델 데이터 없음</EmptyTitle>
              </EmptyHeader>
            </Empty>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
