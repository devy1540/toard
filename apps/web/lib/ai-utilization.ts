import {
  addLocalCalendarDays,
  aggregateOrganizationUtilization,
  buildUtilizationPeriods,
  calculatePersonalUtilization,
  firstInstantOfLocalDate,
  localDateKey,
  UTILIZATION_METHODOLOGY_VERSION,
  type OrganizationUtilizationResult,
  type PersonalUtilizationResult,
  type UtilizationDailyFeature,
  type UtilizationPeriods,
  type UtilizationToolDay,
  type UtilizationUsageDay,
} from "@toard/core";
import { unstable_cache } from "next/cache";
import { getOrganizationUtilizationToolDays, getUserUtilizationToolDays } from "./tool-metadata";
import { getOrgTimezone } from "./org-time";
import { getStorage } from "./storage";

const featureKey = (userId: string, day: string): string => `${userId}\0${day}`;
const UTILIZATION_HISTORY_WEEKS = 12;

export type PersonalUtilizationHistoryPoint = {
  currentPeriod: { from: Date; to: Date };
  score: number | null;
  confidence: PersonalUtilizationResult["confidence"];
};

export type PersonalUtilizationView = PersonalUtilizationResult & {
  calculatedAt: string;
  history: PersonalUtilizationHistoryPoint[];
};
const reviveDate = (value: Date | string): Date =>
  value instanceof Date ? new Date(value.getTime()) : new Date(value);

function emptyUsage(userId: string, day: string): UtilizationUsageDay {
  return {
    userId,
    day,
    sessions: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    cacheSignalEvents: 0,
    cacheUnsupportedEvents: 0,
  };
}

function emptyFeature(usage: UtilizationUsageDay): UtilizationDailyFeature {
  return {
    ...usage,
    toolSuccesses: 0,
    toolFailures: 0,
    toolUnknown: 0,
    repeatedToolFailures: 0,
    recoveryAttempts: 0,
    successfulRecoveries: 0,
    sessionToolKnownCalls: 0,
    toolActiveSessions: 0,
    distinctTools: 0,
  };
}

export function mergeUtilizationDays(
  usageRows: UtilizationUsageDay[],
  toolRows: UtilizationToolDay[],
): UtilizationDailyFeature[] {
  const merged = new Map<string, UtilizationDailyFeature>();
  for (const usage of usageRows) {
    merged.set(featureKey(usage.userId, usage.day), emptyFeature(usage));
  }
  for (const tool of toolRows) {
    const key = featureKey(tool.userId, tool.day);
    const feature = merged.get(key) ?? emptyFeature(emptyUsage(tool.userId, tool.day));
    feature.toolSuccesses = tool.successes;
    feature.toolFailures = tool.failures;
    feature.toolUnknown = tool.unknown;
    feature.repeatedToolFailures = tool.repeatedFailures;
    feature.recoveryAttempts = tool.recoveryAttempts;
    feature.successfulRecoveries = tool.successfulRecoveries;
    feature.sessionToolKnownCalls = tool.sessionToolKnownCalls;
    feature.toolActiveSessions = tool.toolActiveSessions;
    feature.distinctTools = tool.distinctTools;
    merged.set(key, feature);
  }
  return [...merged.values()].sort(
    (left, right) => left.day.localeCompare(right.day) || left.userId.localeCompare(right.userId),
  );
}

export function buildUtilizationHistoryPeriods(
  periods: UtilizationPeriods,
  weeks = UTILIZATION_HISTORY_WEEKS,
): UtilizationPeriods[] {
  const currentToDay = localDateKey(periods.current.to, periods.timezone);
  return Array.from({ length: weeks }, (_, index) => {
    const weeksAgo = weeks - index - 1;
    const anchorDay = addLocalCalendarDays(currentToDay, -7 * weeksAgo);
    return buildUtilizationPeriods(firstInstantOfLocalDate(anchorDay, periods.timezone), periods.timezone);
  });
}

function utilizationRange(periods: UtilizationPeriods) {
  return {
    from: periods.baseline.from,
    to: periods.current.to,
    timezone: periods.timezone,
  };
}

async function calculatePersonalForPeriods(
  userId: string,
  periods: UtilizationPeriods,
): Promise<PersonalUtilizationView> {
  const historyPeriods = buildUtilizationHistoryPeriods(periods);
  const range = {
    from: historyPeriods[0]?.baseline.from ?? periods.baseline.from,
    to: periods.current.to,
    timezone: periods.timezone,
  };
  const [usage, tools] = await Promise.all([
    getStorage().getUserUtilizationUsage(userId, range),
    getUserUtilizationToolDays(userId, range, periods.timezone),
  ]);
  const rows = mergeUtilizationDays(usage, tools);
  const result = calculatePersonalUtilization(rows, periods);
  return {
    ...result,
    calculatedAt: new Date().toISOString(),
    history: historyPeriods.map((historyPeriod) => {
      const historyResult = calculatePersonalUtilization(rows, historyPeriod);
      return {
        currentPeriod: historyResult.currentPeriod,
        score: historyResult.score,
        confidence: historyResult.confidence,
      };
    }),
  };
}

