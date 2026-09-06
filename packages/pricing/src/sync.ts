import type { ContextPricingTier, ModelPricing, PricingMap, PricingDetails } from "./types";

const PER_TOKEN_TO_PER_M = 1_000_000;

/** LiteLLM JSON 항목(부분) — 단위는 per-token */
interface LiteLLMEntry {
  [key: string]: unknown;
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
  input_cost_per_token_above_200k_tokens?: number;
  output_cost_per_token_above_200k_tokens?: number;
}

function perM(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value * PER_TOKEN_TO_PER_M : undefined;
}

export function pricingDetails(pricing: ModelPricing): PricingDetails {
  return {
    ...(pricing.contextTiers?.length ? { contextTiers: pricing.contextTiers.map((tier) => ({
      aboveTokens: tier.aboveTokens,
      ...(tier.inputPerM != null ? { inputPerM: tier.inputPerM } : {}),
      ...(tier.outputPerM != null ? { outputPerM: tier.outputPerM } : {}),
      ...(tier.cacheReadPerM != null ? { cacheReadPerM: tier.cacheReadPerM } : {}),
      ...(tier.cacheCreatePerM != null ? { cacheCreatePerM: tier.cacheCreatePerM } : {}),
      ...(tier.cacheCreate1hPerM != null ? { cacheCreate1hPerM: tier.cacheCreate1hPerM } : {}),
    })).sort((a, b) => a.aboveTokens - b.aboveTokens) } : {}),
    ...(pricing.cacheCreate1hPerM != null ? { cacheCreate1hPerM: pricing.cacheCreate1hPerM } : {}),
    ...(pricing.contextScope ? { contextScope: pricing.contextScope } : {}),
  };
}

function detailsFromLiteLLM(model: string, entry: LiteLLMEntry): PricingDetails {
  const tiers = new Map<number, ContextPricingTier>();
  const fields = {
    input_cost_per_token: "inputPerM",
    output_cost_per_token: "outputPerM",
    cache_read_input_token_cost: "cacheReadPerM",
    cache_creation_input_token_cost: "cacheCreatePerM",
    cache_creation_input_token_cost_above_1hr: "cacheCreate1hPerM",
  } as const;
  for (const [key, value] of Object.entries(entry)) {
    const match = key.match(/^(.*)_above_(\d+)k_tokens$/);
    const field = match ? fields[match[1] as keyof typeof fields] : undefined;
    const rate = perM(value);
    if (!match || !field || rate == null) continue;
    const aboveTokens = Number(match[2]) * 1000;
    if (!Number.isSafeInteger(aboveTokens) || aboveTokens <= 0) continue;
    const tier = tiers.get(aboveTokens) ?? { aboveTokens };
    tier[field] = rate;
    tiers.set(aboveTokens, tier);
  }
  const oneHour = perM(entry.cache_creation_input_token_cost_above_1hr);
  return {
    ...(tiers.size ? { contextTiers: [...tiers.values()].sort((a, b) => a.aboveTokens - b.aboveTokens) } : {}),
    ...(oneHour != null ? { cacheCreate1hPerM: oneHour } : {}),
    // Official GPT-5.4/5.5 pricing is session-scoped; request-only logs remain estimates.
    ...(/(?:^|\/)gpt-5\.(?:4|5)(?:-pro)?(?:-\d{4}-\d{2}-\d{2})?$/.test(model) ? { contextScope: "session" as const } : {}),
  };
}

/** LiteLLM(per-token) → 내부 per-million 으로 변환 (zeude/day1co 와 동일 단위) */
export function fromLiteLLM(raw: Record<string, LiteLLMEntry>): PricingMap {
  const map: PricingMap = new Map();
  for (const [model, e] of Object.entries(raw)) {
    if (
      e == null || typeof e !== "object" ||
      perM(e.input_cost_per_token) == null ||
      perM(e.output_cost_per_token) == null
    ) {
      continue;
    }
    const p: ModelPricing = {
      inputPerM: perM(e.input_cost_per_token)!,
      outputPerM: perM(e.output_cost_per_token)!,
      ...detailsFromLiteLLM(model, e),
    };
    if (typeof e.cache_read_input_token_cost === "number") {
      p.cacheReadPerM = e.cache_read_input_token_cost * PER_TOKEN_TO_PER_M;
    }
    if (typeof e.cache_creation_input_token_cost === "number") {
      p.cacheCreatePerM = e.cache_creation_input_token_cost * PER_TOKEN_TO_PER_M;
    }
    if (typeof e.input_cost_per_token_above_200k_tokens === "number") {
      p.inputAbove200kPerM = e.input_cost_per_token_above_200k_tokens * PER_TOKEN_TO_PER_M;
    }
    if (typeof e.output_cost_per_token_above_200k_tokens === "number") {
      p.outputAbove200kPerM = e.output_cost_per_token_above_200k_tokens * PER_TOKEN_TO_PER_M;
    }
    map.set(model, p);
  }
  return map;
}

/**
 * LiteLLM 가격 동기화 (설계 §6.2). 10s 타임아웃.
 * fetch 실패 또는 0건 파싱이면 throw → 호출측(cron)이 마지막 스냅샷 유지 (검토 A-9 가드).
 */
export async function fetchLiteLLMPricing(url: string): Promise<PricingMap> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`LiteLLM fetch failed: ${res.status}`);
  const raw = (await res.json()) as Record<string, LiteLLMEntry>;
  const map = fromLiteLLM(raw);
  if (map.size === 0) {
    throw new Error("LiteLLM parsed 0 models — keep last snapshot");
  }
  return map;
}
