import { createHash } from "node:crypto";
import { headers } from "next/headers";

/**
 * toard 공개 base URL(스킴+호스트, 끝 슬래시 없음).
 *  - `TOARD_PUBLIC_URL` 설정 시 우선(프록시/외부 도메인).
 *  - 없으면 현재 요청 host 로 유추(브라우징 URL == 수집 URL 인 일반적 경우).
 */
export async function getPublicBaseUrl(): Promise<string> {
  const override = process.env.TOARD_PUBLIC_URL;
  if (override) return override.replace(/\/+$/, "");

  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const isLocal = host.startsWith("localhost") || host.startsWith("127.");
  const proto = h.get("x-forwarded-proto") ?? (isLocal ? "http" : "https");
  return `${proto}://${host}`;
}

/** 브라우저가 실제로 보는 origin. ingest 공개 URL override와 의도적으로 분리한다. */
export async function getRequestOrigin(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const isLocal = host.startsWith("localhost") || host.startsWith("127.");
  const proto = h.get("x-forwarded-proto") ?? (isLocal ? "http" : "https");
  return new URL(`${proto}://${host}`).origin;
}

/** shim 이 향할 ingest 엔드포인트(base). OTEL SDK 가 `/v1/logs` 를 덧붙이므로 `.../api`. */
export async function getIngestEndpoint(): Promise<string> {
  return `${await getPublicBaseUrl()}/api`;
}

export function localShimTargetId(endpoint: string): string {
  const url = new URL(endpoint.trim());
  const path = url.pathname.replace(/\/+$/, "") || "/";
  url.pathname = path;
  const normalized = path === "/" ? url.toString().replace(/\/$/, "") : url.toString();
  return createHash("sha256").update(normalized).digest("hex");
}
