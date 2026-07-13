import { getPricingStatus } from "./pricing";
import {
  PgPricingRepairRepository,
  type PricingRepairState,
  type PricingUnresolvedModel,
} from "./pricing-repair";
import { getPool } from "./db";

export type PricingAdminStatus = {
  models: number;
  lastDay: string | null;
  repair: {
    state: PricingRepairState;
    recoveredEvents: number;
    remainingUnpricedEvents: number;
    lastSucceededAt: string | null;
  };
  unresolvedModels: PricingUnresolvedModel[];
};

export async function getPricingAdminStatus(): Promise<PricingAdminStatus> {
  const [pricing, repair] = await Promise.all([
    getPricingStatus(),
    new PgPricingRepairRepository(getPool()).get(),
  ]);
  return {
    models: pricing.models,
    lastDay: pricing.lastDay,
    repair: {
      state: repair.state,
      recoveredEvents: repair.recoveredEvents,
      remainingUnpricedEvents: repair.remainingUnpricedEvents,
      lastSucceededAt: repair.lastSucceededAt?.toISOString() ?? null,
    },
    unresolvedModels: repair.unresolvedModels,
  };
}
