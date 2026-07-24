import type { SessionUsageSummary } from "@toard/core";

export function totalSessionUsageTokens(usage: SessionUsageSummary): number {
  return usage.inputTokens
    + usage.outputTokens
    + usage.cacheReadTokens
    + usage.cacheCreationTokens;
}
