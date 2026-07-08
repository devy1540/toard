import type { ReactNode } from "react";
import { TrendingDown, TrendingUp } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * 증감 배지 — 모든 지표에서 같은 시각 규칙을 쓴다.
 * 증가=빨강, 감소=초록.
 */
export interface StatDelta {
  /** 표시용 문자열 (예: "+12%", "-92%", ">+999%") */
  pct: string;
  direction: "up" | "down";
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

export function DeltaBadge({ delta }: { delta: StatDelta }) {
  const DeltaIcon = delta.direction === "down" ? TrendingDown : TrendingUp;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 rounded-full px-1.5 py-px font-medium",
        delta.direction === "down"
          ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
          : "bg-red-500/10 text-red-600 dark:text-red-400",
      )}
    >
      <DeltaIcon className="size-3" />
      {delta.pct}
    </span>
  );
}

export function StatCard({
  label,
  value,
  hint,
  icon,
  delta,
  spark,
}: {
  label: string;
  value: string;
  hint?: string;
  icon?: ReactNode;
  delta?: StatDelta | null;
  spark?: number[];
}) {
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
            <span className="text-chart-1">
              <Sparkline values={spark} />
            </span>
          ) : null}
        </div>
        {delta || hint ? (
          <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
            {delta ? <DeltaBadge delta={delta} /> : null}
            {hint ? <span className="text-muted-foreground">{hint}</span> : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
