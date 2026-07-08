import type { ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight, TrendingDown, TrendingUp } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * 증감 배지 — tone 은 지표의 가치 방향을 뜻한다.
 *  - colored: 방향에 좋고 나쁨이 있는 지표(비용: 감소=초록/증가=빨강)
 *  - directional: 좋고 나쁨보다 변화 방향을 색으로 보여주는 지표(증가=초록/감소=빨강)
 *  - neutral: 의미상 색 판단이 애매한 지표 — 회색으로 방향만
 */
export interface StatDelta {
  /** 표시용 문자열 (예: "+12%", "-92%", ">+999%") */
  pct: string;
  direction: "up" | "down";
  tone: "colored" | "directional" | "neutral";
}

/** 기간 내 추이 미니 스파크라인 — 서버 렌더 순수 SVG (2점 미만이면 미표시). */
function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const span = Math.max(...values) - min || 1;
  const W = 56;
  const H = 20;
  const P = 2;
  const points = values
    .map((v, i) => {
      const x = P + (i * (W - P * 2)) / (values.length - 1);
      const y = P + (1 - (v - min) / span) * (H - P * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden className="shrink-0">
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function StatCard({
  label,
  value,
  hint,
  icon,
  delta,
  spark,
  sparkAccent = false,
}: {
  label: string;
  value: string;
  hint?: string;
  icon?: ReactNode;
  delta?: StatDelta | null;
  spark?: number[];
  /** 스파크라인을 차트 색(chart-1)으로 — 페이지 대표 지표(비용)용 */
  sparkAccent?: boolean;
}) {
  const DeltaIcon = delta
    ? delta.tone === "colored"
      ? delta.direction === "down"
        ? TrendingDown
        : TrendingUp
      : delta.direction === "down"
        ? ArrowDownRight
        : ArrowUpRight
    : null;
  return (
    <Card className="min-w-0 gap-2 py-4">
      <CardHeader className="px-4">
        <CardTitle className="text-muted-foreground flex min-w-0 items-center gap-2 text-sm font-normal">
          {icon}
          <span className="truncate">{label}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <div className="min-w-0 text-2xl font-bold tracking-tight tabular-nums">{value}</div>
          {spark ? (
            <span className={sparkAccent ? "text-chart-1" : "text-muted-foreground/50"}>
              <Sparkline values={spark} />
            </span>
          ) : null}
        </div>
        {delta || hint ? (
          <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
            {delta && DeltaIcon ? (
              <span
                className={cn(
                  "inline-flex items-center gap-0.5 rounded-full px-1.5 py-px font-medium",
                  delta.tone === "neutral" && "bg-muted text-muted-foreground",
                  delta.tone === "colored" &&
                    (delta.direction === "down"
                      ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                      : "bg-red-500/10 text-red-600 dark:text-red-400"),
                  delta.tone === "directional" &&
                    (delta.direction === "up"
                      ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                      : "bg-red-500/10 text-red-600 dark:text-red-400"),
                )}
              >
                <DeltaIcon className="size-3" />
                {delta.pct}
              </span>
            ) : null}
            {hint ? <span className="text-muted-foreground">{hint}</span> : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
