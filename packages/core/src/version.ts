// shim ↔ 서버 버전 계약. shim 이 수집 요청의 User-Agent 헤더로 자기 버전을
// 알리고(`toard-shim/<semver>`), 서버가 이를 파싱해 기기별로 기록·비교한다.
// 와이어 본문과 무관한 HTTP 헤더 경로라 구버전 서버·shim 어느 쪽에도 무해(additive).

const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const SHIM_UA_RE = /^toard-shim\/(\d+\.\d+\.\d+)$/;

/** 2026년 무접두 공개 버전 재시작 기준선. 기존 v* 릴리스는 레거시 계열로 보존한다. */
export const PUBLIC_VERSION_BASELINE = "0.0.1";

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
 * toard 릴리스의 시간 순서를 비교한다.
 *
 * 공개 버전은 무접두 0.0.1에서 재시작했으므로 일반 SemVer 수치 순서와 달리
 * 레거시 v0.1.0~v0.x 계열 < 무접두 0.0.x 공개 계열 < 무접두 1.x 이상 순서다.
 * 같은 계열 안에서는 일반 SemVer 순서를 유지한다.
 */
export function compareToardVersions(a: string, b: string): number {
  if (a === "0.0.0" || b === "0.0.0") return compareSemver(a, b);
  const epoch = (version: string): number => {
    const [major, minor] = version.split(".").map(Number);
    if (major! >= 1) return 2;
    if (minor === 0) return 1;
    return 0;
  };
  const epochDifference = epoch(a) - epoch(b);
  return epochDifference === 0 ? compareSemver(a, b) : epochDifference;
}

/** 무접두 0.0.1 이후 공개 계열 또는 향후 무접두 1.x 이상인지 판정한다. */
export function isPublicReleaseVersion(version: string): boolean {
  if (!isSemver(version) || version === "0.0.0") return false;
  const [major, minor] = version.split(".").map(Number);
  return major! >= 1 || minor === 0;
}

/**
 * "업데이트 필요" 판정 — 둘 다 유효 semver 이고 shim이 서버보다 오래됐을 때만 true.
 * 개발 빌드(0.0.0)와 비 semver(예: main 브랜치 이미지)는 판정 제외.
 */
export function isShimOutdated(shimVersion: string, serverVersion: string): boolean {
  if (!isSemver(shimVersion) || !isSemver(serverVersion)) return false;
  if (shimVersion === "0.0.0" || serverVersion === "0.0.0") return false;
  return compareToardVersions(shimVersion, serverVersion) < 0;
}

/** 표시용 — 레거시는 v 접두, 새 공개 버전은 무접두, 개발 빌드는 "dev"로 표시한다. */
export function formatVersion(v: string): string {
  if (v === "0.0.0") return "dev";
  if (!isSemver(v)) return v;
  return isPublicReleaseVersion(v) ? v : `v${v}`;
}
