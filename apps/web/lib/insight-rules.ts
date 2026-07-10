import type { InsightCompositionChange, UserInsightComparison } from "@toard/core";

export type InsightMetric = "cost" | "tokens";
export type InsightRuleKey =
  | "cost.increase"
  | "cost.decrease"
  | "sessions.increase"
  | "sessions.decrease"
  | "tokens.increase"
  | "tokens.decrease"
  | "efficiency.increase"
  | "efficiency.decrease"
  | "composition.increase"
  | "composition.decrease"
  | "composition.new";

export interface InsightCandidate {
  key: InsightRuleKey;
  score: number;
  values: Record<string, number | string>;
}

const RATE_THRESHOLD = 10;
const SHARE_THRESHOLD = 5;
const MIN_SESSIONS = 5;
const MAX_INSIGHTS = 3;
const PERCENTAGE_TOLERANCE = 1e-9;

function isBelowThreshold(value: number, threshold: number): boolean {
  return Math.abs(value) + PERCENTAGE_TOLERANCE < threshold;
}

function rate(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

function compositionCandidates(
  rows: InsightCompositionChange[],
  totalCurrent: number,
  totalPrevious: number,
  metric: InsightMetric,
  dimension: "model" | "provider",
): InsightCandidate[] {
  return rows.flatMap<InsightCandidate>((row) => {
    const current = metric === "cost" ? row.current.costUsd : row.current.totalTokens;
    const previous = metric === "cost" ? row.previous.costUsd : row.previous.totalTokens;
    if (previous === 0 && current > 0) {
      return [{ key: "composition.new", score: 100, values: { name: row.key, dimension } }];
    }
    if (totalCurrent === 0 || totalPrevious === 0) return [];

    const delta = (current / totalCurrent - previous / totalPrevious) * 100;
    if (isBelowThreshold(delta, SHARE_THRESHOLD)) return [];
    return [
      {
        key: delta > 0 ? "composition.increase" : "composition.decrease",
        score: Math.abs(delta),
        values: { name: row.key, delta: Math.abs(delta), dimension },
      },
    ];
  });
}

function rateCandidate(
  name: "cost" | "sessions" | "tokens" | "efficiency",
  current: number,
  previous: number,
): InsightCandidate | null {
  const delta = rate(current, previous);
  if (delta == null || isBelowThreshold(delta, RATE_THRESHOLD)) return null;
  return {
    key: `${name}.${delta > 0 ? "increase" : "decrease"}` as InsightRuleKey,
    score: Math.abs(delta),
    values: { delta: Math.abs(delta) },
  };
}

export function generateInsightCandidates(
  comparison: UserInsightComparison,
  metric: InsightMetric,
): InsightCandidate[] {
  const candidates: InsightCandidate[] = [];
  const add = (candidate: InsightCandidate | null) => {
    if (candidate) candidates.push(candidate);
  };

  add(rateCandidate("cost", comparison.current.costUsd, comparison.previous.costUsd));
  add(rateCandidate("sessions", comparison.current.sessions, comparison.previous.sessions));
  add(rateCandidate("tokens", comparison.current.totalTokens, comparison.previous.totalTokens));
  if (comparison.current.sessions >= MIN_SESSIONS && comparison.previous.sessions >= MIN_SESSIONS) {
    add(
      rateCandidate(
        "efficiency",
        comparison.current.costUsd / comparison.current.sessions,
        comparison.previous.costUsd / comparison.previous.sessions,
      ),
    );
  }

  const totalCurrent = metric === "cost" ? comparison.current.costUsd : comparison.current.totalTokens;
  const totalPrevious = metric === "cost" ? comparison.previous.costUsd : comparison.previous.totalTokens;
  candidates.push(
    ...compositionCandidates(comparison.byModel, totalCurrent, totalPrevious, metric, "model"),
    ...compositionCandidates(comparison.byProvider, totalCurrent, totalPrevious, metric, "provider"),
  );

  return candidates.sort((a, b) => b.score - a.score).slice(0, MAX_INSIGHTS);
}
