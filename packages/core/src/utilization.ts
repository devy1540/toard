import { addLocalCalendarDays, firstInstantOfLocalDate, localDateKey } from "./timezone";
import type { PeriodQuery } from "./storage";

export const UTILIZATION_METHODOLOGY_VERSION = "utilization-v2" as const;
export const CACHE_SIGNAL_PROVIDER_KEYS = ["claude_code", "codex", "cursor", "gemini", "qwen"] as const;
export const TOOL_OUTCOME_PROVIDER_KEYS = ["claude_code", "codex", "cursor"] as const;

export type UtilizationReason =
  | "insufficient_current_days"
  | "insufficient_current_sessions"
  | "insufficient_baseline_days"
  | "unsupported_cache_signal"
  | "insufficient_context_days"
  | "insufficient_known_tool_calls"
  | "insufficient_tool_days"
  | "low_tool_outcome_coverage"
  | "insufficient_valid_dimensions"
  | "suppressed_small_cohort"
  | "insufficient_eligible_users"
  | "mixed_methodology_versions";

export type UtilizationDimensionKey =
  | "context_continuity"
  | "execution_stability";

export interface UtilizationPeriods {
  current: { from: Date; to: Date };
  baseline: { from: Date; to: Date };
  timezone: string;
}

export interface UtilizationProviderCapability {
  reportsCacheRead: boolean;
  reportsToolOutcome: boolean;
  reportsSessionId: boolean;
}

export interface UtilizationUsageQuery extends PeriodQuery {
  timezone: string;
}

export interface UtilizationUsageDay {
  userId: string;
  day: string;
  sessions: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cacheSignalEvents: number;
  cacheUnsupportedEvents: number;
}

export interface UtilizationToolDay {
  userId: string;
  day: string;
  successes: number;
  failures: number;
  unknown: number;
  repeatedFailures: number;
  recoveryAttempts: number;
  successfulRecoveries: number;
  sessionToolKnownCalls: number;
  toolActiveSessions: number;
  distinctTools: number;
}

export interface UtilizationDailyFeature extends UtilizationUsageDay {
  toolSuccesses: number;
  toolFailures: number;
  toolUnknown: number;
  repeatedToolFailures: number;
  recoveryAttempts: number;
  successfulRecoveries: number;
  sessionToolKnownCalls: number;
  toolActiveSessions: number;
  distinctTools: number;
}

export interface UtilizationDimensionResult {
  key: UtilizationDimensionKey;
  score: number | null;
  currentValue: number | null;
  baselineMedian: number | null;
  currentSampleSize: number;
  baselineSampleSize: number;
  reason: UtilizationReason | null;
}

export interface PersonalUtilizationResult {
  methodologyVersion: typeof UTILIZATION_METHODOLOGY_VERSION;
  score: number | null;
  confidence: "high" | "medium" | "low";
  currentPeriod: { from: Date; to: Date };
  baselinePeriod: { from: Date; to: Date };
  dimensions: UtilizationDimensionResult[];
  reasons: UtilizationReason[];
  observations: {
    activeDays: number;
    sessions: number;
    toolActiveSessionRate: number | null;
    distinctTools: number;
    knownToolCalls: number;
    toolOutcomeCoverage: number | null;
    repeatedToolFailures: number;
    recoveryAttempts: number;
    successfulRecoveries: number;
    recoveryRate: number | null;
  };
}
export type OrganizationUtilizationResult =
  | {
      state: "suppressed";
      methodologyVersion: typeof UTILIZATION_METHODOLOGY_VERSION;
      reason: "suppressed_small_cohort";
    }
  | {
      state: "insufficient_data";
      methodologyVersion: typeof UTILIZATION_METHODOLOGY_VERSION;
      reason: "insufficient_eligible_users" | "mixed_methodology_versions";
    }
  | {
      state: "available";
      methodologyVersion: typeof UTILIZATION_METHODOLOGY_VERSION;
      sampleSize: number;
      excludedUsers: number;
      median: number;
      range: { p25: number; p75: number };
      dimensionMedians: Record<UtilizationDimensionKey, number | null>;
      relativeDistribution: { above: number; usual: number; below: number };
    };

