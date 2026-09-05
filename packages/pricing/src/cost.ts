import { resolvePricingEntry, resolvePricingRevisionEntry } from "./aliases";
import type { CostMode, CostResolution, ContextPricingTier, ModelPricing, PricingMap, PricingRevision, PricingSchedule } from "./types";

export const COST_CALCULATION_VERSION = "cost-v2";

const CODEX_AUTO_REVIEW_MODELS = [
  ["2026-04-23", "gpt-5.5"],
  ["2026-03-05", "gpt-5.4"],
  ["2026-02-05", "gpt-5.3-codex"],
  ["2025-12-11", "gpt-5.2-codex"],
  ["2025-11-13", "gpt-5.1-codex"],
  ["2025-09-15", "gpt-5-codex"],
  ["2025-08-07", "gpt-5"],
] as const;

export interface ResolveCostArgs {
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cacheCreation1hTokens?: number;
  isFast?: boolean;
  providedCostUsd?: number | null;
  pricing: PricingMap;
  mode?: CostMode;
}

type Rates = { input: number; output: number; cacheRead?: number; cacheCreate?: number; cacheCreate1h?: number };
export type CostBreakdown = {
  contextTokens: number;
  ratesPerMillion: Rates;
  componentsUsd: { input: number; output: number; cacheRead: number; cacheCreate: number; cacheCreate1h: number };
  totalUsd: number;
};

/** Context tiers apply to the entire request, including output, not just the
 * tokens beyond a threshold. inputTokens already excludes cache buckets. */
export function calculateTokenCost(a: Omit<ResolveCostArgs, "pricing">, p: ModelPricing): CostBreakdown | null {
  const quantities = [a.inputTokens, a.outputTokens, a.cacheReadTokens, a.cacheCreationTokens, a.cacheCreation1hTokens ?? 0];
  if (quantities.some((value) => !Number.isSafeInteger(value) || value < 0)) return null;
  const contextTokens = a.inputTokens + a.cacheReadTokens + a.cacheCreationTokens;
  const anthropic = /(?:^|[./])claude[-.]/.test(a.model ?? "");
  const gemini = /(?:^|[./])gemini-/.test(a.model ?? "");
  const rates: Rates = {
    input: p.inputPerM,
    output: p.outputPerM,
    cacheRead: p.cacheReadPerM ?? (anthropic ? p.inputPerM * 0.1 : undefined),
    cacheCreate: p.cacheCreatePerM ?? (anthropic ? p.inputPerM * 1.25 : undefined),
    cacheCreate1h: p.cacheCreate1hPerM ?? (anthropic ? p.inputPerM * 2 : undefined),
  };
  const tiers: ContextPricingTier[] = [...(p.contextTiers ?? [])];
  if (!tiers.some((tier) => tier.aboveTokens === 200_000) && (p.inputAbove200kPerM != null || p.outputAbove200kPerM != null)) {
    tiers.push({ aboveTokens: 200_000, inputPerM: p.inputAbove200kPerM, outputPerM: p.outputAbove200kPerM });
  }
  for (const tier of tiers.sort((left, right) => left.aboveTokens - right.aboveTokens)) {
    if (contextTokens <= tier.aboveTokens) continue;
    const previousInput = rates.input;
    rates.input = tier.inputPerM ?? rates.input;
    rates.output = tier.outputPerM ?? rates.output;
    const scale = previousInput > 0 ? rates.input / previousInput : 1;
    // Older snapshots lack explicit long-context cache rates. Only documented
    // Claude/Gemini cache ratios may supply this fallback; other models fail closed.
    const cacheFallback = (value: number | undefined) =>
      scale === 1 ? value : (anthropic || gemini) && value != null ? value * scale : undefined;
    rates.cacheRead = tier.cacheReadPerM ?? cacheFallback(rates.cacheRead);
    rates.cacheCreate = tier.cacheCreatePerM ?? cacheFallback(rates.cacheCreate);
    rates.cacheCreate1h = tier.cacheCreate1hPerM ?? cacheFallback(rates.cacheCreate1h);
  }
  const oneHour = Math.min(a.cacheCreation1hTokens ?? 0, a.cacheCreationTokens);
  const units = { input: a.inputTokens, output: a.outputTokens, cacheRead: a.cacheReadTokens, cacheCreate: a.cacheCreationTokens - oneHour, cacheCreate1h: oneHour };
  const multiplier = a.isFast ? p.fastMultiplier : 1;
  // A persisted default of 1 is not evidence of a fast-mode tariff.
  if (a.isFast && (multiplier == null || multiplier <= 1)) return null;
  if (multiplier == null || !Number.isFinite(multiplier) || multiplier <= 0) return null;
  const components = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, cacheCreate1h: 0 };
  for (const key of Object.keys(units) as Array<keyof typeof units>) {
    const rate = rates[key];
    if (units[key] === 0) continue;
    if (rate == null || !Number.isFinite(rate) || rate < 0) return null;
    components[key] = units[key] * rate * multiplier / 1_000_000;
  }
  const totalUsd = Object.values(components).reduce((sum, value) => sum + value, 0);
  return Number.isFinite(totalUsd) ? { contextTokens, ratesPerMillion: rates, componentsUsd: components, totalUsd } : null;
}

