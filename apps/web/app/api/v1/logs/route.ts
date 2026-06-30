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
import { stripPrompts } from "@/lib/sanitize";

// OTLP/JSON 수신 (ADR-001). shim 의 OTEL_EXPORTER_OTLP_ENDPOINT=<base>/api 가 /v1/logs 로 도달.
export async function POST(req: Request): Promise<Response> {
  // 1. 인증 — 토큰 user_id 가 SSOT (§10.1)
  const userId = await authenticateIngestToken(req.headers.get("authorization"));
  if (!userId) return new Response("unauthorized", { status: 401 });

  // 2. 파싱 + 프롬프트 제거 (raw 저장 전 — §10.3)
  const payload = stripPrompts(await req.json());
  const records = parseOtlpLogs(payload);
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
  for (const [providerKey, recs] of byProvider) {
    // 3. raw 보존
    await storage.saveRawEvent(providerKey, recs);

    const normalizer = normalizers[providerKey];
    if (!normalizer) continue;

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
  }

  return Response.json({ inserted, deduped });
}
