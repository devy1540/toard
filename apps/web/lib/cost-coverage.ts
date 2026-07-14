import type { UsageCostCoverage, UsageCostStatus } from "@toard/core";

export type CostCoverageState = "complete" | "partial" | "unpriced" | "legacy";

export function costCoverageState(coverage: UsageCostCoverage): CostCoverageState {
  if (coverage.unpricedEvents > 0) {
    return coverage.pricedEvents + coverage.legacyEvents > 0 ? "partial" : "unpriced";
  }
  if (coverage.legacyEvents > 0) return "legacy";
  return "complete";
}

export function legacyCostHintCount(coverage: UsageCostCoverage): number | null {
  return costCoverageState(coverage) === "legacy" ? coverage.legacyEvents : null;
}

export function formatCostForCoverage(
  cost: string,
  coverage: UsageCostCoverage,
  labels: { partial: string; unpriced: string; legacy: string },
): string {
  const state = costCoverageState(coverage);
  if (state === "unpriced") return labels.unpriced;
  if (state === "partial") return `${cost} · ${labels.partial}`;
  return cost;
}

export function costCoverageForStatus(status: UsageCostStatus): UsageCostCoverage {
  return {
    pricedEvents: status === "priced" ? 1 : 0,
    unpricedEvents: status === "unpriced" ? 1 : 0,
    legacyEvents: status === "legacy" ? 1 : 0,
  };
}
