// CLI(Claude Code 등)가 프롬프트 자리에 끼워 넣는 시스템·명령 메시지 감지 —
// 채팅 뷰에서 사용자가 직접 쓴 본문과 구분해 접어 보여주기 위한 순수 로직(React/DB 의존 없음).
// 판정은 "본문이 알려진 메타 태그로 시작하는가"로만 한다. 응답(assistant)에는 적용하지 말 것 —
// 모델이 태그를 인용한 본문을 오탐할 수 있다.

const META_TAGS = [
  "local-command-caveat",
  "local-command-stdout",
  "local-command-stderr",
  "command-name",
  "command-message",
  "command-args",
  "system-reminder",
  "task-notification",
  "user-memory-input",
];

const META_START_RE = new RegExp(`^\\s*<(?:${META_TAGS.join("|")})[\\s>]`);

export interface MetaTurnInfo {
  /** 슬래시 명령 호출이면 "/model claude-fable-5" 형태 요약, 그 외 시스템 메시지는 null */
  command: string | null;
}

/** 메타(시스템·명령) 턴이면 요약 정보를, 일반 대화 턴이면 null 을 반환 */
export function detectMetaTurn(text: string): MetaTurnInfo | null {
  if (!META_START_RE.test(text)) return null;
  const name = /<command-name>\s*([^<]*?)\s*<\/command-name>/.exec(text)?.[1];
  const args = /<command-args>\s*([^<]*?)\s*<\/command-args>/.exec(text)?.[1];
  return { command: name ? (args ? `${name} ${args}` : name) : null };
}
