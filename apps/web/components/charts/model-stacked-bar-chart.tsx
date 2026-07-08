"use client";

import { useTranslations } from "next-intl";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { fmtCompact } from "@/lib/format";

const tooltipStyle = {
  background: "var(--color-popover)",
  border: "1px solid var(--color-border)",
  borderRadius: 8,
  fontSize: 12,
  color: "var(--color-popover-foreground)",
} as const;

export interface StackedSeries {
  /** rows 의 데이터 키 (모델 id 또는 '__other__') */
  key: string;
  /** 범례·툴팁 표시명 */
  label: string;
  /** CSS 색 (var()/color-mix 허용) */
  color: string;
}

/**
 * 버킷×모델 스택 막대 — 총량 추이와 모델 구성을 한 자리에서 (스탯 뷰).
 * 피벗(rows)·시리즈 선정은 서버가 담당하고 여기는 렌더만 한다.
 */
export function ModelStackedBarChart({
  rows,
  series,
  metric,
}: {
  rows: Array<Record<string, number | string>>;
  series: StackedSeries[];
  metric: "cost" | "tokens";
}) {
  const t = useTranslations("dashboard");
  const isCost = metric === "cost";
  const labelOf = new Map(series.map((s) => [s.key, s.label]));

  return (
    <ResponsiveContainer width="100%" height={240}>
      <BarChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--color-border)" />
        <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} fontSize={12} stroke="var(--color-muted-foreground)" />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={52}
          fontSize={12}
          stroke="var(--color-muted-foreground)"
          tickFormatter={(v: number) => (isCost ? `$${fmtCompact(v)}` : fmtCompact(v))}
        />
        <Tooltip
          contentStyle={tooltipStyle}
          cursor={{ fill: "var(--color-muted)", opacity: 0.4 }}
          formatter={(v: number, key: string) => [
            isCost ? `$${Number(v).toFixed(2)}` : Number(v).toLocaleString(),
            labelOf.get(key) ?? key,
          ]}
        />
        {series.map((s, i) => (
          <Bar
            key={s.key}
            dataKey={s.key}
            stackId="usage"
            fill={s.color}
            isAnimationActive={false}
            // 스택 맨 위 시리즈만 모서리 라운드
            radius={i === series.length - 1 ? [3, 3, 0, 0] : undefined}
            name={s.label}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}
