export type OrgChartMetric = "tokens" | "cost";

export const ORG_LEADERBOARD_METRIC = "tokens" as const;

type TokenUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
};

type TokenUsageBucket = TokenUsage & { day: string };

export function getOrgChartMetric(value: string | undefined): OrgChartMetric {
  return value === "cost" ? "cost" : "tokens";
}

export function totalUsageTokens({ input, output, cacheRead, cacheCreation }: TokenUsage): number {
  return input + output + cacheRead + cacheCreation;
}

export function cacheSharePercent(cacheTokens: number, totalTokens: number): number | null {
  return sharePercent(cacheTokens, totalTokens);
}

export function sharePercent(part: number, total: number): number | null {
  return total > 0 ? Math.round((part / total) * 100) : null;
}

export function tokenLeaderboardMetrics({
  tokens,
  totalTokens,
  maxTokens,
}: {
  tokens: number;
  totalTokens: number;
  maxTokens: number;
}): { width: number; share: number | null } {
  return {
    width: maxTokens > 0 ? Math.max(3, Math.round((tokens / maxTokens) * 100)) : 0,
    share: sharePercent(tokens, totalTokens),
  };
}

export function usagePerActiveUser(totalTokens: number, activeUsers: number): number | null {
  return activeUsers > 0 ? totalTokens / activeUsers : null;
}

export function findPeakTokenBucket<T extends TokenUsageBucket>(points: T[]): T | null {
  let peak: T | null = null;
  let peakTokens = 0;

  for (const point of points) {
    const tokens = totalUsageTokens(point);
    if (tokens > peakTokens) {
      peak = point;
      peakTokens = tokens;
    }
  }

  return peak;
}
