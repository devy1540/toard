import { Activity, ArrowUpDown, DollarSign, Users } from "lucide-react";
import { UsageAreaChart } from "@/components/charts/usage-area-chart";
import { StatCard } from "@/components/dashboard/stat-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtCompact, fmtNum, fmtUsd } from "@/lib/format";
import { parseFilters, type DashboardSearchParams } from "@/lib/period";
import { getStorage } from "@/lib/storage";

export const dynamic = "force-dynamic";

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<DashboardSearchParams>;
}) {
  const period = parseFilters(await searchParams);
  const storage = getStorage();
  const [overview, daily, topUsers] = await Promise.all([
    storage.getOverview(period),
    storage.getDailyTimeseries(period),
    storage.getLeaderboard({ ...period, scope: "user" }),
  ]);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">개요</h1>
        <p className="text-muted-foreground text-sm">조직 전체 사용량</p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="총 비용" value={fmtUsd(overview.totalCostUsd)} icon={<DollarSign className="size-4" />} />
        <StatCard label="세션" value={fmtNum(overview.totalSessions)} icon={<Activity className="size-4" />} />
        <StatCard label="활성 사용자" value={fmtNum(overview.activeUsers)} icon={<Users className="size-4" />} />
        <StatCard
          label="총 토큰"
          value={fmtCompact(overview.totalInputTokens + overview.totalOutputTokens)}
          hint={`입력 ${fmtCompact(overview.totalInputTokens)} · 출력 ${fmtCompact(overview.totalOutputTokens)}`}
          icon={<ArrowUpDown className="size-4" />}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>일별 비용</CardTitle>
          </CardHeader>
          <CardContent>
            {daily.length > 0 ? (
              <UsageAreaChart data={daily} metric="cost" />
            ) : (
              <EmptyState title="데이터가 없습니다" description="선택한 기간·도구에 수집된 사용량이 없습니다." />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>상위 사용자</CardTitle>
          </CardHeader>
          <CardContent>
            {topUsers.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>사용자</TableHead>
                    <TableHead className="text-right">비용</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {topUsers.slice(0, 6).map((r) => (
                    <TableRow key={r.key}>
                      <TableCell className="font-medium">{r.label}</TableCell>
                      <TableCell className="text-right">{fmtUsd(r.costUsd)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <EmptyState title="사용자 없음" />
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
