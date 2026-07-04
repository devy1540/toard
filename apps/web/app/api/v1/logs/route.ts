import type { UsageEvent } from "@toard/core";
import {
  type FlatLogRecord,
  identifyProvider,
  normalizers,
  parseOtlpLogs,
} from "@toard/ingest";
import { resolveCost } from "@toard/pricing";
import { authenticateIngestToken, loadProviders } from "@/lib/ingest-auth";
import { getPricingMap } from "@/lib/pricing";
import { getStorage } from "@/lib/storage";
import { hostFromResourceAttrs, sanitizeAttrs } from "@/lib/sanitize";

// OTLP/JSON 수신 (ADR-001). shim 의 OTEL_EXPORTER_OTLP_ENDPOINT=<base>/api 가 /v1/logs 로 도달.
export async function POST(req: Request): Promise<Response> {
  // 1. 인증 — 토큰 user_id 가 SSOT (§10.1)
  const userId = await authenticateIngestToken(req.headers.get("authorization"));
  if (!userId) return new Response("unauthorized", { status: 401 });

  // 2. 파싱 후 프롬프트 제거 (raw 저장 전 — §10.3). attrs·resourceAttrs 양쪽을 평탄화 후 정제.
  const records = parseOtlpLogs(await req.json());
  for (const r of records) {
    r.attrs = sanitizeAttrs(r.attrs);
    r.resourceAttrs = sanitizeAttrs(r.resourceAttrs);
  }
  if (records.length === 0) {
    return Response.json({ inserted: 0, deduped: 0 });
  }

  const [providers, pricing] = await Promise.all([loadProviders(), getPricingMap()]);
  const storage = getStorage();

  // provider 식별 (§4.4) — 배치 내 혼재 가능하므로 레코드별 그룹핑
  const byProvider = new Map<string, FlatLogRecord[]>();
  for (const r of records) {
    const key = identifyProvider(r, providers);
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
  const failed: string[] = [];
  for (const [providerKey, recs] of byProvider) {
    // 프로바이더 그룹별로 격리 — 한 그룹 실패가 다른 그룹·이미 저장분을 무효화하지 않도록
    try {
      // 3. raw 보존
      await storage.saveRawEvent(providerKey, recs);

      const normalizer = normalizers[providerKey];
      if (!normalizer) continue;

      // 컴퓨터별 구분(§design-host-breakdown): normalize 후엔 원본 레코드 연결이 끊기므로
      // 여기서 그룹 recs 의 resourceAttrs(toard.host / host.name)를 읽어 이벤트에 부착.
      // 한 provider 그룹 = 한 머신(한 POST=한 머신, ADR-001)이라 그룹 대표값이 곧 host.
      const host = hostFromResourceAttrs(recs);

      // 4. 정규화 → 5. 비용 (정규화와 비용은 별도 단계 — §5.5)
      const normalized = normalizer.normalize(recs, { userId });
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
        costUsd: resolveCost({
          model: u.model,
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          cacheReadTokens: u.cacheReadTokens,
          cacheCreationTokens: u.cacheCreationTokens,
          isFast: u.isFast,
          providedCostUsd: u.providedCostUsd,
          pricing,
        }),
      }));

      // 6. 멱등 저장 + 당일 Mart 증분
      const res = await storage.saveUsageEvents(events);
      inserted += res.inserted;
      deduped += res.deduped;
    } catch (e) {
      failed.push(providerKey);
      console.error(`ingest: provider ${providerKey} 처리 실패`, e);
    }
  }

  return Response.json({ inserted, deduped, ...(failed.length > 0 ? { failed } : {}) });
}
