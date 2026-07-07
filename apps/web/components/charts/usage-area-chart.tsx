"use client";

import { useTranslations } from "next-intl";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { DailyPoint, TimeBucket } from "@toard/core";
import { fmtCompact } from "@/lib/format";

const tooltipStyle = {
  background: "var(--color-popover)",
  border: "1px solid var(--color-border)",
  borderRadius: 8,
  fontSize: 12,
  color: "var(--color-popover-foreground)",
} as const;

export function UsageAreaChart({
  data,
  metric,
  bucket = "day",
}: {
  data: DailyPoint[];
  metric: "cost" | "tokens";
  bucket?: TimeBucket;
}) {
  const t = useTranslations("dashboard");
  const chartData = data.map((d) => ({
    // 버킷 키 'YYYY-MM-DD'/'YYYY-MM-DD HH:00' → 축 라벨 'MM-DD'/'HH:00'
    day: bucket === "hour" ? d.day.slice(11) : d.day.slice(5),
    cost: Number(d.costUsd.toFixed(4)),
    // 총 소모 토큰(입력+출력+캐시) — 토큰 카드·테이블과 동일 정의
    tokens: d.inputTokens + d.outputTokens + d.cacheReadTokens + d.cacheCreationTokens,
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
        {/* 압축 표기(1.5M)로 눈금 라벨이 width 를 넘겨 잘리는 것 방지 */}
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
          formatter={(v: number) => (isCost ? [`$${v}`, t("chart.cost")] : [v.toLocaleString(), t("chart.tokens")])}
        />
        <Area
          type="monotone"
          dataKey={isCost ? "cost" : "tokens"}
          stroke="var(--color-chart-1)"
          strokeWidth={2}
          fill="url(#fillUsage)"
          // 마운트 직후 컨테이너 폭이 바뀌면 애니메이션 상태가 곡선 경로 재계산을 막아
          // 축만 넓어지고 선이 왼쪽에 눌린 채 남는다(recharts 2.15) — 애니메이션 비활성으로 회피
          isAnimationActive={false}
          // 포인트가 하나뿐이면(자정 직후 등) 선·면이 그려지지 않아 점으로 표시
          dot={chartData.length < 2 ? { r: 4, fill: "var(--color-chart-1)", strokeWidth: 0 } : false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
