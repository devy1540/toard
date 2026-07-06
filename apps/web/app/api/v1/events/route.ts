import type { UsageEvent } from "@toard/core";
import { parseUsageEventsBody, WireParseError } from "@toard/core";
import { resolveCost } from "@toard/pricing";
import { authenticateIngestToken, loadProviders } from "@/lib/ingest-auth";
import { getPricingMap } from "@/lib/pricing";
import { sanitizeHost } from "@/lib/sanitize";
import { getStorage } from "@/lib/storage";

// 정규화 UsageEvent[] 수신 — shim 로컬 로그 pull 경로 (설계 §5.6, ADR-002).
// OTLP(/v1/logs)와 달리 shim 이 이미 정규화했으므로 raw 저장이 없고,
// 이후 비용·저장 경로는 otel 경로와 완전히 공유한다.
const MAX_BODY_BYTES = 4 * 1024 * 1024; // 배치 상한 4MB (§5.6)

export async function POST(req: Request): Promise<Response> {
  // 1. 인증 — 토큰 user_id 가 SSOT, 본문 userId 는 무시 (§10.1)
  const userId = await authenticateIngestToken(req.headers.get("authorization"));
  if (!userId) return new Response("unauthorized", { status: 401 });

  const text = await req.text();
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
    return new Response("payload too large (max 4MB)", { status: 413 });
  }

  // 2. 와이어 계약 검증 (core/wire — 골든 fixture 로 shim 미러와 동기화)
  let events: UsageEvent[];
  try {
    events = parseUsageEventsBody(JSON.parse(text));
  } catch (e) {
    const msg = e instanceof WireParseError ? e.message : "본문이 유효한 JSON 이 아닙니다";
    return new Response(msg, { status: 400 });
  }
  if (events.length === 0) {
    return Response.json({ inserted: 0, deduped: 0 });
  }

  // 3. provider 실재 검증 — shim 이 명시한 provider_key 는 신뢰하되 등록된 것이어야 함 (§4.4)
  const providers = await loadProviders();
  const known = new Set(providers.map((p) => p.key));
  const unknown = [...new Set(events.map((e) => e.providerKey))].filter((k) => !known.has(k));
  if (unknown.length > 0) {
    return new Response(`등록되지 않은 provider: ${unknown.join(", ")}`, { status: 400 });
  }

  // 3b. 대칭 게이트(design-usage-pull §5.2 ③) — "provider 당 단일 소스".
  // collection_method='logfile' provider 이벤트만 저장하고, 'otel'(experimental 로 OTLP 를
  // 되켠 provider)의 pull 이벤트는 드롭한다. /v1/logs 의 identifyProvider 게이트와 대칭이라
  // 클라가 무엇을 보내든 provider 당 한 소스만 저장돼 이중집계가 구조적으로 불가능하다.
  // (기본 경로 provider 는 모두 logfile 이라 무영향. 드롭분은 200 으로 응답해 shim 커서가 전진.)
  const logfile = new Set(
    providers.filter((p) => p.collectionMethod === "logfile").map((p) => p.key),
  );
  const gated = events.filter((e) => logfile.has(e.providerKey));
  if (gated.length === 0) {
    return Response.json({ inserted: 0, deduped: 0 });
  }

  // 4. 서버 권위 확정 — userId=토큰, costUsd=pricing 강제 계산(본문 값·제공값 무시, §5.6 신뢰경계)
  const pricing = await getPricingMap();
  const finalized: UsageEvent[] = gated.map((e) => ({
    ...e,
    userId,
    // host 는 클라이언트 제공값이라 저장 전 살균(제어문자·255자, §design-host-breakdown)
    host: sanitizeHost(e.host),
    costUsd: resolveCost({
      model: e.model,
      inputTokens: e.inputTokens,
      outputTokens: e.outputTokens,
      cacheReadTokens: e.cacheReadTokens,
      cacheCreationTokens: e.cacheCreationTokens,
      // 캐시생성 1h 분량(§리스크 B) — pull(claude) 경로만 채움. 1h=input×2 차등 가격.
      cacheCreation1hTokens: e.cacheCreation1hTokens,
      pricing,
      mode: "calculate",
    }),
  }));

  // 5. 멱등 저장 + 당일 Mart 증분 — dedupKey 는 shim 생성 값 신뢰(멱등이라 무해, §4.4)
  const res = await getStorage().saveUsageEvents(finalized);
  return Response.json(res);
}
