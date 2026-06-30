import { dedupKey } from "../dedup";
import type { FlatLogRecord, NormalizeContext, NormalizedUsage, ProviderNormalizer } from "../types";

const API_REQUEST = "claude_code.api_request";
// OTel SDK 는 event.name 을 prefixed(claude_code.api_request) 또는 bare(api_request)로 보낼 수
// 있으므로 둘 다 허용한다(정확 일치만 하면 attribute 로만 채우는 SDK 에서 전량 누락).
const isApiRequest = (e: string | null): boolean =>
  e === API_REQUEST || e === "api_request" || (e?.endsWith(".api_request") ?? false);

const num = (v: unknown): number =>
  typeof v === "number" ? v : typeof v === "string" ? Number(v) || 0 : 0;
const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

/**
 * Claude Code normalizer (설계 §5.3).
 * - `claude_code.api_request` 이벤트만 (토큰 과금 요청)
 * - cache_read/creation 은 input 과 별개(가산) → inputTokens 보정 불필요
 * - cost_usd 제공 → providedCostUsd
 */
export const claudeNormalizer: ProviderNormalizer = {
  providerKey: "claude_code",
  normalize(records: FlatLogRecord[], ctx: NormalizeContext): NormalizedUsage[] {
    const out: NormalizedUsage[] = [];
    for (const r of records) {
      if (!isApiRequest(r.eventName)) continue;
      const a = r.attrs;
      const inputTokens = num(a["input_tokens"]);
      const outputTokens = num(a["output_tokens"]);
      if (inputTokens === 0 && outputTokens === 0) continue;

      const cacheReadTokens = num(a["cache_read_tokens"]);
      const cacheCreationTokens = num(a["cache_creation_tokens"]);
      const model = str(a["model"]);
      const sessionId = str(a["session.id"]);
      const seq = a["event.sequence"];
      const providedCost = a["cost_usd"];

      out.push({
        dedupKey: dedupKey({
          requestId: str(a["request_id"]),
          model,
          sessionId,
          eventSequence: typeof seq === "number" ? seq : null,
          tsMs: r.ts.getTime(),
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheCreationTokens,
        }),
        providerKey: "claude_code",
        userId: ctx.userId,
        sessionId,
        model,
        ts: r.ts,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        providedCostUsd: typeof providedCost === "number" ? providedCost : null,
        isFast: a["speed"] === "fast",
      });
    }
    return out;
  },
};
