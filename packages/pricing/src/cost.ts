import { resolvePricing, resolvePricingRevisions } from "./aliases";
import type { CostMode, CostResolution, PricingMap, PricingRevision, PricingSchedule } from "./types";

const TIER_THRESHOLD = 200_000;
const CODEX_AUTO_REVIEW_MODELS = [
  ["2026-04-23", "gpt-5.5"],
  ["2026-03-05", "gpt-5.4"],
  ["2026-02-05", "gpt-5.3-codex"],
  ["2025-12-11", "gpt-5.2-codex"],
  ["2025-11-13", "gpt-5.1-codex"],
  ["2025-09-15", "gpt-5-codex"],
  ["2025-08-07", "gpt-5"],
] as const;

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
  /** cacheCreationTokens 중 1h TTL 분량(subset). 있으면 input×2 로 차등 가격(나머지 5m 는
   *  cacheCreatePerM≈input×1.25). 미제공(구 클라·OTLP)이면 0 → 전량 5m 로 계산(종전 동작). */
  cacheCreation1hTokens?: number;
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
 *  - 캐시생성 5m = cacheCreatePerM ?? input×1.25, 1h = input×2, 캐시읽기 = input×0.1 (Anthropic 표준·ccusage 동일)
 *  - 캐시는 200k tiered 미적용(설계 §6.3 의도적 차이)
 *  - inputTokens 는 이미 캐시 제외(UsageEvent 불변식)이므로 이중계상 없음
 */
export function resolveCost(a: ResolveCostArgs): number {
  const mode = a.mode ?? "auto";
  if (mode === "display") return a.providedCostUsd ?? 0;
  if (mode === "auto" && a.providedCostUsd != null) return a.providedCostUsd;

  const p = resolvePricing(a.model, a.pricing);
  if (!p) return 0; // 미상 모델: 0 (호출측이 경고 로깅)

  const cacheCreate5mBase = p.cacheCreatePerM ?? p.inputPerM * 1.25;
  const cacheCreate1hBase = p.inputPerM * 2; // 1h TTL 캐시생성 = input×2 (ccusage 동일)
  const cacheReadBase = p.cacheReadPerM ?? p.inputPerM * 0.1;

  // 캐시생성을 5m/1h 로 분리 가격. 1h 힌트 미제공이면 cc1h=0 → 전량 5m(종전 동작).
  // min 으로 1h ≤ total 방어(정상 데이터는 항상 성립: total = 5m + 1h).
  const cc1h = Math.min(a.cacheCreation1hTokens ?? 0, a.cacheCreationTokens);
  const cc5m = a.cacheCreationTokens - cc1h;

  const cost =
    tiered(a.inputTokens, p.inputPerM, p.inputAbove200kPerM) +
    tiered(a.outputTokens, p.outputPerM, p.outputAbove200kPerM) +
    (a.cacheReadTokens * cacheReadBase) / 1e6 +
    (cc5m * cacheCreate5mBase) / 1e6 +
    (cc1h * cacheCreate1hBase) / 1e6;

  return a.isFast ? cost * (p.fastMultiplier ?? 1) : cost;
}

export function resolveCostAt(
  args: Omit<ResolveCostArgs, "pricing"> & {
    occurredAt: Date;
    schedule: PricingSchedule;
    providerKey?: string | null;
    logAdapter?: string | null;
  },
): CostResolution {
  const occurredOn = args.occurredAt.toISOString().slice(0, 10);
  const pricingModel = args.model === "codex-auto-review"
    ? CODEX_AUTO_REVIEW_MODELS.find(([releasedOn]) => occurredOn >= releasedOn)?.[1] ?? "gpt-5"
    : args.model == null && args.providerKey === "codex" && args.logAdapter === "codex"
      ? "gpt-5"
      : args.model;
  const revisions = resolvePricingRevisions(pricingModel, args.schedule);
  let selected: PricingRevision | undefined;
  for (const revision of revisions ?? []) {
    const withinValidity = revision.validUntil == null || args.occurredAt < revision.validUntil;
    if (
      revision.effectiveAt <= args.occurredAt &&
      withinValidity &&
      (!selected || revision.effectiveAt >= selected.effectiveAt)
    ) {
      selected = revision;
    }
  }
  if (!selected) {
    return { costUsd: 0, pricingRevisionId: null, status: "unpriced" };
  }

  const { occurredAt: _occurredAt, schedule: _schedule, ...costArgs } = args;
  return {
    costUsd: resolveCost({
      ...costArgs,
      model: pricingModel,
      pricing: new Map([[selected.modelId, selected.pricing]]),
      // FinalizedUsageEvent의 provenance는 선택한 revision이므로 제공 비용으로 덮지 않는다.
      mode: "calculate",
    }),
    pricingRevisionId: selected.id,
    status: "priced",
  };
}
