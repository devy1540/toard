import type {
  InsightCompositionChange,
  InsightMetricSummary,
  InsightTrendPoint,
  UserInsightComparison,
} from "./storage";

export type InsightPeriod = "current" | "previous";

export type InsightAggregateRow = {
  kind: "summary" | "trend";
  period: InsightPeriod;
  position: number | null;
  costUsd: number;
  sessions: number;
  totalTokens: number;
};

export type InsightCompositionRow = {
  dimension: "model" | "provider";
  key: string;
  period: InsightPeriod;
  costUsd: number;
  totalTokens: number;
};

const zeroSummary = (): InsightMetricSummary => ({ costUsd: 0, sessions: 0, totalTokens: 0 });

const zeroComposition = (): InsightCompositionChange[InsightPeriod] => ({
  costUsd: 0,
  totalTokens: 0,
});

export function buildUserInsightComparison(
  rows: InsightAggregateRow[],
  compositions: InsightCompositionRow[],
): UserInsightComparison {
  let current = zeroSummary();
  let previous = zeroSummary();
  const trendByPosition = new Map<number, InsightTrendPoint>();

  for (const row of rows) {
    const summary = { costUsd: row.costUsd, sessions: row.sessions, totalTokens: row.totalTokens };
    if (row.kind === "summary") {
      if (row.period === "current") current = summary;
      else previous = summary;
      continue;
    }
    if (row.position == null) continue;

    const point = trendByPosition.get(row.position) ?? {
      position: row.position,
      current: zeroSummary(),
      previous: zeroSummary(),
    };
    point[row.period] = summary;
    trendByPosition.set(row.position, point);
  }

  const byDimension = {
    model: new Map<string, InsightCompositionChange>(),
    provider: new Map<string, InsightCompositionChange>(),
  };

  for (const row of compositions) {
    const key = row.key || "(unknown)";
    const values = byDimension[row.dimension].get(key) ?? {
      key,
      current: zeroComposition(),
      previous: zeroComposition(),
    };
    values[row.period] = { costUsd: row.costUsd, totalTokens: row.totalTokens };
    byDimension[row.dimension].set(key, values);
  }

  const sortedComposition = (values: Map<string, InsightCompositionChange>) =>
    [...values.values()].sort(
      (a, b) => b.current.costUsd - a.current.costUsd || a.key.localeCompare(b.key),
    );

  return {
    current,
    previous,
    trend: [...trendByPosition.values()].sort((a, b) => a.position - b.position),
    byModel: sortedComposition(byDimension.model),
    byProvider: sortedComposition(byDimension.provider),
  };
}
