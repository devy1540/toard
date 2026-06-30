// 프롬프트/자유텍스트 키 (설계 §10.3 — raw 저장 전 제거).
// 평탄화된 FlatLogRecord.attrs 기준으로 제거한다. parseOtlpLogs 가 OTLP {key,value} 를
// {key: value} 로 평탄화하므로 여기서 객체 키 = attribute 이름이다(원본 OTLP 트리에 키 기반
// 제거를 적용하면 {key,value} 구조라 동작하지 않음 — 반드시 평탄화 후 호출).
// 1차는 denylist. 더 엄격히 하려면 토큰/비용/식별 attribute 만 보존하는 화이트리스트로 전환.
type Scalar = string | number | boolean;

const DENY_KEYS = new Set([
  "prompt",
  "prompt_text",
  "user_prompt",
  "body",
  "Body",
  "latest_user_message",
  "message",
  "content",
  "text",
  "tool_result",
]);

/** flat attrs 에서 프롬프트/자유텍스트 키 제거 (PII 미수집) */
export function sanitizeAttrs(attrs: Record<string, Scalar>): Record<string, Scalar> {
  const out: Record<string, Scalar> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (DENY_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}
