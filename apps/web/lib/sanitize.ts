// 프롬프트/자유텍스트 키 (설계 §10.3 — raw 저장 전 제거).
// 1차는 denylist. 더 엄격히 하려면 토큰/비용 attribute 만 보존하는 화이트리스트로 전환.
const DENY_KEYS = new Set([
  "prompt",
  "prompt_text",
  "body",
  "Body",
  "latest_user_message",
  "message",
  "content",
]);

/** OTLP 페이로드에서 프롬프트 본문을 재귀 제거 (PII 미수집) */
export function stripPrompts(payload: unknown): unknown {
  if (Array.isArray(payload)) return payload.map(stripPrompts);
  if (payload !== null && typeof payload === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(payload)) {
      if (DENY_KEYS.has(k)) continue;
      out[k] = stripPrompts(v);
    }
    return out;
  }
  return payload;
}
