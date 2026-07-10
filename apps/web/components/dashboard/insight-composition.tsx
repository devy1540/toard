"use client";

import type { InsightCompositionChange } from "@toard/core";
import { useFormatter, useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SegmentedControl, type SegmentedControlItem } from "@/components/ui/segmented-control";

type CompositionDimension = "model" | "provider";
type InsightMetric = "cost" | "tokens";

function metricValue(row: InsightCompositionChange, period: "current" | "previous", metric: InsightMetric) {
  return metric === "cost" ? row[period].costUsd : row[period].totalTokens;
}

export function InsightComposition({
  byModel,
  byProvider,
  metric,
}: {
  byModel: InsightCompositionChange[];
  byProvider: InsightCompositionChange[];
  metric: InsightMetric;
}) {
  const t = useTranslations("insights");
  const format = useFormatter();
  const [dimension, setDimension] = useState<CompositionDimension>("model");
  const tabs: SegmentedControlItem<CompositionDimension>[] = [
    { value: "model", label: t("composition.model") },
    { value: "provider", label: t("composition.provider") },
  ];
  const rows = useMemo(() => {
    const source = dimension === "model" ? byModel : byProvider;
    const currentTotal = source.reduce((sum, row) => sum + metricValue(row, "current", metric), 0);
    const previousTotal = source.reduce((sum, row) => sum + metricValue(row, "previous", metric), 0);

    return source
      .filter((row) => metricValue(row, "current", metric) > 0 || metricValue(row, "previous", metric) > 0)
      .map((row) => {
        const currentShare = currentTotal > 0 ? (metricValue(row, "current", metric) / currentTotal) * 100 : 0;
        const previousShare = previousTotal > 0 ? (metricValue(row, "previous", metric) / previousTotal) * 100 : 0;
        return { key: row.key, currentShare, previousShare, delta: currentShare - previousShare };
      })
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.key.localeCompare(b.key))
      .slice(0, 5);
  }, [byModel, byProvider, dimension, metric]);

  const formatShare = (value: number) => format.number(value, { maximumFractionDigits: 1 });
  const formatDelta = (value: number) => {
    const sign = value > 0 ? "+" : value < 0 ? "−" : "±";
    return `${sign}${format.number(Math.abs(value), { maximumFractionDigits: 1 })}%p`;
  };

  return (
    <Card>
      <CardHeader className="gap-3 sm:grid-cols-[1fr_auto]">
        <div className="space-y-1.5">
          <CardTitle>{t("composition.title")}</CardTitle>
          <CardDescription>{t("composition.description")}</CardDescription>
        </div>
        <SegmentedControl
          value={dimension}
          items={tabs}
          onValueChange={setDimension}
          aria-label={t("composition.label")}
        />
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <div className="text-muted-foreground py-8 text-center text-sm">{t("composition.empty")}</div>
        ) : (
          <div className="divide-y">
            {rows.map((row) => (
              <div key={row.key} className="grid gap-2 py-3 first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium" title={row.key}>
                    {row.key}
                  </div>
                  <div className="text-muted-foreground mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs">
                    <span>{t("composition.currentShare", { share: formatShare(row.currentShare) })}</span>
                    <span>{t("composition.previousShare", { share: formatShare(row.previousShare) })}</span>
                  </div>
                </div>
                <div className="text-sm font-semibold tabular-nums">{formatDelta(row.delta)}</div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
