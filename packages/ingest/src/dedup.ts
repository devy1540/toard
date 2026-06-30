import { createHash } from "node:crypto";

export interface DedupArgs {
  requestId: string | null;
  model: string | null;
  sessionId: string | null;
  eventSequence: number | null;
  tsMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/**
 * dedup_key 생성 (설계 §4.4).
 * request_id(= Anthropic API request-id, api_request 에 실재) 우선.
 * 없으면 자연키 조합 — prompt.id 는 api_request 에 없을 수 있어 미사용.
 */
export function dedupKey(a: DedupArgs): string {
  const h = createHash("sha256");
  if (a.requestId) {
    h.update(
      `req|${a.requestId}|${a.model ?? ""}|${a.inputTokens}|${a.outputTokens}|${a.cacheReadTokens}|${a.cacheCreationTokens}`,
    );
  } else {
    h.update(
      `nat|${a.sessionId ?? ""}|${a.eventSequence ?? ""}|${a.tsMs}|${a.inputTokens}|${a.outputTokens}`,
    );
  }
  return h.digest("hex");
}
