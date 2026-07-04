// 프롬프트/자유텍스트 키 (설계 §10.3 — raw 저장 전 제거).
// 평탄화된 FlatLogRecord.attrs 기준으로 제거한다. parseOtlpLogs 가 OTLP {key,value} 를
// {key: value} 로 평탄화하므로 여기서 객체 키 = attribute 이름이다(원본 OTLP 트리에 키 기반
// 제거를 적용하면 {key,value} 구조라 동작하지 않음 — 반드시 평탄화 후 호출).
// 1차는 denylist. 더 엄격히 하려면 토큰/비용/식별 attribute 만 보존하는 화이트리스트로 전환.
// ⚠ 화이트리스트로 전환 시 host 식별자(`toard.host`·`host.name`)를 보존 목록에 반드시 포함할 것
//    — 누락하면 컴퓨터별 구분(§design-host-breakdown)이 조용히 유실된다.
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

const HOST_MAX_LEN = 255;
// 제어문자(개행·탭 등 U+0000–U+001F, U+007F) 매칭 — host 표시/저장 안전용.
// 리터럴 대신 이스케이프 RegExp 로 구성(제어문자 리터럴이 소스에 섞이지 않게).
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001f\\u007f]", "g");

/**
 * host 라벨 서버 하드닝(§design-host-breakdown). host 는 클라이언트가 검증 없이 보내는
 * 서술 메타데이터라, 저장 전 제어문자 제거·255자 절단·빈값→null 로만 살균한다.
 * 대소문자는 건드리지 않음(shim 이 정규화 소유 — 사용자 별칭 대소문자 존중).
 * 두 수집 경로(events/logs)가 공유하는 수렴 지점이며, 특정 저장 백엔드에 두지 않는다.
 */
export function sanitizeHost(host: string | null | undefined): string | null {
  if (host == null) return null;
  const cleaned = host.replace(CONTROL_CHARS, "").trim().slice(0, HOST_MAX_LEN).trim();
  return cleaned.length > 0 ? cleaned : null;
}

/** FlatLogRecord 들의 resourceAttrs 에서 host 추출(toard.host 우선, 표준 host.name 폴백).
 *  한 provider 그룹의 recs 는 같은 머신(한 POST=한 머신, ADR-001)이라 첫 값이 대표. */
export function hostFromResourceAttrs(
  records: Array<{ resourceAttrs: Record<string, Scalar> }>,
): string | null {
  for (const r of records) {
    const v = r.resourceAttrs["toard.host"] ?? r.resourceAttrs["host.name"];
    if (typeof v === "string") {
      const s = sanitizeHost(v);
      if (s) return s;
    }
  }
  return null;
}
