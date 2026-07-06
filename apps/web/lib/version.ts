// 서버 자기 버전 — 빌드 시 이미지에 임베드(Dockerfile ARG TOARD_VERSION → ENV APP_VERSION).
// 로컬 dev·직접 빌드처럼 미주입이면 0.0.0(dev) 으로 취급해 구버전 비교에서 빠진다.
export function getServerVersion(): string {
  return process.env.APP_VERSION || "0.0.0";
}
