export type CostMode = "display" | "auto" | "calculate";

/** 가격 단위: per-million USD (LiteLLM per-token → ×1e6 변환해 저장. 설계 ADR-004) */
export interface ModelPricing {
  inputPerM: number;
  outputPerM: number;
  cacheReadPerM?: number;
  cacheCreatePerM?: number;
  inputAbove200kPerM?: number;
  outputAbove200kPerM?: number;
  /** LiteLLM 부재 → 수동 override 시드 (기본 1) */
  fastMultiplier?: number;
}

export type PricingMap = Map<string, ModelPricing>;
