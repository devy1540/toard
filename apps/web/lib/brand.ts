// 사용자별 브랜드(액센트) 색 — 다크모드 토글과 같은 기기 단위 개인 설정.
// 쿠키(BRAND_COOKIE)에 프리셋 키를 저장하고, 루트 레이아웃이 <html data-brand> 로 반영해
// SSR 첫 페인트부터 적용된다. 실제 색 값은 globals.css 의 [data-brand=...] 프리셋 정의가 소유.

export const BRAND_COOKIE = "toard.brand";

/** 기본 프리셋 — data-brand 속성 없이 :root 기본값(coral)을 쓴다. */
export const DEFAULT_BRAND = "coral";

/**
 * 프리셋 8종 — 자유 컬러피커 대신 라이트/다크 양쪽에서 대비를 검증한 값만 제공.
 * (임의 색 입력은 배지·버튼 전경 대비가 깨질 수 있어 의도적으로 막는다)
 */
export const BRAND_PRESETS = ["coral", "amber", "green", "teal", "blue", "violet", "pink", "mono"] as const;
export type BrandPreset = (typeof BRAND_PRESETS)[number];

export function isBrandPreset(v: unknown): v is BrandPreset {
  return typeof v === "string" && (BRAND_PRESETS as readonly string[]).includes(v);
}

/** 스위처 스와치 표시용 대표색(라이트 기준 근사 hex) — 적용 값은 globals.css 가 소유 */
export const BRAND_SWATCHES: Record<BrandPreset, string> = {
  coral: "#e0653a",
  amber: "#d9930d",
  green: "#3f9d50",
  teal: "#2b9a8f",
  blue: "#3b82d6",
  violet: "#7c5ce0",
  pink: "#d24d8a",
  mono: "#3d3d3d",
};
