import { NextResponse, type NextRequest } from "next/server";
import { createHistoryCsp, HISTORY_CACHE_CONTROL } from "@/lib/history-response-policy";

export function middleware(request: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const csp = createHistoryCsp(nonce);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  response.headers.set("Cache-Control", HISTORY_CACHE_CONTROL);
  return response;
}

export const config = { matcher: ["/history/:path*"] };