export async function calculatePersonalUtilizationForUser(
  userId: string,
  now = new Date(),
): Promise<PersonalUtilizationView> {
  const periods = buildUtilizationPeriods(now, getOrgTimezone());
  return calculatePersonalForPeriods(userId, periods);
}

export function calculateOrganizationUtilizationFromRows(
  usageRows: UtilizationUsageDay[],
  toolRows: UtilizationToolDay[],
  periods: UtilizationPeriods,
): OrganizationUtilizationResult {
  const merged = mergeUtilizationDays(usageRows, toolRows);
  const currentFrom = localDateKey(periods.current.from, periods.timezone);
  const currentTo = localDateKey(periods.current.to, periods.timezone);
  const activeUsers = new Set(
    usageRows
      .filter((row) => row.sessions > 0 && row.day >= currentFrom && row.day < currentTo)
      .map((row) => row.userId),
  );
  const byUser = new Map<string, UtilizationDailyFeature[]>();
  for (const row of merged) {
    if (!activeUsers.has(row.userId)) continue;
    const rows = byUser.get(row.userId) ?? [];
    rows.push(row);
    byUser.set(row.userId, rows);
  }
  const personalResults = [...activeUsers].map((userId) =>
    calculatePersonalUtilization(byUser.get(userId) ?? [], periods));
  return aggregateOrganizationUtilization(personalResults, activeUsers.size);
}

async function calculateOrganizationForPeriods(
  periods: UtilizationPeriods,
): Promise<OrganizationUtilizationResult> {
  const range = utilizationRange(periods);
  const [usage, tools] = await Promise.all([
    getStorage().getOrganizationUtilizationUsage(range),
    getOrganizationUtilizationToolDays(range, periods.timezone),
  ]);
  return calculateOrganizationUtilizationFromRows(usage, tools, periods);
}

export async function calculateOrganizationUtilization(
  now = new Date(),
): Promise<OrganizationUtilizationResult> {
  const periods = buildUtilizationPeriods(now, getOrgTimezone());
  return calculateOrganizationForPeriods(periods);
}

export function utilizationCacheArgs(userId: string, periods: UtilizationPeriods) {
  return [
    userId,
    periods.baseline.from.toISOString(),
    periods.current.from.toISOString(),
    periods.current.to.toISOString(),
    periods.timezone,
    UTILIZATION_METHODOLOGY_VERSION,
  ] as const;
}

function organizationCacheArgs(periods: UtilizationPeriods) {
  return [
    periods.baseline.from.toISOString(),
    periods.current.from.toISOString(),
    periods.current.to.toISOString(),
    periods.timezone,
    UTILIZATION_METHODOLOGY_VERSION,
  ] as const;
}

function periodsFromCacheArgs(
  baselineFrom: string,
  currentFrom: string,
  currentTo: string,
  timezone: string,
): UtilizationPeriods {
  return {
    baseline: { from: new Date(baselineFrom), to: new Date(currentFrom) },
    current: { from: new Date(currentFrom), to: new Date(currentTo) },
    timezone,
  };
}

const readCachedPersonal = unstable_cache(
  async (
    userId: string,
    baselineFrom: string,
    currentFrom: string,
    currentTo: string,
    timezone: string,
    _methodologyVersion: string,
  ) => calculatePersonalForPeriods(
    userId,
    periodsFromCacheArgs(baselineFrom, currentFrom, currentTo, timezone),
  ),
  ["personal-utilization-v2"],
  { revalidate: 600 },
);

const readCachedOrganization = unstable_cache(
  async (
    baselineFrom: string,
    currentFrom: string,
    currentTo: string,
    timezone: string,
    _methodologyVersion: string,
  ) => calculateOrganizationForPeriods(
    periodsFromCacheArgs(baselineFrom, currentFrom, currentTo, timezone),
  ),
  ["organization-utilization-v2"],
  { revalidate: 600 },
);

export async function getCachedPersonalUtilization(userId: string, now = new Date()) {
  const periods = buildUtilizationPeriods(now, getOrgTimezone());
  const result = await readCachedPersonal(...utilizationCacheArgs(userId, periods));
  return {
    ...result,
    currentPeriod: {
      from: reviveDate(result.currentPeriod.from),
      to: reviveDate(result.currentPeriod.to),
    },
    baselinePeriod: {
      from: reviveDate(result.baselinePeriod.from),
      to: reviveDate(result.baselinePeriod.to),
    },
    history: result.history.map((point) => ({
      ...point,
      currentPeriod: {
        from: reviveDate(point.currentPeriod.from),
        to: reviveDate(point.currentPeriod.to),
      },
    })),
  } satisfies PersonalUtilizationView;
}

export function getCachedOrganizationUtilization(now = new Date()) {
  const periods = buildUtilizationPeriods(now, getOrgTimezone());
  return readCachedOrganization(...organizationCacheArgs(periods));
}
