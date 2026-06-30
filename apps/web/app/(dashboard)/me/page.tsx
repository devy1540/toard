import { Activity, ArrowUpDown, DollarSign } from "lucide-react";
import { UsageAreaChart } from "@/components/charts/usage-area-chart";
import { StatCard } from "@/components/dashboard/stat-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getCurrentUserId } from "@/lib/current-user";
import { fmtCompact, fmtNum, fmtUsd } from "@/lib/format";
import { parseFilters, type DashboardSearchParams } from "@/lib/period";
import { getStorage } from "@/lib/storage";

export const dynamic = "force-dynamic";

export default async function MyPage({
  searchParams,
}: {
  searchParams: Promise<DashboardSearchParams>;
}) {
  const userId = await getCurrentUserId();
  if (!userId) {
    return (
      <EmptyState title="로그인이 필요합니다" description="사용량을 보려면 로그인하세요." />
    );
  }

  const period = parseFilters(await searchParams);
  const { overview, daily, byModel } = await getStorage().getUserUsage(userId, period);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">마이페이지</h1>
        <p className="text-muted-foreground text-sm">내 사용량</p>
      </header>

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
          ) : (
            <EmptyState title="데이터가 없습니다" description="선택한 기간·도구에 내 사용량이 없습니다." />
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
            <EmptyState title="모델 데이터 없음" />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
