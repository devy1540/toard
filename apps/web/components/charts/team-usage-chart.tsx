"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { DailyPoint, TimeBucket } from "@toard/core";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { fmtCompact } from "@/lib/format";
import type { TeamMemberSeries } from "@/lib/team-overview";
import { UsageAreaChart } from "./usage-area-chart";

type TeamChartMode = "aggregate" | "members";

const tooltipStyle = {
  background: "var(--color-popover)",
  border: "1px solid var(--color-border)",
  borderRadius: 8,
  fontSize: 12,
  color: "var(--color-popover-foreground)",
} as const;

export function TeamUsageChart({
  aggregate,
  members,
  metric,
  bucket,
  markNow,
}: {
  aggregate: DailyPoint[];
  members: TeamMemberSeries[];
  metric: "cost" | "tokens";
  bucket: TimeBucket;
  markNow: boolean;
}) {
  const t = useTranslations("org");
  const dashboardT = useTranslations("dashboard");
  const [mode, setMode] = useState<TeamChartMode>("aggregate");
  const isCost = metric === "cost";
  const memberData = useMemo(() => {
    return aggregate.map((bucketPoint, index) => {
      const row: Record<string, number | string> = {
        day: bucket === "day" ? bucketPoint.day.slice(5) : bucketPoint.day.slice(11),
      };
      for (const member of members) {
        const point = member.points[index];
        row[member.key] = isCost ? (point?.costUsd ?? 0) : (point?.totalTokens ?? 0);
      }
      return row;
    });
  }, [aggregate, bucket, isCost, members]);
  const nowKey = markNow && memberData.length > 1 ? memberData.at(-1)?.day : undefined;

  if (members.length === 0) {
    return <UsageAreaChart data={aggregate} metric={metric} bucket={bucket} markNow={markNow} />;
  }

  return (
    <div className="space-y-3">
      <SegmentedControl
        value={mode}
        onValueChange={setMode}
        aria-label={t("teamChartMode")}
        items={[
          { value: "aggregate", label: t("teamChartAggregate") },
          { value: "members", label: t("teamChartMembers") },
        ]}
      />

      {mode === "aggregate" ? (
        <UsageAreaChart data={aggregate} metric={metric} bucket={bucket} markNow={markNow} />
      ) : (
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={memberData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--color-border)" />
            <XAxis
              dataKey="day"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={24}
              fontSize={12}
              stroke="var(--color-muted-foreground)"
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              width={52}
              fontSize={12}
              stroke="var(--color-muted-foreground)"
              tickFormatter={(value: number) => (isCost ? `$${fmtCompact(value)}` : fmtCompact(value))}
            />
            <Tooltip
              contentStyle={tooltipStyle}
              formatter={(value: number, name: string) => [
                isCost ? `$${value.toLocaleString()}` : value.toLocaleString(),
                members.find((member) => member.key === name)?.label ?? name,
              ]}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {nowKey != null ? (
              <ReferenceLine x={nowKey} stroke="var(--color-muted-foreground)" strokeDasharray="3 3" />
            ) : null}
            {members.map((member) => (
              <Line
                key={member.key}
                type="monotone"
                dataKey={member.key}
                name={member.label}
                stroke={member.color}
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
