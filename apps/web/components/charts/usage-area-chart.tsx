"use client";

import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { DailyPoint } from "@toard/core";

const tooltipStyle = {
  background: "var(--color-popover)",
  border: "1px solid var(--color-border)",
  borderRadius: 8,
  fontSize: 12,
  color: "var(--color-popover-foreground)",
} as const;

export function UsageAreaChart({ data, metric }: { data: DailyPoint[]; metric: "cost" | "tokens" }) {
  const chartData = data.map((d) => ({
    day: d.day.slice(5),
    cost: Number(d.costUsd.toFixed(4)),
    tokens: d.inputTokens + d.outputTokens,
  }));
  const isCost = metric === "cost";

  return (
    <ResponsiveContainer width="100%" height={260}>
      <AreaChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="fillUsage" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--color-chart-1)" stopOpacity={0.5} />
            <stop offset="95%" stopColor="var(--color-chart-1)" stopOpacity={0.04} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} stroke="var(--color-border)" />
        <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} fontSize={12} stroke="var(--color-muted-foreground)" />
        <YAxis tickLine={false} axisLine={false} width={52} fontSize={12} stroke="var(--color-muted-foreground)" />
        <Tooltip
          contentStyle={tooltipStyle}
          formatter={(v: number) => (isCost ? [`$${v}`, "비용"] : [v.toLocaleString(), "토큰"])}
        />
        <Area
          type="monotone"
          dataKey={isCost ? "cost" : "tokens"}
          stroke="var(--color-chart-1)"
          strokeWidth={2}
          fill="url(#fillUsage)"
          // 데이터가 하루뿐이면(오늘 필터) 선·면이 그려지지 않아 점으로 표시
          dot={chartData.length < 2 ? { r: 4, fill: "var(--color-chart-1)", strokeWidth: 0 } : false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
