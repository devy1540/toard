import type { FinalizedUsageEvent, UsageCostCoverage } from "@toard/core";
import { COST_CALCULATION_VERSION, type CostBreakdown } from "@toard/pricing";

export const COST_DRIVER_VERSION = "cost-drivers-v1";
export const COST_DRIVERS = ["volume", "modelMix", "outputMix", "cacheMix", "effectiveRates"] as const;
export type CostDriver = typeof COST_DRIVERS[number];
const BUCKETS = ["input", "output", "cacheRead", "cacheCreate", "cacheCreate1h"] as const;
type Buckets = [number, number, number, number, number];
type Profile = { key: string; units: Buckets; usd: Buckets; events: number };
export type CostPeriod = {
  costUsd: number;
  tokens: number;
  events: number;
  coverage: UsageCostCoverage;
  comparableCostUsd: number;
  comparableEvents: number;
  legacyEvidenceEvents: number;
  profiles: Profile[];
  incompleteModels: string[];
};
const zero = (): Buckets => [0, 0, 0, 0, 0];
const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

/** Aggregate a complete authorized range. No raw session, device or user identifiers
 * are retained in the mathematical model. Missing evidence remains unclassified. */
export class CostPeriodAccumulator {
  private profiles = new Map<string, Profile>();
  private incomplete = new Set<string>();
  private period: Omit<CostPeriod, "profiles" | "incompleteModels"> = {
    costUsd: 0, tokens: 0, events: 0, comparableCostUsd: 0, comparableEvents: 0, legacyEvidenceEvents: 0,
    coverage: { pricedEvents: 0, estimatedEvents: 0, unpricedEvents: 0, legacyEvents: 0 },
  };

  add(event: FinalizedUsageEvent, breakdown: CostBreakdown | null): void {
    const oneHour = event.cacheCreation1hTokens ?? 0;
    const units: Buckets = [event.inputTokens, event.outputTokens, event.cacheReadTokens, event.cacheCreationTokens - oneHour, oneHour];
    if (units.some(value => !Number.isSafeInteger(value) || value < 0) || !Number.isFinite(event.costUsd) || event.costUsd < 0) {
      throw new Error("invalid_report_evidence");
    }
    const total = sum(units);
    if (!Number.isSafeInteger(this.period.tokens + total)) throw new Error("report_token_total_out_of_range");
    this.period.tokens += total;
    this.period.events++;
    if (event.costStatus === "legacy" || event.costCalculationVersion !== COST_CALCULATION_VERSION) this.period.legacyEvidenceEvents++;
    this.period.costUsd += event.costUsd;
    const field = { priced: "pricedEvents", estimated: "estimatedEvents", unpriced: "unpricedEvents", legacy: "legacyEvents" } as const;
    const coverage = field[event.costStatus];
    if (!coverage) throw new Error("unsupported_report_cost_status");
    this.period.coverage[coverage] = (this.period.coverage[coverage] ?? 0) + 1;
    const key = JSON.stringify([event.providerKey, event.model]);
    if (!breakdown || event.costStatus === "unpriced" || event.costStatus === "legacy") { this.incomplete.add(key); return; }
    const components = BUCKETS.map(key => breakdown.componentsUsd[key]) as Buckets;
    const computed = sum(components);
    if (components.some(value => !Number.isFinite(value) || value < 0)
      || Math.abs(computed - event.costUsd) > 1e-8 || (computed === 0 && event.costUsd !== 0)
      || components.some((value, index) => units[index] === 0 && value !== 0)) { this.incomplete.add(key); return; }
    let profile = this.profiles.get(key);
    if (!profile) { profile = { key, units: zero(), usd: zero(), events: 0 }; this.profiles.set(key, profile); }
    profile.events++;
    // SQL decimal rounding must not accumulate into a spurious unexplained bill.
    const scale = computed === 0 ? 1 : event.costUsd / computed;
    for (let index = 0; index < 5; index++) {
      profile.units[index]! += units[index]!;
      profile.usd[index]! += components[index]! * scale;
    }
    this.period.comparableCostUsd += event.costUsd;
    this.period.comparableEvents++;
  }

  snapshot(): CostPeriod {
    return { ...this.period, coverage: { ...this.period.coverage }, incompleteModels: [...this.incomplete], profiles: [...this.profiles.values()].map(profile => ({
      key: profile.key, units: [...profile.units], usd: [...profile.usd], events: profile.events,
    })) };
  }
}

