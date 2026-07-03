import type { UsageEvent } from "@toard/core";
import {
  type FlatMetricPoint,
  identifyProvider,
  metricsNormalizers,
  parseOtlpMetrics,
} from "@toard/ingest";
import { resolveCost } from "@toard/pricing";
import { authenticateIngestToken, loadProviders } from "@/lib/ingest-auth";
import { getPricingMap } from "@/lib/pricing";
import { getStorage } from "@/lib/storage";
import { sanitizeAttrs } from "@/lib/sanitize";

// OTLP/JSON metrics 수신 (ADR-001). Claude Code 2.x 는 토큰/비용을 api_request 로그가 아니라
// metrics(claude_code.token.usage·cost.usage)로 보내므로 /v1/logs 로는 잡히지 않는다.
// shim 의 OTEL_EXPORTER_OTLP_ENDPOINT=<base>/api 가 /v1/metrics 로 도달.
export async function POST(req: Request): Promise<Response> {
  // 1. 인증 — 토큰 user_id 가 SSOT (§10.1)
  const userId = await authenticateIngestToken(req.headers.get("authorization"));
  if (!userId) return new Response("unauthorized", { status: 401 });

  // 2. 파싱 후 정제 (raw 저장 전 — §10.3). metric 속성엔 프롬프트가 없지만 일관되게 정제.
  const points = parseOtlpMetrics(await req.json());
  for (const p of points) {
    p.attrs = sanitizeAttrs(p.attrs);
    p.resourceAttrs = sanitizeAttrs(p.resourceAttrs);
  }
  if (points.length === 0) {
    return Response.json({ inserted: 0, deduped: 0 });
  }

  const [providers, pricing] = await Promise.all([loadProviders(), getPricingMap()]);
  const storage = getStorage();

  // provider 식별 (§4.4) — 배치 내 혼재 가능하므로 포인트별 그룹핑
  const byProvider = new Map<string, FlatMetricPoint[]>();
  for (const p of points) {
    const key = identifyProvider(p, providers);
    if (!key) continue;
    let arr = byProvider.get(key);
    if (!arr) {
      arr = [];
      byProvider.set(key, arr);
    }
    arr.push(p);
  }

  let inserted = 0;
  let deduped = 0;
  const failed: string[] = [];
  for (const [providerKey, recs] of byProvider) {
    try {
      // 3. raw 보존
      await storage.saveRawEvent(providerKey, recs);

      const normalizer = metricsNormalizers[providerKey];
      if (!normalizer) continue;

      // 4. 정규화(세션 누적 스냅샷) → 5. 비용 (providedCostUsd=cost.usage 우선, 토큰 폴백)
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

      // 6. upsert(최신 누적) — 반복 export 는 갱신일 뿐 중복 아님
      const res = await storage.saveMetricUsageEvents(events);
      inserted += res.inserted;
      deduped += res.deduped;
    } catch (e) {
      failed.push(providerKey);
      console.error(`ingest(metrics): provider ${providerKey} 처리 실패`, e);
    }
  }

  return Response.json({ inserted, deduped, ...(failed.length > 0 ? { failed } : {}) });
}
