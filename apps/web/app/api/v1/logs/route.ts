import type { FinalizedUsageEvent, SaveResult, UsageEvent } from "@toard/core";
import {
  type FlatLogRecord,
  type ProviderNormalizer,
  identifyProvider,
  normalizers,
  parseOtlpLogs,
} from "@toard/ingest";
import { authenticateIngestToken, loadProviders } from "@/lib/ingest-auth";
import { getPricingSchedule } from "@/lib/pricing";
import { getStorage } from "@/lib/storage";
import { hostFromResourceAttrs, sanitizeAttrs } from "@/lib/sanitize";
import { recordTokenHost } from "@/lib/tokens";
import { finalizeUsageEvents } from "@/lib/usage-finalization";

// OTLP/JSON 수신 (ADR-001). shim 의 OTEL_EXPORTER_OTLP_ENDPOINT=<base>/api 가 /v1/logs 로 도달.
type LogsPostDeps = {
  authenticateIngestToken: typeof authenticateIngestToken;
  loadProviders: typeof loadProviders;
  getPricingSchedule: typeof getPricingSchedule;
  parseOtlpLogs: typeof parseOtlpLogs;
  identifyProvider: typeof identifyProvider;
  normalizers: Record<string, ProviderNormalizer>;
  saveRawEvent(providerKey: string, payload: unknown): Promise<number>;
  saveUsageEvents(events: FinalizedUsageEvent[]): Promise<SaveResult>;
  recordTokenHost: typeof recordTokenHost;
  now(): Date;
};

const defaultLogsPostDeps: LogsPostDeps = {
  authenticateIngestToken,
  loadProviders,
  getPricingSchedule,
  parseOtlpLogs,
  identifyProvider,
  normalizers,
  saveRawEvent: (providerKey, payload) => getStorage().saveRawEvent(providerKey, payload),
  saveUsageEvents: (events) => getStorage().saveUsageEvents(events),
  recordTokenHost,
  now: () => new Date(),
};

function createLogsPost(overrides: Partial<LogsPostDeps> = {}) {
  const deps: LogsPostDeps = { ...defaultLogsPostDeps, ...overrides };
  return (req: Request) => postLogs(req, deps);
}

async function postLogs(req: Request, deps: LogsPostDeps): Promise<Response> {
  const receivedAt = deps.now();
  // 1. 인증 — 토큰 user_id 가 SSOT (§10.1)
  const auth = await deps.authenticateIngestToken(req.headers.get("authorization"));
  if (!auth) return new Response("unauthorized", { status: 401 });

  // 2. 파싱 후 프롬프트 제거 (raw 저장 전 — §10.3). attrs·resourceAttrs 양쪽을 평탄화 후 정제.
  const records = deps.parseOtlpLogs(await req.json());
  for (const r of records) {
    r.attrs = sanitizeAttrs(r.attrs);
    r.resourceAttrs = sanitizeAttrs(r.resourceAttrs);
  }
  if (records.length === 0) {
    return Response.json({ inserted: 0, deduped: 0, expired: 0 });
  }

  const [providers, schedule] = await Promise.all([
    deps.loadProviders(),
    deps.getPricingSchedule(),
  ]);

  // provider 식별 (§4.4) — 배치 내 혼재 가능하므로 레코드별 그룹핑
  const byProvider = new Map<string, FlatLogRecord[]>();
  for (const r of records) {
    const key = deps.identifyProvider(r, providers);
    if (!key) continue;
    let arr = byProvider.get(key);
    if (!arr) {
      arr = [];
      byProvider.set(key, arr);
    }
    arr.push(r);
  }

  let inserted = 0;
  let deduped = 0;
  let expired = 0;
  const failed: string[] = [];
  const hosts: Array<string | null> = [];
  for (const [providerKey, recs] of byProvider) {
    // 프로바이더 그룹별로 격리 — 한 그룹 실패가 다른 그룹·이미 저장분을 무효화하지 않도록
    try {
      // 3. raw 보존
      await deps.saveRawEvent(providerKey, recs);

      const normalizer = deps.normalizers[providerKey];
      if (!normalizer) continue;

      // 컴퓨터별 구분(§design-host-breakdown): normalize 후엔 원본 레코드 연결이 끊기므로
      // 여기서 그룹 recs 의 resourceAttrs(toard.host / host.name)를 읽어 이벤트에 부착.
      // 한 provider 그룹 = 한 머신(한 POST=한 머신, ADR-001)이라 그룹 대표값이 곧 host.
      const host = hostFromResourceAttrs(recs);
      hosts.push(host);

      // 4. 정규화 → 5. 이벤트 시각 기준 비용·가격 revision 확정
      const normalized = normalizer.normalize(recs, { userId: auth.userId });
      const events: UsageEvent[] = normalized.map((u) => ({
        dedupKey: u.dedupKey,
        providerKey: u.providerKey,
        userId: u.userId,
        sessionId: u.sessionId,
        model: u.model,
        ts: u.ts,
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        cacheReadTokens: u.cacheReadTokens,
        cacheCreationTokens: u.cacheCreationTokens,
        host,
        costUsd: 0,
      }));
      const priceHints = new Map(
        normalized.map((u) => [
          u.dedupKey,
          { providedCostUsd: u.providedCostUsd, isFast: u.isFast },
        ]),
      );
      const finalized = finalizeUsageEvents(
        events,
        auth.userId,
        schedule,
        {
          mode: "auto",
          priceHints,
        },
        receivedAt,
      );
      expired += finalized.expired;

      // 6. 멱등 저장 + 당일 Mart 증분
      const res = await deps.saveUsageEvents(finalized.events);
      inserted += res.inserted;
      deduped += res.deduped;
    } catch (e) {
      failed.push(providerKey);
      console.error(`ingest: provider ${providerKey} 처리 실패`, e);
    }
  }
  try {
    await deps.recordTokenHost(auth.tokenId, hosts);
  } catch {
    // 토큰 관리용 관측 메타데이터 — 수집을 막지 않는다
  }

  return Response.json({ inserted, deduped, expired, ...(failed.length > 0 ? { failed } : {}) });
}

export const POST = Object.assign(createLogsPost(), {
  withDependencies: createLogsPost,
});
