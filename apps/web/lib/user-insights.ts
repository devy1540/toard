import type { UserInsightComparison } from "@toard/core";
import { unstable_cache } from "next/cache";
import type { InsightPeriodPair } from "./insight-period";
import { getStorage } from "./storage";

export type CachedUserInsights = UserInsightComparison & { calculatedAt: string };

export function insightCacheArgs(userId: string, pair: InsightPeriodPair, providerKey?: string) {
  return [
    userId,
    pair.current.from.toISOString(),
    pair.current.to.toISOString(),
    pair.previous.from.toISOString(),
    pair.previous.to.toISOString(),
    providerKey ?? "",
    pair.timezone,
  ] as const;
}

const readCached = unstable_cache(
  async (
    userId: string,
    currentFrom: string,
    currentTo: string,
    previousFrom: string,
    previousTo: string,
    providerKey: string,
    timezone: string,
  ): Promise<CachedUserInsights> => ({
    ...(await getStorage().getUserInsightComparison(userId, {
      current: { from: new Date(currentFrom), to: new Date(currentTo) },
      previous: { from: new Date(previousFrom), to: new Date(previousTo) },
      providerKey: providerKey || undefined,
      timezone,
    })),
    calculatedAt: new Date().toISOString(),
  }),
  ["user-insights-v2"],
  { revalidate: 600 },
);

export function getCachedUserInsights(userId: string, pair: InsightPeriodPair, providerKey?: string) {
  return readCached(...insightCacheArgs(userId, pair, providerKey));
}
