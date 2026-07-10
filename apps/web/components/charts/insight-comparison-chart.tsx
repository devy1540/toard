"use client";

import type { InsightTrendPoint } from "@toard/core";
import { useFormatter, useTranslations } from "next-intl";
import { useId } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

const tooltipStyle = {
  background: "var(--color-popover)",
  border: "1px solid var(--color-border)",
  borderRadius: 8,
  fontSize: 12,
  color: "var(--color-popover-foreground)",
} as const;

export function InsightComparisonChart({
  data,
  metric,
}: {
  data: InsightTrendPoint[];
  metric: "cost" | "tokens";
}) {
  const t = useTranslations("insights");
  const format = useFormatter();
  const descriptionId = useId();
  const isCost = metric === "cost";
  const chartData = data.map(({ position, current, previous }) => ({
    position: position + 1,
    current: isCost ? current.costUsd : current.totalTokens,
    previous: isCost ? previous.costUsd : previous.totalTokens,
  }));
  const formatValue = (value: number) =>
    isCost
      ? format.number(value, { style: "currency", currency: "USD", maximumFractionDigits: 4 })
      : format.number(value, { notation: "compact", maximumFractionDigits: 1 });

  return (
    <div
      className="w-full"
      role="img"
      aria-label={t("chart.accessibleLabel")}
      aria-describedby={descriptionId}
    >
      <p id={descriptionId} className="sr-only">
        {t("chart.accessibleDescription")}
      </p>
      <ResponsiveContainer width="100%" height={280}>
        <LineChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} accessibilityLayer>
          <CartesianGrid vertical={false} stroke="var(--color-border)" />
          <XAxis
            dataKey="position"
            type="number"
            domain={["dataMin", "dataMax"]}
            allowDecimals={false}
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            minTickGap={20}
            fontSize={12}
            stroke="var(--color-muted-foreground)"
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            width={56}
            fontSize={12}
            stroke="var(--color-muted-foreground)"
            tickFormatter={formatValue}
          />
          <Tooltip
            contentStyle={tooltipStyle}
            labelFormatter={(position: number) => t("chart.position", { position: format.number(position) })}
            formatter={(value: number, name: string) => [
              formatValue(value),
              name === "current" ? t("chart.current") : t("chart.previous"),
            ]}
          />
          <Line
            type="monotone"
            dataKey="current"
            stroke="var(--color-chart-1)"
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="previous"
            stroke="var(--color-muted-foreground)"
            strokeDasharray="4 4"
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
