import type { ModelPricing, PricingMap } from "./types";

const VENDOR_PREFIXES = ["us.anthropic.", "anthropic.", "openai/", "bedrock/"];
const DATE_SUFFIX = /-(\d{8})$/; // 8자리 YYYYMMDD (ccusage MODEL_DATE_SUFFIX_DIGITS=8)

/**
 * 모델 가격 조회 (설계 §6.4).
 * 풀 ID 직접 조회 우선 → 미스 시에만 폴백(프리픽스 strip → 8자리 날짜 제거 → fuzzy).
 */
export function resolvePricing(
  model: string | null,
  pricing: PricingMap,
): ModelPricing | undefined {
  if (!model) return undefined;

  // 1) 풀 ID 우선 (LiteLLM 키는 날짜 포함 풀 ID)
  const direct = pricing.get(model);
  if (direct) return direct;

  // 2) 벤더 프리픽스 strip
  let key = model;
  for (const pre of VENDOR_PREFIXES) {
    if (key.startsWith(pre)) {
      key = key.slice(pre.length);
      break;
    }
  }
  const afterPrefix = pricing.get(key);
  if (afterPrefix) return afterPrefix;

  // 3) 8자리 날짜 접미사 제거
  const stripped = key.replace(DATE_SUFFIX, "");
  if (stripped !== key) {
    const afterDate = pricing.get(stripped);
    if (afterDate) return afterDate;
  }

  // 4) 부분문자열 fuzzy — 가장 긴 매칭 키 우선
  let best: ModelPricing | undefined;
  let bestLen = 0;
  for (const [k, v] of pricing) {
    if ((key.includes(k) || k.includes(stripped)) && k.length > bestLen) {
      best = v;
      bestLen = k.length;
    }
  }
  return best;
}
