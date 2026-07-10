import type { FinalizedUsageEvent, SaveResult, UsageEvent } from "@toard/core";
import { parseShimUserAgent, parseUsageEventsBody, WireParseError } from "@toard/core";
import { recordShimVersions } from "@/lib/host-shims";
import { authenticateIngestToken, loadProviders } from "@/lib/ingest-auth";
import { getPricingSchedule } from "@/lib/pricing";
import { sanitizeHost } from "@/lib/sanitize";
import { getStorage } from "@/lib/storage";
import { recordTokenHost } from "@/lib/tokens";
import { finalizeUsageEvents } from "@/lib/usage-finalization";

// 정규화 UsageEvent[] 수신 — shim 로컬 로그 pull 경로 (설계 §5.6, ADR-002).
// OTLP(/v1/logs)와 달리 shim 이 이미 정규화했으므로 raw 저장이 없고,
// 이후 비용·저장 경로는 otel 경로와 완전히 공유한다.
const MAX_BODY_BYTES = 4 * 1024 * 1024; // 배치 상한 4MB (§5.6)

type EventsPostDeps = {
  authenticateIngestToken: typeof authenticateIngestToken;
  loadProviders: typeof loadProviders;
  getPricingSchedule: typeof getPricingSchedule;
  saveUsageEvents(events: FinalizedUsageEvent[]): Promise<SaveResult>;
  recordTokenHost: typeof recordTokenHost;
  recordShimVersions: typeof recordShimVersions;
  now(): Date;
};

const defaultEventsPostDeps: EventsPostDeps = {
  authenticateIngestToken,
  loadProviders,
  getPricingSchedule,
  saveUsageEvents: (events) => getStorage().saveUsageEvents(events),
  recordTokenHost,
  recordShimVersions,
  now: () => new Date(),
};

function createEventsPost(overrides: Partial<EventsPostDeps> = {}) {
  const deps: EventsPostDeps = { ...defaultEventsPostDeps, ...overrides };
  return (req: Request) => postEvents(req, deps);
}

async function postEvents(req: Request, deps: EventsPostDeps): Promise<Response> {
  const receivedAt = deps.now();
  // 1. 인증 — 토큰 user_id 가 SSOT, 본문 userId 는 무시 (§10.1)
  const auth = await deps.authenticateIngestToken(req.headers.get("authorization"));
  if (!auth) return new Response("unauthorized", { status: 401 });

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
    return Response.json({ inserted: 0, deduped: 0, expired: 0 });
  }

  // 3. provider 실재 검증 — shim 이 명시한 provider_key 는 신뢰하되 등록된 것이어야 함 (§4.4)
  const providers = await deps.loadProviders();
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
    return Response.json({ inserted: 0, deduped: 0, expired: 0 });
  }

  // 4. 서버 권위 확정 — userId·비용·가격 revision을 이벤트 시각 기준으로 채운다.
  const schedule = await deps.getPricingSchedule();
  const sanitized = gated.map((event) => ({
    ...event,
    // host 는 클라이언트 제공값이라 저장 전 살균(제어문자·255자, §design-host-breakdown)
    host: sanitizeHost(event.host),
  }));
  const finalized = finalizeUsageEvents(
    sanitized,
    auth.userId,
    schedule,
    { mode: "calculate" },
    receivedAt,
  );

  // 5. 멱등 저장 + 당일 Mart 증분 — dedupKey 는 shim 생성 값 신뢰(멱등이라 무해, §4.4)
  const res = await deps.saveUsageEvents(finalized.events);
  try {
    await deps.recordTokenHost(auth.tokenId, sanitized.map((e) => e.host));
  } catch {
    // 토큰 관리용 관측 메타데이터 — 수집을 막지 않는다
  }

  // 6. 부수 기록: User-Agent 의 shim 버전을 기기별로 남김(host_shims, 버전 관측).
  // 한 배치는 한 기기에서 오므로 배치 내 host 전부에 귀속. 실패해도 수집 응답엔 영향 없음.
  const shimVersion = parseShimUserAgent(req.headers.get("user-agent"));
  if (shimVersion) {
    try {
      await deps.recordShimVersions(auth.userId, shimVersion, sanitized.map((e) => e.host));
    } catch {
      // 관측 부가 경로 — 수집을 막지 않는다
    }
  }

  return Response.json({ ...res, expired: finalized.expired });
}

export const POST = Object.assign(createEventsPost(), {
  withDependencies: createEventsPost,
});
