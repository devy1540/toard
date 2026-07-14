import { getPricingStatus } from "./pricing";
import {
  PgPricingRepairRepository,
  type PricingRepairState,
  type PricingUnresolvedModel,
} from "./pricing-repair";
import { getPool } from "./db";
import {
  PgPricingHistoryRepository,
  type HistoricalPricingStatus,
} from "./pricing-history";

export type PricingAdminStatus = {
  models: number;
  lastDay: string | null;
  repair: {
    state: PricingRepairState;
    recoveredEvents: number;
    reconciledEvents: number;
    remainingUnpricedEvents: number;
    lastSucceededAt: string | null;
  };
  history: HistoricalPricingStatus;
  unresolvedModels: PricingUnresolvedModel[];
};

export async function getPricingAdminStatus(): Promise<PricingAdminStatus> {
  const pool = getPool();
  const [pricing, repair, history] = await Promise.all([
    getPricingStatus(),
    new PgPricingRepairRepository(pool).get(),
    new PgPricingHistoryRepository(pool).getStatus(),
  ]);
  return {
    models: pricing.models,
    lastDay: pricing.lastDay,
    repair: {
      state: repair.state,
      recoveredEvents: repair.recoveredEvents,
      reconciledEvents: repair.reconciledEvents,
      remainingUnpricedEvents: repair.remainingUnpricedEvents,
      lastSucceededAt: repair.lastSucceededAt?.toISOString() ?? null,
    },
    history,
    unresolvedModels: repair.unresolvedModels,
  };
}
