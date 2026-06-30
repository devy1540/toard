import type { ModelPricing, PricingMap } from "./types";

const PER_TOKEN_TO_PER_M = 1_000_000;

/** LiteLLM JSON 항목(부분) — 단위는 per-token */
interface LiteLLMEntry {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
}

/** LiteLLM(per-token) → 내부 per-million 으로 변환 (zeude/day1co 와 동일 단위) */
export function fromLiteLLM(raw: Record<string, LiteLLMEntry>): PricingMap {
  const map: PricingMap = new Map();
  for (const [model, e] of Object.entries(raw)) {
    if (
      typeof e.input_cost_per_token !== "number" ||
      typeof e.output_cost_per_token !== "number"
    ) {
      continue;
    }
    const p: ModelPricing = {
      inputPerM: e.input_cost_per_token * PER_TOKEN_TO_PER_M,
      outputPerM: e.output_cost_per_token * PER_TOKEN_TO_PER_M,
    };
    if (typeof e.cache_read_input_token_cost === "number") {
      p.cacheReadPerM = e.cache_read_input_token_cost * PER_TOKEN_TO_PER_M;
    }
    if (typeof e.cache_creation_input_token_cost === "number") {
      p.cacheCreatePerM = e.cache_creation_input_token_cost * PER_TOKEN_TO_PER_M;
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
