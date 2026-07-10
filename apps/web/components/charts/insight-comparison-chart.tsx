"use client";

import type { InsightTrendPoint } from "@toard/core";
import { useFormatter, useTranslations } from "next-intl";
import { useId } from "react";
import { getInsightPositionDate } from "@/lib/insight-chart-date";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

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
  currentFrom,
  previousFrom,
  previousTo,
  timezone,
}: {
  data: InsightTrendPoint[];
  metric: "cost" | "tokens";
  currentFrom: string;
  previousFrom: string;
  previousTo: string;
  timezone: string;
}) {
  const t = useTranslations("insights");
  const format = useFormatter();
  const descriptionId = useId();
  const gradientId = `${descriptionId.replace(/:/g, "")}-current-fill`;
  const isCost = metric === "cost";
  const currentStart = new Date(currentFrom);
  const previousStart = new Date(previousFrom);
  const previousEnd = new Date(previousTo);
  const chartData = data.map(({ position, current, previous }) => {
    const previousDate = getInsightPositionDate(previousStart, position, timezone, previousEnd);
    return {
      position: position + 1,
      current: isCost ? current.costUsd : current.totalTokens,
      previous: previousDate === null ? undefined : isCost ? previous.costUsd : previous.totalTokens,
    };
  });
  const formatValue = (value: number) =>
    isCost
      ? format.number(value, { style: "currency", currency: "USD", maximumFractionDigits: 4 })
      : format.number(value, { notation: "compact", maximumFractionDigits: 1 });
  const formatDate = (date: Date) =>
    format.dateTime(date, { month: "numeric", day: "numeric", timeZone: "UTC" });
  const formatPositionDate = (start: Date, displayPosition: number) =>
    formatDate(getInsightPositionDate(start, displayPosition - 1, timezone));
  const formatPreviousPositionDate = (displayPosition: number) => {
    const date = getInsightPositionDate(
      previousStart,
      displayPosition - 1,
      timezone,
      previousEnd,
    );
    return date === null ? null : formatDate(date);
  };

  return (
    <div className="w-full">
      <p id={descriptionId} className="sr-only">
        {t("chart.accessibleDescription")}
      </p>
      <ResponsiveContainer width="100%" height={280}>
        <ComposedChart
          data={chartData}
          margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
          accessibilityLayer
          aria-label={t("chart.accessibleLabel")}
          aria-describedby={descriptionId}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="var(--color-chart-1)" stopOpacity={0.32} />
              <stop offset="95%" stopColor="var(--color-chart-1)" stopOpacity={0.04} />
            </linearGradient>
          </defs>
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
            tickFormatter={(position: number) => formatPositionDate(currentStart, position)}
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
            labelFormatter={(position: number) => {
              const previousDate = formatPreviousPositionDate(position);
              return t("chart.dateComparison", {
                current: formatPositionDate(currentStart, position),
                previous: previousDate ?? t("chart.comparisonUnavailable"),
              });
            }}
            formatter={(value: number, name: string) => [
              formatValue(value),
              name === "current" ? t("chart.current") : t("chart.previous"),
            ]}
          />
          <Area
            type="monotone"
            dataKey="current"
            stroke="var(--color-chart-1)"
            strokeWidth={2}
            fill={`url(#${gradientId})`}
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
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