const CACHE_PROVIDER_SET = new Set<string>(CACHE_SIGNAL_PROVIDER_KEYS);
const TOOL_OUTCOME_PROVIDER_SET = new Set<string>(TOOL_OUTCOME_PROVIDER_KEYS);

export function getUtilizationProviderCapability(providerKey: string): UtilizationProviderCapability {
  const currentLogProvider = CACHE_PROVIDER_SET.has(providerKey);
  const reportsTools = TOOL_OUTCOME_PROVIDER_SET.has(providerKey);
  return {
    reportsCacheRead: currentLogProvider,
    reportsToolOutcome: reportsTools,
    reportsSessionId: currentLogProvider,
  };
}

export function buildUtilizationPeriods(now: Date, timezone: string): UtilizationPeriods {
  const today = localDateKey(now, timezone);
  const currentTo = firstInstantOfLocalDate(today, timezone);
  const currentFrom = firstInstantOfLocalDate(addLocalCalendarDays(today, -7), timezone);
  const baselineFrom = firstInstantOfLocalDate(addLocalCalendarDays(today, -35), timezone);
  return {
    current: { from: currentFrom, to: currentTo },
    baseline: { from: baselineFrom, to: currentFrom },
    timezone,
  };
}

export function median(values: number[]): number {
  if (values.length === 0) throw new Error("median requires at least one value");
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function normalizeUtilizationDimension(
  current: number,
  baseline: number[],
  direction: 1 | -1,
): number {
  const center = median(baseline);
  const mad = median(baseline.map((value) => Math.abs(value - center)));
  const scale = Math.max(1.4826 * mad, 0.05);
  const raw = Math.round(50 + 15 * direction * ((current - center) / scale));
  return Math.max(0, Math.min(100, raw));
}

function periodDays(period: { from: Date; to: Date }, timezone: string): { from: string; to: string } {
  return { from: localDateKey(period.from, timezone), to: localDateKey(period.to, timezone) };
}

function rowsInPeriod(
  rows: UtilizationDailyFeature[],
  period: { from: Date; to: Date },
  timezone: string,
): UtilizationDailyFeature[] {
  const days = periodDays(period, timezone);
  return rows.filter((row) => row.day >= days.from && row.day < days.to);
}

function activeDays(rows: UtilizationDailyFeature[]): number {
  return new Set(rows.filter((row) => row.sessions > 0).map((row) => row.day)).size;
}

function contextValues(rows: UtilizationDailyFeature[]): number[] {
  return rows.flatMap((row) => {
    const denominator = row.inputTokens + row.cacheReadTokens + row.cacheCreationTokens;
    if (row.cacheSignalEvents <= 0 || denominator <= 0) return [];
    return [row.cacheReadTokens / denominator];
  });
}

function executionValues(rows: UtilizationDailyFeature[]): number[] {
  return rows.flatMap((row) => {
    const known = row.toolSuccesses + row.toolFailures;
    return known > 0 ? [row.toolSuccesses / known] : [];
  });
}

function toolTotals(rows: UtilizationDailyFeature[]) {
  return rows.reduce(
    (sum, row) => ({
      successes: sum.successes + row.toolSuccesses,
      failures: sum.failures + row.toolFailures,
      unknown: sum.unknown + row.toolUnknown,
      sessionKnown: sum.sessionKnown + row.sessionToolKnownCalls,
      repeatedFailures: sum.repeatedFailures + row.repeatedToolFailures,
      recoveryAttempts: sum.recoveryAttempts + row.recoveryAttempts,
      successfulRecoveries: sum.successfulRecoveries + row.successfulRecoveries,
    }),
    {
      successes: 0,
      failures: 0,
      unknown: 0,
      sessionKnown: 0,
      repeatedFailures: 0,
      recoveryAttempts: 0,
      successfulRecoveries: 0,
    },
  );
}

function toolCoverage(totals: ReturnType<typeof toolTotals>): number {
  const all = totals.successes + totals.failures + totals.unknown;
  return all > 0 ? (totals.successes + totals.failures) / all : 0;
}

function unavailableDimension(
  key: UtilizationDimensionKey,
  reason: UtilizationReason,
  currentSampleSize = 0,
  baselineSampleSize = 0,
): UtilizationDimensionResult {
  return {
    key,
    score: null,
    currentValue: null,
    baselineMedian: null,
    currentSampleSize,
    baselineSampleSize,
    reason,
  };
}

function contextDimension(
  currentRows: UtilizationDailyFeature[],
  baselineRows: UtilizationDailyFeature[],
): UtilizationDimensionResult {
  const current = contextValues(currentRows);
  const baseline = contextValues(baselineRows);
  const currentSamples = currentRows.reduce((sum, row) => sum + row.cacheSignalEvents, 0);
  const baselineSamples = baselineRows.reduce((sum, row) => sum + row.cacheSignalEvents, 0);
  const supported = [...currentRows, ...baselineRows].reduce((sum, row) => sum + row.cacheSignalEvents, 0);
  const unsupported = [...currentRows, ...baselineRows].reduce((sum, row) => sum + row.cacheUnsupportedEvents, 0);
  if (supported === 0 && unsupported > 0) {
    return unavailableDimension(
      "context_continuity",
      "unsupported_cache_signal",
      currentSamples,
      baselineSamples,
    );
  }
  if (current.length < 3 || baseline.length < 7) {
    return unavailableDimension(
      "context_continuity",
      "insufficient_context_days",
      currentSamples,
      baselineSamples,
    );
  }
  const currentValue = median(current);
  const baselineMedian = median(baseline);
  return {
    key: "context_continuity",
    score: normalizeUtilizationDimension(currentValue, baseline, 1),
    currentValue,
    baselineMedian,
    currentSampleSize: currentSamples,
    baselineSampleSize: baselineSamples,
    reason: null,
  };
}

function executionDimension(
  currentRows: UtilizationDailyFeature[],
  baselineRows: UtilizationDailyFeature[],
): UtilizationDimensionResult {
  const currentTotals = toolTotals(currentRows);
  const baselineTotals = toolTotals(baselineRows);
  const currentKnown = currentTotals.successes + currentTotals.failures;
  const baselineKnown = baselineTotals.successes + baselineTotals.failures;
  if (currentKnown < 10 || baselineKnown < 10) {
    return unavailableDimension(
      "execution_stability",
      "insufficient_known_tool_calls",
      currentKnown,
      baselineKnown,
    );
  }
  if (toolCoverage(currentTotals) < 0.7 || toolCoverage(baselineTotals) < 0.7) {
    return unavailableDimension(
      "execution_stability",
      "low_tool_outcome_coverage",
      currentKnown,
      baselineKnown,
    );
  }
  const current = executionValues(currentRows);
  const baseline = executionValues(baselineRows);
  if (baseline.length < 7 || current.length < 2) {
    return unavailableDimension(
      "execution_stability",
      "insufficient_tool_days",
      currentKnown,
      baselineKnown,
    );
  }
  const currentValue = median(current);
  const baselineMedian = median(baseline);
  return {
    key: "execution_stability",
    score: normalizeUtilizationDimension(currentValue, baseline, 1),
    currentValue,
    baselineMedian,
    currentSampleSize: currentKnown,
    baselineSampleSize: baselineKnown,
    reason: null,
  };
}

function unsupportedEventShare(rows: UtilizationDailyFeature[]): number {
  const supported = rows.reduce((sum, row) => sum + row.cacheSignalEvents, 0);
  const unsupported = rows.reduce((sum, row) => sum + row.cacheUnsupportedEvents, 0);
  const total = supported + unsupported;
  return total > 0 ? unsupported / total : 0;
}

export function calculatePersonalUtilization(
  rows: UtilizationDailyFeature[],
  periods: UtilizationPeriods,
): PersonalUtilizationResult {
  const currentRows = rowsInPeriod(rows, periods.current, periods.timezone);
  const baselineRows = rowsInPeriod(rows, periods.baseline, periods.timezone);
  const currentActiveDays = activeDays(currentRows);
  const baselineActiveDays = activeDays(baselineRows);
  const currentSessions = currentRows.reduce((sum, row) => sum + row.sessions, 0);
  const reasons: UtilizationReason[] = [];
  if (currentActiveDays < 3) reasons.push("insufficient_current_days");
  if (currentSessions < 5) reasons.push("insufficient_current_sessions");
  if (baselineActiveDays < 7) reasons.push("insufficient_baseline_days");

  const dimensions = [
    contextDimension(currentRows, baselineRows),
    executionDimension(currentRows, baselineRows),
  ];
  const validScores = dimensions.flatMap((dimension) => dimension.score == null ? [] : [dimension.score]);
  const commonEligible = reasons.length === 0;
  if (validScores.length < 2) reasons.push("insufficient_valid_dimensions");
  const score = commonEligible && validScores.length >= 2
    ? Math.round(validScores.reduce((sum, value) => sum + value, 0) / validScores.length)
    : null;
  const currentTool = toolTotals(currentRows);
  const baselineTool = toolTotals(baselineRows);
  const highConfidence = score != null
    && validScores.length === dimensions.length
    && baselineActiveDays >= 14
    && toolCoverage(currentTool) >= 0.9
    && toolCoverage(baselineTool) >= 0.9
    && unsupportedEventShare([...currentRows, ...baselineRows]) <= 0.1;
  const confidence = highConfidence ? "high" : score == null ? "low" : "medium";
  const toolActiveSessions = currentRows.reduce((sum, row) => sum + row.toolActiveSessions, 0);

  return {
    methodologyVersion: UTILIZATION_METHODOLOGY_VERSION,
    score,
    confidence,
    currentPeriod: periods.current,
    baselinePeriod: periods.baseline,
    dimensions,
    reasons: [...new Set(reasons)],
    observations: {
      activeDays: currentActiveDays,
      sessions: currentSessions,
      toolActiveSessionRate: currentSessions > 0 ? Math.min(1, toolActiveSessions / currentSessions) : null,
      distinctTools: currentRows.reduce((maximum, row) => Math.max(maximum, row.distinctTools), 0),
      knownToolCalls: currentTool.successes + currentTool.failures,
      toolOutcomeCoverage: currentTool.successes + currentTool.failures + currentTool.unknown > 0
        ? toolCoverage(currentTool)
        : null,
      repeatedToolFailures: currentTool.repeatedFailures,
      recoveryAttempts: currentTool.recoveryAttempts,
      successfulRecoveries: currentTool.successfulRecoveries,
      recoveryRate: currentTool.recoveryAttempts > 0
        ? currentTool.successfulRecoveries / currentTool.recoveryAttempts
        : null,
    },
  };
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.round((sorted.length - 1) * fraction)]!;
}

