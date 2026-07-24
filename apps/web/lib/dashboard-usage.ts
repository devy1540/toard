import type { TimeBucket, UsageCostCoverage } from "@toard/core";
import { fmtUsd } from "./format";
import { formatCostForCoverage } from "./cost-coverage";

export type UsageTitleKey = "dailyUsage" | "hourlyUsage" | "usage30m" | "usage15m";
export type CostCoverageLabels = { partial: string; unpriced: string; legacy: string };

export function usageTitleKey(bucket: TimeBucket): UsageTitleKey {
  if (bucket === "day") return "dailyUsage";
  if (bucket === "hour") return "hourlyUsage";
  if (bucket === "30m") return "usage30m";
  return "usage15m";
}

export function formatCoveredCost(
  costUsd: number,
  coverage: UsageCostCoverage,
  labels: CostCoverageLabels,
): string {
  return formatCostForCoverage(fmtUsd(costUsd), coverage, labels);
}