/** Compatibility API: callers needing confidence/provenance use explainCostAt. */
export function resolveCost(a: ResolveCostArgs): number {
  const mode = a.mode ?? "auto";
  if (mode === "display") return a.providedCostUsd ?? 0;
  if (mode === "auto" && a.providedCostUsd != null) return a.providedCostUsd;
  const entry = resolvePricingEntry(a.model, a.pricing);
  return entry ? calculateTokenCost({ ...a, model: entry.modelId }, entry.pricing)?.totalUsd ?? 0 : 0;
}

type ResolveAtArgs = Omit<ResolveCostArgs, "pricing"> & {
  occurredAt: Date;
  schedule: PricingSchedule;
  providerKey?: string | null;
  logAdapter?: string | null;
};

export type CostExplanation = {
  resolution: CostResolution;
  calculationVersion: typeof COST_CALCULATION_VERSION;
  pricingModel: string | null;
  modelMatch: "exact" | "normalized" | "inferred" | "unknown";
  reason: "missing_price" | "missing_rate" | "inferred_model" | "session_context_unavailable" | "cache_ttl_unavailable" | null;
  breakdown: CostBreakdown | null;
};

export function explainCostAt(args: ResolveAtArgs): CostExplanation {
  const occurredOn = args.occurredAt.toISOString().slice(0, 10);
  const pricingModel = args.model === "codex-auto-review"
    ? CODEX_AUTO_REVIEW_MODELS.find(([releasedOn]) => occurredOn >= releasedOn)?.[1] ?? "gpt-5"
    : args.model == null && args.providerKey === "codex" && args.logAdapter === "codex"
      ? "gpt-5" : args.model;
  const entry = resolvePricingRevisionEntry(pricingModel, args.schedule);
  let selected: PricingRevision | undefined;
  for (const revision of entry?.value ?? []) {
    if (revision.effectiveAt <= args.occurredAt && (revision.validUntil == null || args.occurredAt < revision.validUntil)
      && (!selected || revision.effectiveAt >= selected.effectiveAt)) selected = revision;
  }
  let modelMatch = pricingModel !== args.model ? "inferred" as const : entry?.match ?? "unknown" as const;
  if (selected?.sourceModelId && modelMatch !== "inferred") {
    modelMatch = resolvePricingRevisionEntry(args.model, new Map([[selected.sourceModelId, [selected]]]))?.match ?? "inferred";
  }
  const base = { calculationVersion: COST_CALCULATION_VERSION, pricingModel: selected?.modelId ?? null, modelMatch } as const;
  const unpriced: CostResolution = { costUsd: 0, pricingRevisionId: null, status: "unpriced" };
  if (!selected) return { ...base, resolution: unpriced, reason: "missing_price", breakdown: null };
  const breakdown = calculateTokenCost({ ...args, model: selected.sourceModelId ?? selected.modelId }, selected.pricing);
  if (!breakdown) return { ...base, resolution: { ...unpriced, pricingRevisionId: selected.id }, reason: "missing_rate", breakdown: null };
  const reason = modelMatch === "inferred" ? "inferred_model"
    : selected.pricing.contextScope === "session" ? "session_context_unavailable"
    : args.cacheCreationTokens > 0 && args.cacheCreation1hTokens == null ? "cache_ttl_unavailable" : null;
  return {
    ...base, reason, breakdown,
    resolution: { costUsd: breakdown.totalUsd, pricingRevisionId: selected.id, status: reason ? "estimated" : "priced" },
  };
}

export function resolveCostAt(args: ResolveAtArgs): CostResolution {
  return explainCostAt(args).resolution;
}
