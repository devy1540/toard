import {
  resolvePricingEntry,
  type ModelPricing,
  type PricingMap,
} from "@toard/pricing";
import type { PricingHistoryCommitRef } from "./pricing-history-source";

export type PricingHistorySnapshot = {
  ref: PricingHistoryCommitRef;
  pricing: PricingMap;
};

export type PricingHistoryCandidate = {
  modelId: string;
  sourceModelId: string;
  effectiveAt: Date;
  validUntil: Date;
  pricing: ModelPricing;
  sourceCommitSha: string;
  sourceCommittedAt: Date;
};

type OpenPricingHistoryCandidate = Omit<PricingHistoryCandidate, "validUntil">;

export type PricingHistoryIntervalState = {
  rangeFrom: Date;
  models: readonly string[];
  lastCommittedAt: Date | null;
  open: ReadonlyMap<string, OpenPricingHistoryCandidate>;
  closed: readonly PricingHistoryCandidate[];
};

export function createPricingIntervalState(input: {
  rangeFrom: Date;
  models: readonly string[];
}): PricingHistoryIntervalState {
  if (!Number.isFinite(input.rangeFrom.getTime())) throw new Error("invalid pricing history range start");
  const models = [...new Set(input.models.filter((model) => model.trim() !== ""))].sort();
  return {
    rangeFrom: new Date(input.rangeFrom),
    models,
    lastCommittedAt: null,
    open: new Map(),
    closed: [],
  };
}

function samePricing(left: ModelPricing, right: ModelPricing): boolean {
  return left.inputPerM === right.inputPerM &&
    left.outputPerM === right.outputPerM &&
    (left.cacheReadPerM ?? null) === (right.cacheReadPerM ?? null) &&
    (left.cacheCreatePerM ?? null) === (right.cacheCreatePerM ?? null) &&
    (left.inputAbove200kPerM ?? null) === (right.inputAbove200kPerM ?? null) &&
    (left.outputAbove200kPerM ?? null) === (right.outputAbove200kPerM ?? null) &&
    (left.fastMultiplier ?? 1) === (right.fastMultiplier ?? 1);
}

function closeCandidate(
  candidate: OpenPricingHistoryCandidate,
  validUntil: Date,
): PricingHistoryCandidate | null {
  if (validUntil <= candidate.effectiveAt) return null;
  return { ...candidate, validUntil: new Date(validUntil) };
}

export function applyPricingSnapshot(
  state: PricingHistoryIntervalState,
  snapshot: PricingHistorySnapshot,
): PricingHistoryIntervalState {
  const committedAt = new Date(snapshot.ref.committedAt);
  if (!Number.isFinite(committedAt.getTime())) throw new Error("invalid pricing snapshot time");
  if (state.lastCommittedAt == null && committedAt > state.rangeFrom) {
    throw new Error("baseline snapshot must not be after range start");
  }
  if (state.lastCommittedAt != null && committedAt <= state.lastCommittedAt) {
    throw new Error("pricing snapshots must be chronological");
  }

  const boundary = committedAt < state.rangeFrom ? state.rangeFrom : committedAt;
  const open = new Map(state.open);
  const closed = [...state.closed];
  for (const model of state.models) {
    const previous = open.get(model);
    const resolved = resolvePricingEntry(model, snapshot.pricing);
    if (previous && resolved &&
      previous.sourceModelId === resolved.modelId &&
      samePricing(previous.pricing, resolved.pricing)) {
      continue;
    }
    if (previous) {
      const completed = closeCandidate(previous, boundary);
      if (completed) closed.push(completed);
      open.delete(model);
    }
    if (resolved) {
      open.set(model, {
        modelId: model,
        sourceModelId: resolved.modelId,
        effectiveAt: new Date(boundary),
        pricing: { ...resolved.pricing },
        sourceCommitSha: snapshot.ref.sha,
        sourceCommittedAt: new Date(committedAt),
      });
    }
  }
  return {
    ...state,
    lastCommittedAt: committedAt,
    open,
    closed,
  };
}

export function closePricingIntervals(
  state: PricingHistoryIntervalState,
  rangeTo: Date,
): PricingHistoryCandidate[] {
  if (!Number.isFinite(rangeTo.getTime()) || rangeTo < state.rangeFrom) {
    throw new Error("invalid pricing history range end");
  }
  const candidates = [...state.closed];
  for (const candidate of state.open.values()) {
    const completed = closeCandidate(candidate, rangeTo);
    if (completed) candidates.push(completed);
  }
  return candidates
    .filter((candidate) => candidate.effectiveAt >= state.rangeFrom && candidate.validUntil <= rangeTo)
    .sort((left, right) =>
      left.modelId.localeCompare(right.modelId) ||
      left.effectiveAt.getTime() - right.effectiveAt.getTime()
    );
}
