import { resolvePricing } from "./aliases";
import type { CostMode, PricingMap } from "./types";

const TIER_THRESHOLD = 200_000;

/**
 * 구간 누적 비용 (ccusage tiered_cost): 처음 200k 는 기본가, 초과분만 차등가.
 * 단위 per-million → /1e6.
 */
function tiered(tokens: number, basePerM: number, abovePerM?: number): number {
  if (abovePerM == null || tokens <= TIER_THRESHOLD) {
    return (tokens * basePerM) / 1e6;
  }
  return (TIER_THRESHOLD * basePerM + (tokens - TIER_THRESHOLD) * abovePerM) / 1e6;
}

export interface ResolveCostArgs {
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** api_request 의 speed 어트리뷰트가 'fast' 일 때 */
  isFast?: boolean;
  /** 프로바이더 제공 비용 (Claude 는 제공, Codex 는 없음) */
  providedCostUsd?: number | null;
  pricing: PricingMap;
  /** 기본 'auto' */
  mode?: CostMode;
}

/**
 * 토큰 → USD (설계 §6.3).
 *  - display: 제공값 그대로 / auto: 제공값 없으면 계산 / calculate: 강제 계산
 *  - 캐시생성 fallback = input×1.25, 캐시읽기 = input×0.1 (Anthropic 표준)
 *  - 캐시는 200k tiered 미적용(설계 §6.3 의도적 차이)
 *  - inputTokens 는 이미 캐시 제외(UsageEvent 불변식)이므로 이중계상 없음
 */
export function resolveCost(a: ResolveCostArgs): number {
  const mode = a.mode ?? "auto";
  if (mode === "display") return a.providedCostUsd ?? 0;
  if (mode === "auto" && a.providedCostUsd != null) return a.providedCostUsd;

  const p = resolvePricing(a.model, a.pricing);
  if (!p) return 0; // 미상 모델: 0 (호출측이 경고 로깅)

  const cacheCreateBase = p.cacheCreatePerM ?? p.inputPerM * 1.25;
  const cacheReadBase = p.cacheReadPerM ?? p.inputPerM * 0.1;

  const cost =
    tiered(a.inputTokens, p.inputPerM, p.inputAbove200kPerM) +
    tiered(a.outputTokens, p.outputPerM, p.outputAbove200kPerM) +
    (a.cacheReadTokens * cacheReadBase) / 1e6 +
    (a.cacheCreationTokens * cacheCreateBase) / 1e6;

  return a.isFast ? cost * (p.fastMultiplier ?? 1) : cost;
}
