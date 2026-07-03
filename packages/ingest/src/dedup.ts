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
    // Codex 는 event.sequence 미전송이라 폴백키가 약함 → 캐시 토큰까지 포함해 충돌 위험 완화
    h.update(
      `nat|${a.sessionId ?? ""}|${a.eventSequence ?? ""}|${a.tsMs}|${a.inputTokens}|${a.outputTokens}|${a.cacheReadTokens}|${a.cacheCreationTokens}`,
    );
  }
  return h.digest("hex");
}

/**
 * metrics 경로 dedup_key — (session, model) 고정.
 * Claude Code 2.x 는 세션 누적 카운터를 export 마다 반복 전송하므로, 같은 (session, model)은
 * 하나의 행으로 수렴시켜 upsert(최신 누적)한다. request 단위 키(위 dedupKey)와 달리 값은 넣지 않는다.
 */
export function metricDedupKey(sessionId: string | null, model: string | null): string {
  return createHash("sha256").update(`metric|${sessionId ?? ""}|${model ?? ""}`).digest("hex");
}
