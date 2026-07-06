// shim ↔ 서버 버전 계약. shim 이 수집 요청의 User-Agent 헤더로 자기 버전을
// 알리고(`toard-shim/<semver>`), 서버가 이를 파싱해 기기별로 기록·비교한다.
// 와이어 본문과 무관한 HTTP 헤더 경로라 구버전 서버·shim 어느 쪽에도 무해(additive).

const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const SHIM_UA_RE = /^toard-shim\/(\d+\.\d+\.\d+)$/;

/** `toard-shim/0.5.0` → `0.5.0`. 그 외(부재·타 클라이언트·형식 불일치)는 null */
export function parseShimUserAgent(ua: string | null | undefined): string | null {
  if (!ua) return null;
  const m = SHIM_UA_RE.exec(ua.trim());
  return m?.[1] ?? null;
}

export function isSemver(v: string): boolean {
  return SEMVER_RE.test(v);
}

/**
 * "v0.5.0" → "0.5.0" 정규화. semver 가 아니게 되는 입력(예: "main", "v2beta")은 원문 유지.
 * docker metadata-action 등 태그명을 그대로 넘기는 경로가 있어도 비교가 깨지지 않게 방어.
 */
export function normalizeVersion(v: string): string {
  const stripped = v.startsWith("v") ? v.slice(1) : v;
  return isSemver(stripped) ? stripped : v;
}

/** 3-부분 semver 수치 비교 (a<b → 음수). 유효 semver 전제 — isSemver 로 먼저 거를 것 */
export function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i]! - pb[i]!;
  }
  return 0;
}

/**
 * "업데이트 필요" 판정 — 둘 다 유효 semver 이고 shim < server 일 때만 true.
 * 개발 빌드(0.0.0)와 비 semver(예: main 브랜치 이미지)는 판정 제외.
 */
export function isShimOutdated(shimVersion: string, serverVersion: string): boolean {
  if (!isSemver(shimVersion) || !isSemver(serverVersion)) return false;
  if (shimVersion === "0.0.0" || serverVersion === "0.0.0") return false;
  return compareSemver(shimVersion, serverVersion) < 0;
}

/** 표시용 — semver 는 v 접두, 개발 빌드(0.0.0)는 "dev", 그 외(예: "main")는 원문 */
export function formatVersion(v: string): string {
  if (v === "0.0.0") return "dev";
  return isSemver(v) ? `v${v}` : v;
}
