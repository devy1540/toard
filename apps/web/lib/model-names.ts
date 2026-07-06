// 모델 ID → 사람이 읽는 표시명. 패턴 기반(테이블 아님) — 새 버전이 나와도 대체로 자동 대응.
// 매칭 실패 시 null 을 반환하고 UI 는 raw ID 를 그대로 보여준다(오표기보다 안전).

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** 'claude-sonnet-4-5(-20250929)' → 'Claude Sonnet 4.5'. 미인식 패턴은 null. */
export function formatModelName(id: string): string | null {
  let m = /^claude-([a-z]+)-(\d+)-(\d+)(?:-\d{8})?$/.exec(id);
  if (m) return `Claude ${cap(m[1]!)} ${m[2]}.${m[3]}`;
  // 구형 표기: claude-3-5-sonnet(-20241022)
  m = /^claude-(\d+)-(\d+)-([a-z]+)(?:-\d{8})?$/.exec(id);
  if (m) return `Claude ${cap(m[3]!)} ${m[1]}.${m[2]}`;
  // 마이너 없는 표기: claude-opus-4
  m = /^claude-([a-z]+)-(\d+)(?:-\d{8})?$/.exec(id);
  if (m) return `Claude ${cap(m[1]!)} ${m[2]}`;
  m = /^gemini-(\d+(?:\.\d+)?)-([a-z][a-z-]*)$/.exec(id);
  if (m) return `Gemini ${m[1]} ${m[2]!.split("-").map(cap).join(" ")}`;
  if (/^gpt-/.test(id)) return `GPT-${id.slice(4)}`;
  return null;
}
