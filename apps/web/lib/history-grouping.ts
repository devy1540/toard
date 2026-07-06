import type { PromptHistoryItem } from "./prompt-history";

// 내 히스토리 표시용 순수 로직 — 플랫한 턴 목록을 "대화(세션)" 단위로 묶는다.
// React/DB 의존 없음(타입만) → 단위 검증 가능. 페이지는 이 결과를 렌더만 한다.

export interface SessionGroup {
  /** 렌더 key. 세션 있으면 세션 id, 없으면 solo:<dedupKey>. */
  key: string;
  provider: string;
  /** 세션 id 앞 8자(전체 UUID 노이즈 제거). 세션 없으면 null. */
  shortId: string | null;
  /** 그룹 내 가장 최근 턴 시각(세션 정렬·헤더 표시용). */
  latest: Date;
  /** 시간 오름차순(프롬프트→응답) 정렬된 턴. */
  turns: PromptHistoryItem[];
}

/**
 * ts DESC 플랫 목록 → 세션별 그룹.
 * - 세션 내부: 시간 오름차순(프롬프트가 먼저, 응답이 뒤).
 * - 세션 간: 최근 대화가 위로(latest DESC).
 * - session_id 가 없는 턴은 각자 독립 그룹(solo).
 */
export function groupBySession(items: PromptHistoryItem[]): SessionGroup[] {
  const groups = new Map<string, PromptHistoryItem[]>();
  for (const it of items) {
    const key = it.sessionId ?? `solo:${it.dedupKey}`;
    const arr = groups.get(key);
    if (arr) arr.push(it);
    else groups.set(key, [it]);
  }
  return [...groups.entries()]
    .map(([key, turns]) => {
      const sorted = [...turns].sort((a, b) => a.ts.getTime() - b.ts.getTime());
      const first = sorted[0]!;
      const latest = sorted[sorted.length - 1]!.ts;
      return {
        key,
        provider: first.providerKey,
        shortId: first.sessionId ? first.sessionId.slice(0, 8) : null,
        latest,
        turns: sorted,
      };
    })
    .sort((a, b) => b.latest.getTime() - a.latest.getTime());
}
