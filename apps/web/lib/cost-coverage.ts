import type { UsageCostCoverage, UsageCostStatus } from "@toard/core";

export type CostCoverageState = "complete" | "partial" | "unpriced" | "legacy" | "estimated";

export function costCoverageState(coverage: UsageCostCoverage): CostCoverageState {
  if (coverage.unpricedEvents > 0) {
    return coverage.pricedEvents + (coverage.estimatedEvents ?? 0) + coverage.legacyEvents > 0 ? "partial" : "unpriced";
  }
  if ((coverage.estimatedEvents ?? 0) > 0) return "estimated";
  if (coverage.legacyEvents > 0) return "legacy";
  return "complete";
}

export function legacyCostHintCount(coverage: UsageCostCoverage): number | null {
  return costCoverageState(coverage) === "legacy" ? coverage.legacyEvents : null;
}

export function formatCostForCoverage(
  cost: string,
  coverage: UsageCostCoverage,
  labels: { partial: string; unpriced: string; legacy: string; estimated?: string },
): string {
  const state = costCoverageState(coverage);
  if (state === "unpriced") return labels.unpriced;
  if (state === "estimated") return labels.estimated ? `${cost} · ${labels.estimated}` : `≈ ${cost}`;
  if (state === "partial") return `${cost} · ${labels.partial}`;
  return cost;
}

export function costCoverageForStatus(status: UsageCostStatus): UsageCostCoverage {
  return {
    pricedEvents: status === "priced" ? 1 : 0,
    ...(status === "estimated" ? { estimatedEvents: 1 } : {}),
    unpricedEvents: status === "unpriced" ? 1 : 0,
    legacyEvents: status === "legacy" ? 1 : 0,
  };
}
