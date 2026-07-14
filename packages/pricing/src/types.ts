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

export interface PricingRevision {
  id: string;
  modelId: string;
  effectiveAt: Date;
  /** historical revision의 exclusive 종료 시각. 없으면 다음 revision 전까지 유효하다. */
  validUntil?: Date;
  pricing: ModelPricing;
}

export type PricingSchedule = Map<string, readonly PricingRevision[]>;

export type CostResolution = {
  costUsd: number;
  pricingRevisionId: string | null;
  status: "priced" | "unpriced";
};
