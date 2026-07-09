import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { Activity, ArrowUpDown, DollarSign, Inbox } from "lucide-react";
import { UsageAreaChart } from "@/components/charts/usage-area-chart";
import { MetricToggle, type ChartMetric } from "@/components/dashboard/metric-toggle";
import { StatCard } from "@/components/dashboard/stat-card";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { fmtCompact, fmtNum, fmtUsd } from "@/lib/format";
import { formatModelName } from "@/lib/model-names";
import { fillSeriesGaps, previousPeriod, type DashboardPeriod } from "@/lib/period";
import { pctDelta } from "@/lib/stat-delta";
import { getStorage } from "@/lib/storage";
import { getActiveTokenMeta } from "@/lib/tokens";

/** 비중 바 — 분모가 0(가격 미동기화 등)이면 토큰 기준으로 폴백. */
function shareOf(cost: number, tokens: number, costSum: number, tokenSum: number): number {
  if (costSum > 0) return cost / costSum;
  if (tokenSum > 0) return tokens / tokenSum;
  return 0;
}

function ShareBar({ share }: { share: number }) {
  const pct = share > 0 ? Math.max(2, Math.round(share * 100)) : 0;
  return (
    <div className="bg-muted h-1.5 overflow-hidden rounded-full">
      <div className="bg-chart-1 h-full rounded-full" style={{ width: `${pct}%` }} />
    </div>
  );
}

/** 분해 카드 공통 행 — 이름 + 비용 + 보조 텍스트 + 비중 바 (모델별·기기별이 공유) */
function BreakdownRow({
  name,
  hoverTitle,
  muted = false,
  cost,
  sub,
  share,
}: {
  name: string;
  hoverTitle?: string;
  muted?: boolean;
  cost: string;
  sub: string;
  share: number;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className={muted ? "text-muted-foreground truncate" : "truncate font-medium"} title={hoverTitle}>
          {name}
        </span>
        <span className="shrink-0 font-medium">{cost}</span>
      </div>
      <div className="text-muted-foreground mt-0.5 text-xs">{sub}</div>
      <div className="mt-1.5">
        <ShareBar share={share} />
      </div>
    </div>
  );
}

/** 사이드 리스트가 세로로 길어지지 않게 상위 N개만 — 나머지는 개수로 요약 */
const MODELS_SHOWN = 6;

function usageTitleKey(bucket: DashboardPeriod["bucket"]): "dailyUsage" | "hourlyUsage" | "usage30m" | "usage15m" {
  if (bucket === "day") return "dailyUsage";
  if (bucket === "hour") return "hourlyUsage";
  if (bucket === "30m") return "usage30m";
  return "usage15m";
}

