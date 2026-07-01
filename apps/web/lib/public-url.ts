import { headers } from "next/headers";

/**
 * shim 이 향할 ingest 엔드포인트(base). OTEL SDK 가 `/v1/logs` 를 덧붙이므로 `.../api` 로 반환.
 *  - `TOARD_PUBLIC_URL` 설정 시 그것을 우선(프록시/외부 도메인).
 *  - 없으면 현재 요청 host 로 유추(브라우징 URL == 수집 URL 인 일반적 경우).
 */
export async function getIngestEndpoint(): Promise<string> {
  const override = process.env.TOARD_PUBLIC_URL;
  if (override) return `${override.replace(/\/+$/, "")}/api`;

  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const isLocal = host.startsWith("localhost") || host.startsWith("127.");
  const proto = h.get("x-forwarded-proto") ?? (isLocal ? "http" : "https");
  return `${proto}://${host}/api`;
}