export function aggregateOrganizationUtilization(
  results: PersonalUtilizationResult[],
  activeUsers: number,
): OrganizationUtilizationResult {
  if (activeUsers < 5) {
    return {
      state: "suppressed",
      methodologyVersion: UTILIZATION_METHODOLOGY_VERSION,
      reason: "suppressed_small_cohort",
    };
  }
  if (results.some((result) => result.methodologyVersion !== UTILIZATION_METHODOLOGY_VERSION)) {
    return {
      state: "insufficient_data",
      methodologyVersion: UTILIZATION_METHODOLOGY_VERSION,
      reason: "mixed_methodology_versions",
    };
  }
  const eligible = results.filter(
    (result): result is PersonalUtilizationResult & { score: number } =>
      result.score != null && result.confidence !== "low",
  );
  if (eligible.length < 5) {
    return {
      state: "insufficient_data",
      methodologyVersion: UTILIZATION_METHODOLOGY_VERSION,
      reason: "insufficient_eligible_users",
    };
  }
  const scores = eligible.map((result) => result.score);
  const dimensionMedians = Object.fromEntries(
    (["context_continuity", "execution_stability"] as const).map((key) => {
      const dimensionScores = eligible.flatMap((result) => {
        const score = result.dimensions.find((dimension) => dimension.key === key)?.score;
        return score == null ? [] : [score];
      });
      return [key, dimensionScores.length > 0 ? median(dimensionScores) : null];
    }),
  ) as Record<UtilizationDimensionKey, number | null>;
  return {
    state: "available",
    methodologyVersion: UTILIZATION_METHODOLOGY_VERSION,
    sampleSize: eligible.length,
    excludedUsers: Math.max(0, activeUsers - eligible.length),
    median: median(scores),
    range: { p25: percentile(scores, 0.25), p75: percentile(scores, 0.75) },
    dimensionMedians,
    relativeDistribution: {
      above: scores.filter((score) => score >= 56).length,
      usual: scores.filter((score) => score >= 45 && score <= 55).length,
      below: scores.filter((score) => score <= 44).length,
    },
  };
}
