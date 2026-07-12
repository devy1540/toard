import {
  USAGE_EVENT_LOGICAL_RETENTION_DAYS,
  type FinalizedUsageEvent,
  type UsageEvent,
} from "@toard/core";
import { resolveCostAt, type PricingSchedule } from "@toard/pricing";

export const MAX_USAGE_EVENT_AGE_MS =
  USAGE_EVENT_LOGICAL_RETENTION_DAYS * 24 * 60 * 60 * 1000;

export type FinalizationResult = {
  events: FinalizedUsageEvent[];
  expired: number;
};

export type FinalizationOptions = {
  mode: "calculate" | "auto";
  priceHints?: Map<string, { providedCostUsd?: number | null; isFast?: boolean }>;
};

export function finalizeUsageEvents(
  events: UsageEvent[],
  userId: string,
  schedule: PricingSchedule,
  options: FinalizationOptions,
  now = new Date(),
): FinalizationResult {
  const cutoff = now.getTime() - MAX_USAGE_EVENT_AGE_MS;
  const accepted = events.filter((event) => event.ts.getTime() >= cutoff);

  return {
    expired: events.length - accepted.length,
    events: accepted.map((event) => {
      const hints = options.priceHints?.get(event.dedupKey);
      const price = resolveCostAt({
        ...event,
        ...hints,
        occurredAt: event.ts,
        schedule,
        mode: options.mode,
      });
      return {
        ...event,
        userId,
        costUsd: price.costUsd,
        pricingRevisionId: price.pricingRevisionId,
        costStatus: price.status,
      };
    }),
  };
}