/** 클래식 뷰 — 스탯카드·면적 차트·분해 카드 (기존 대시보드 그대로, toard.view=classic). */
export async function ClassicView({
  userId,
  period,
  metric,
}: {
  userId: string;
  period: DashboardPeriod;
  metric: ChartMetric;
}) {
  const t = await getTranslations("dashboard");
  const storage = getStorage();
  const tokenMetaPromise = getActiveTokenMeta(userId);
  const { overview, daily, byModel, byHost } = await storage.getUserUsage(userId, period);
  const prevOverview = await storage.getOverview({ ...previousPeriod(period), userId });
  const tokenMeta = await tokenMetaPromise;
  // 미설치 추정: 토큰이 없거나 한 번도 수신된 적 없음 → 빈 상태에서 설치 CTA 노출
  const notInstalled = !tokenMeta || !tokenMeta.lastUsedAt;

  // 차트·스파크라인이 같은 시리즈를 공유 — 추가 조회 없음
  const series = fillSeriesGaps(daily, period);
  const spark = {
    cost: series.map((d) => d.costUsd),
    sessions: series.map((d) => d.sessions),
    // 총 소모 토큰(입력+출력+캐시) — 토큰 카드와 동일 정의
    tokens: series.map((d) => d.inputTokens + d.outputTokens + d.cacheReadTokens + d.cacheCreationTokens),
  };

  const costDelta = pctDelta(overview.totalCostUsd, prevOverview.totalCostUsd);
  const sessionsDelta = pctDelta(overview.totalSessions, prevOverview.totalSessions);
  const tokensDelta = pctDelta(
    overview.totalInputTokens +
      overview.totalOutputTokens +
      overview.totalCacheReadTokens +
      overview.totalCacheCreationTokens,
    prevOverview.totalInputTokens +
      prevOverview.totalOutputTokens +
      prevOverview.totalCacheReadTokens +
      prevOverview.totalCacheCreationTokens,
  );

  const modelCostSum = byModel.reduce((s, m) => s + m.costUsd, 0);
  const modelTokenSum = byModel.reduce((s, m) => s + m.totalTokens, 0);
  const hostCostSum = byHost.reduce((s, h) => s + h.costUsd, 0);
  const hostTokenSum = byHost.reduce((s, h) => s + h.totalTokens, 0);
  // 기기 라벨이 전부 없으면(전부 null) 섹션 자체가 정보 0 — 숨긴다
  const hasNamedHost = byHost.some((h) => h.host != null);

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          label={t(`costLabel.${period.preset}`)}
          value={fmtUsd(overview.totalCostUsd)}
          delta={costDelta}
          hint={costDelta ? t(period.preset === "today" ? "vsPrevToday" : "vsPrevPeriod") : undefined}
          spark={spark.cost}
          icon={<DollarSign className="size-4" />}
        />
        <StatCard
          label={t("statSessions")}
          value={fmtNum(overview.totalSessions)}
          delta={sessionsDelta}
          hint={t("sessionsHint")}
          spark={spark.sessions}
          icon={<Activity className="size-4" />}
        />
        <StatCard
          label={t("statTokens")}
          value={fmtCompact(
            overview.totalInputTokens +
              overview.totalOutputTokens +
              overview.totalCacheReadTokens +
              overview.totalCacheCreationTokens,
          )}
          delta={tokensDelta}
          hint={t("tokensHint", {
            in: fmtCompact(overview.totalInputTokens),
            out: fmtCompact(overview.totalOutputTokens),
            cache: fmtCompact(overview.totalCacheReadTokens + overview.totalCacheCreationTokens),
          })}
          spark={spark.tokens}
          icon={<ArrowUpDown className="size-4" />}
        />
      </div>

      {/* 시계열은 가로 해상도가 생명 — 차트가 풀폭 히어로, 분해(모델·기기)는 아래 반반 */}
      <Card className="min-w-0">
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle>{t(usageTitleKey(period.bucket))}</CardTitle>
          <MetricToggle value={metric} />
        </CardHeader>
        <CardContent className="min-w-0">
          {daily.length > 0 ? (
            <UsageAreaChart data={series} metric={metric} bucket={period.bucket} markNow={period.preset === "today"} />
          ) : notInstalled ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Inbox />
                </EmptyMedia>
                <EmptyTitle>{t("noCollectedUsageTitle")}</EmptyTitle>
                <EmptyDescription>{t("noCollectedUsageDescription")}</EmptyDescription>
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

      {/* 분해 카드 반반 — 같은 층위(분해)라 대칭 배치, 기기별이 숨으면 모델별이 풀폭 */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className={hasNamedHost ? undefined : "lg:col-span-2"}>
          <CardHeader>
            <CardTitle>{t("byModelTitle")}</CardTitle>
          </CardHeader>
          <CardContent>
            {byModel.length > 0 ? (
              <div className="space-y-4">
                {byModel.slice(0, MODELS_SHOWN).map((m) => (
                  <BreakdownRow
                    key={m.model}
                    name={formatModelName(m.model) ?? m.model}
                    hoverTitle={m.model}
                    cost={fmtUsd(m.costUsd)}
                    sub={t("breakdownSub", { tokens: fmtCompact(m.totalTokens), sessions: fmtNum(m.sessions) })}
                    share={shareOf(m.costUsd, m.totalTokens, modelCostSum, modelTokenSum)}
                  />
                ))}
                {byModel.length > MODELS_SHOWN && (
                  <div className="text-muted-foreground text-xs">
                    {t("moreModels", { n: byModel.length - MODELS_SHOWN })}
                  </div>
                )}
              </div>
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
          <Card className="min-w-0">
            <CardHeader>
              <CardTitle>{t("byHostTitle")}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {byHost.map((h) => (
                  <BreakdownRow
                    key={h.host ?? "__unknown__"}
                    name={h.host ?? t("unknownHost")}
                    muted={h.host == null}
                    cost={fmtUsd(h.costUsd)}
                    sub={t("breakdownSub", { tokens: fmtCompact(h.totalTokens), sessions: fmtNum(h.sessions) })}
                    share={shareOf(h.costUsd, h.totalTokens, hostCostSum, hostTokenSum)}
                  />
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </>
  );
}