type Factors = { total: number; share: number; output: number; cache: Buckets; rates: Buckets };
function factors(profile: Profile | undefined, other: Profile | undefined, total: number, otherTotal: number): Factors {
  const own = profile ?? { key: "", units: zero(), usd: zero(), events: 0 };
  const alternate = other ?? { key: "", units: zero(), usd: zero(), events: 0 };
  const units = sum(own.units);
  const altUnits = sum(alternate.units);
  const input = units - own.units[1];
  const altInput = altUnits - alternate.units[1];
  const cache = zero();
  const rates = zero();
  for (let index = 0; index < 5; index++) {
    if (index !== 1) cache[index] = input > 0 ? own.units[index]! / input : altInput > 0 ? alternate.units[index]! / altInput : Number(index === 0);
    rates[index] = own.units[index]! > 0 ? own.usd[index]! / own.units[index]! : alternate.units[index]! > 0 ? alternate.usd[index]! / alternate.units[index]! : 0;
  }
  return {
    total,
    share: total > 0 ? units / total : otherTotal > 0 ? altUnits / otherTotal : 0,
    output: units > 0 ? own.units[1] / units : altUnits > 0 ? alternate.units[1] / altUnits : 0,
    cache, rates,
  };
}

/** Average each factor's marginal effect over every ordering (five-factor
 * Shapley decomposition). This describes observed composition, not causality.
 * Effective rates include price revisions, context tiers and service modes.
 * An unobserved model/bucket borrows the other period's observed distribution or
 * rate, so entering a new model does not invent an unobserved price change. */
export function decomposeCostChange(previous: CostPeriod, current: CostPeriod) {
  // Never turn a loss of price evidence into an apparent decrease in usage.
  // Exclude the entire provider/model group on both sides when either side has
  // unpriced or unreproducible rows; its stored amount remains in the residual.
  const excluded = new Set([...previous.incompleteModels, ...current.incompleteModels]);
  const old = new Map(previous.profiles.filter(profile => !excluded.has(profile.key)).map(profile => [profile.key, profile]));
  const fresh = new Map(current.profiles.filter(profile => !excluded.has(profile.key)).map(profile => [profile.key, profile]));
  const oldTotal = sum([...old.values()].map(profile => sum(profile.units)));
  const newTotal = sum([...fresh.values()].map(profile => sum(profile.units)));
  const pairs = [...new Set([...old.keys(), ...fresh.keys()])].map(key => [
    factors(old.get(key), fresh.get(key), oldTotal, newTotal),
    factors(fresh.get(key), old.get(key), newTotal, oldTotal),
  ] as const);
  const values = Array.from({ length: 32 }, (_, mask) => {
    const volume = mask & 1 ? newTotal : oldTotal;
    return volume * sum(pairs.map(pair => {
      const mix = pair[mask & 2 ? 1 : 0];
      const output = pair[mask & 4 ? 1 : 0].output;
      const cache = pair[mask & 8 ? 1 : 0].cache;
      const rates = pair[mask & 16 ? 1 : 0].rates;
      const inputRate = sum(cache.map((share, index) => share * rates[index]!));
      return mix.share * ((1 - output) * inputRate + output * rates[1]);
    }));
  });
  const factorial = [1, 1, 2, 6, 24, 120];
  const driversUsd = Object.fromEntries(COST_DRIVERS.map((key, index) => {
    let contribution = 0;
    for (let mask = 0; mask < 32; mask++) {
      if (mask & (1 << index)) continue;
      let count = 0; for (let bits = mask; bits; bits &= bits - 1) count++;
      const weight = factorial[count]! * factorial[4 - count]! / factorial[5]!;
      contribution += weight * (values[mask | (1 << index)]! - values[mask]!);
    }
    return [key, contribution];
  })) as Record<CostDriver, number>;
  const deltaUsd = current.costUsd - previous.costUsd;
  const unexplainedUsd = deltaUsd - sum(Object.values(driversUsd));
  return { version: COST_DRIVER_VERSION, deltaUsd, driversUsd, unexplainedUsd,
    missingEvidenceEvents: previous.events + current.events - previous.comparableEvents - current.comparableEvents,
    excludedEvents: previous.events + current.events - sum([...old.values(), ...fresh.values()].map(profile => profile.events)),
    analyzedPreviousUsd: sum([...old.values()].map(profile => sum(profile.usd))), analyzedCurrentUsd: sum([...fresh.values()].map(profile => sum(profile.usd))) };
}

/** Balance the visible rows to the displayed delta instead of hiding rounding
 * discrepancies. The final row includes missing evidence and display rounding. */
export function displayCostDrivers(result: ReturnType<typeof decomposeCostChange>, digits = 6) {
  const scale = 10 ** digits;
  const drivers = COST_DRIVERS.map(key => ({ key, usd: Math.round(result.driversUsd[key] * scale) / scale || 0 }));
  const residual = (Math.round(result.deltaUsd * scale) - sum(drivers.map(row => Math.round(row.usd * scale)))) / scale;
  return { drivers, residual: residual || 0, delta: Math.round(result.deltaUsd * scale) / scale || 0 };
}
