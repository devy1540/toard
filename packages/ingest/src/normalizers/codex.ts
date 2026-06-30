import { dedupKey } from "../dedup";
import type { FlatLogRecord, NormalizeContext, NormalizedUsage, ProviderNormalizer } from "../types";

const num = (v: unknown): number =>
  typeof v === "number" ? v : typeof v === "string" ? Number(v) || 0 : 0;
const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

/**
 * Codex normalizer (설계 §5.3 — 2차: config.toml 주입 필요).
 * - cached 가 input 의 부분집합 → inputTokens = input_token_count − cached_token_count 보정
 * - cache_creation 미제공 → 0
 * - cost 미제공 → pricing 계산 (providedCostUsd = null)
 */
export const codexNormalizer: ProviderNormalizer = {
  providerKey: "codex",
  normalize(records: FlatLogRecord[], ctx: NormalizeContext): NormalizedUsage[] {
    const out: NormalizedUsage[] = [];
    for (const r of records) {
      const a = r.attrs;
      const rawInput = num(a["input_token_count"]);
      const outputTokens = num(a["output_token_count"]);
      if (rawInput === 0 && outputTokens === 0) continue;

      const cacheReadTokens = num(a["cached_token_count"]);
      const inputTokens = Math.max(0, rawInput - cacheReadTokens); // subset 보정
      const model = str(a["model"]);
      const sessionId = str(a["conversation.id"]);

      out.push({
        dedupKey: dedupKey({
          requestId: str(a["request_id"]),
          model,
          sessionId,
          eventSequence: null,
          tsMs: r.ts.getTime(),
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheCreationTokens: 0,
        }),
        providerKey: "codex",
        userId: ctx.userId,
        sessionId,
        model,
        ts: r.ts,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens: 0,
        providedCostUsd: null,
        isFast: false,
      });
    }
    return out;
  },
};
