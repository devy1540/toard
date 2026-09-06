import assert from "node:assert/strict";
import test from "node:test";
import type { FinalizedUsageEvent } from "@toard/core";
import { calculateTokenCost, type ModelPricing } from "@toard/pricing";
import { CostPeriodAccumulator, COST_DRIVERS, decomposeCostChange, displayCostDrivers } from "./cost-drivers";

const rates: ModelPricing = { inputPerM: 1, outputPerM: 5, cacheReadPerM: 0.1, cacheCreatePerM: 1.25, cacheCreate1hPerM: 2, fastMultiplier: 1 };
function record(changes: Partial<FinalizedUsageEvent> = {}, prices = rates) {
  const event: FinalizedUsageEvent = { dedupKey: "fixture", providerKey: "fixture", model: "model-a", userId: "owner", sessionId: null,
    ts: new Date("2026-09-01T00:00:00Z"), inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    costUsd: 0, costStatus: "priced", pricingRevisionId: "revision", costCalculationVersion: "cost-v2", ...changes };
  const breakdown = calculateTokenCost(event, prices)!;
  event.costUsd = changes.costUsd ?? breakdown.totalUsd;
  return { event, breakdown };
}
function period(...rows: ReturnType<typeof record>[]) {
  const accumulator = new CostPeriodAccumulator();
  for (const row of rows) accumulator.add(row.event, row.breakdown);
  return accumulator.snapshot();
}
function close(actual: number, expected: number) { assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`); }

test("isolated volume, output, cache and effective-price changes are attributed to their own factor", () => {
  const before = period(record());
  for (const [driver, after, delta] of [
    ["volume", period(record({ inputTokens: 2_000_000 })), 1],
    ["outputMix", period(record({ inputTokens: 0, outputTokens: 1_000_000 })), 4],
    ["cacheMix", period(record({ inputTokens: 0, cacheReadTokens: 1_000_000 })), -0.9],
    ["effectiveRates", period(record({}, { ...rates, inputPerM: 2 })), 1],
  ] as const) {
    const result = decomposeCostChange(before, after);
    close(result.deltaUsd, delta);
    for (const key of COST_DRIVERS) close(result.driversUsd[key], key === driver ? delta : 0);
    close(result.unexplainedUsd, 0);
  }
});

test("a newly used model changes the mix without inventing an unobserved price change", () => {
  const before = period(record());
  const after = period(record({ model: "model-b" }, { ...rates, inputPerM: 3 }));
  const result = decomposeCostChange(before, after);
  close(result.driversUsd.modelMix, 2);
  for (const key of COST_DRIVERS.filter(key => key !== "modelMix")) close(result.driversUsd[key], 0);
});

test("mixed changes balance to stored amounts, and reversing the periods reverses each contribution", () => {
  const previous = period(record(), record({ model: "model-b", inputTokens: 500_000, outputTokens: 100_000 }));
  const current = period(record({ inputTokens: 800_000, outputTokens: 200_000, cacheReadTokens: 900_000 }, { ...rates, inputPerM: 1.4 }),
    record({ model: "model-b", inputTokens: 40_000, outputTokens: 130_000 }, { ...rates, outputPerM: 7 }));
  const forward = decomposeCostChange(previous, current), reverse = decomposeCostChange(current, previous);
  close(Object.values(forward.driversUsd).reduce((a, b) => a + b, 0) + forward.unexplainedUsd, current.costUsd - previous.costUsd);
  for (const key of COST_DRIVERS) close(forward.driversUsd[key], -reverse.driversUsd[key]);
  const displayed = displayCostDrivers(forward);
  close(displayed.drivers.reduce((sum, row) => sum + row.usd, 0) + displayed.residual, displayed.delta);
});

test("legacy/missing evidence remains unclassified and unpriced events are not described as savings", () => {
  const previous = new CostPeriodAccumulator();
  previous.add(record({ costUsd: 3, costStatus: "legacy" }).event, null);
  const current = new CostPeriodAccumulator();
  current.add(record({ costUsd: 0, costStatus: "unpriced" }).event, null);
  const result = decomposeCostChange(previous.snapshot(), current.snapshot());
  close(result.unexplainedUsd, -3);
  assert.equal(result.missingEvidenceEvents, 2);
  assert.equal(current.snapshot().coverage.unpricedEvents, 1);
  for (const amount of Object.values(result.driversUsd)) close(amount, 0);
});

test("zero baselines and SQL decimal rounding stay finite and preserve the recorded total", () => {
  const current = period(record({ inputTokens: 1, costUsd: 0.0000010001 }));
  const result = decomposeCostChange(period(), current);
  for (const amount of Object.values(result.driversUsd)) assert.ok(Number.isFinite(amount));
  close(result.driversUsd.volume, current.costUsd);
  close(result.unexplainedUsd, 0);
});

test("one-hour cache is a subset, and inconsistent evidence is never attributed", () => {
  const item = record({ inputTokens: 0, cacheCreationTokens: 1_000_000, cacheCreation1hTokens: 400_000 });
  const good = period(item);
  assert.equal(good.tokens, 1_000_000);
  close(good.costUsd, 1.55);
  const accumulator = new CostPeriodAccumulator();
  accumulator.add(item.event, { ...item.breakdown, componentsUsd: { ...item.breakdown.componentsUsd, input: 2 } });
  assert.equal(accumulator.snapshot().comparableEvents, 0);
});

test("missing prices on an existing model cannot be presented as a usage reduction", () => {
  const before = period(record());
  const after = new CostPeriodAccumulator();
  after.add(record({ inputTokens: 2_000_000, costStatus: "unpriced", costUsd: 0 }).event, null);
  const result = decomposeCostChange(before, after.snapshot());
  close(result.driversUsd.volume, 0);
  close(result.unexplainedUsd, -1);
  assert.equal(result.excludedEvents, 2);
});
