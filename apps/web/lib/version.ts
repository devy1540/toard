import { compareSemver, isSemver, normalizeVersion } from "@toard/core";

export const HISTORICAL_PRICING_MIN_READER_VERSION = "0.15.16";

// 서버 자기 버전 — 빌드 시 이미지에 임베드(Dockerfile ARG TOARD_VERSION → ENV APP_VERSION).
// 로컬 dev·직접 빌드처럼 미주입이면 0.0.0(dev) 으로 취급해 구버전 비교에서 빠진다.
// "v0.5.0" 처럼 v 접두가 들어와도 정규화 — semver 판정이 깨지면 구버전 경고가 전부 죽는다.
export function getServerVersion(): string {
  return normalizeVersion(process.env.APP_VERSION || "0.0.0");
}

/** bounded historical revision을 안전하게 읽을 수 있는 버전인지 readiness에 기록한다. */
export function supportsHistoricalPricingReader(version: string): boolean {
  const normalized = normalizeVersion(version);
  if (normalized === "0.0.0") return true;
  return isSemver(normalized) &&
    compareSemver(normalized, HISTORICAL_PRICING_MIN_READER_VERSION) >= 0;
}
