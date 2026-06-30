import Link from "next/link";
import { LeaderboardBarChart } from "@/components/charts/leaderboard-bar-chart";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtCompact, fmtNum, fmtUsd } from "@/lib/format";
import { parseFilters, type DashboardSearchParams } from "@/lib/period";
import { getStorage } from "@/lib/storage";

export const dynamic = "force-dynamic";

export default async function LeaderboardPage({
  searchParams,
}: {
  searchParams: Promise<DashboardSearchParams & { scope?: string }>;
}) {
  const sp = await searchParams;
  const period = parseFilters(sp);
  const scope = sp.scope === "department" ? "department" : "user";
  const rows = await getStorage().getLeaderboard({ ...period, scope });
  const scopeLabel = scope === "department" ? "부서" : "개인";

  // scope 토글 시 기간·프로바이더 필터를 유지한 href 생성
  const hrefFor = (s: string) => {
    const next = new URLSearchParams();
    if (sp.period) next.set("period", sp.period);
    if (sp.provider) next.set("provider", sp.provider);
    next.set("scope", s);
    return `/leaderboard?${next.toString()}`;
  };

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">리더보드</h1>
          <p className="text-muted-foreground text-sm">{scopeLabel} 순위</p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant={scope === "user" ? "default" : "outline"} size="sm">
            <Link href={hrefFor("user")}>개인</Link>
          </Button>
          <Button asChild variant={scope === "department" ? "default" : "outline"} size="sm">
            <Link href={hrefFor("department")}>부서</Link>
          </Button>
        </div>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>비용 상위 {scopeLabel}</CardTitle>
        </CardHeader>
        <CardContent>
          {rows.length > 0 ? (
            <LeaderboardBarChart data={rows} />
          ) : (
            <EmptyState title="데이터가 없습니다" description={`선택한 기간·도구에 ${scopeLabel} 사용량이 없습니다.`} />
          )}
        </CardContent>
      </Card>

      {rows.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>{scopeLabel} 순위</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">#</TableHead>
                  <TableHead>{scopeLabel}</TableHead>
                  <TableHead className="text-right">세션</TableHead>
                  <TableHead className="text-right">토큰</TableHead>
                  <TableHead className="text-right">비용</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r, i) => (
                  <TableRow key={r.key}>
                    <TableCell className="text-muted-foreground">{i + 1}</TableCell>
                    <TableCell className="font-medium">{r.label}</TableCell>
                    <TableCell className="text-right">{fmtNum(r.sessions)}</TableCell>
                    <TableCell className="text-right">{fmtCompact(r.totalTokens)}</TableCell>
                    <TableCell className="text-right">{fmtUsd(r.costUsd)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
