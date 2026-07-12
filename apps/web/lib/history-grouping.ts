import type { SessionUsageEventRow } from "@toard/core";
import type { PromptHistoryItem } from "./prompt-history";

// 내 히스토리 표시용 순수 로직 — React/DB 의존 없음(타입만) → 단위 검증 가능.
// 세션 그룹핑·페이지네이션은 SQL(prompt-history)로 내려갔고, 여기는 "턴 ↔ 사용 이벤트"
// 매칭만 남는다. prompt_records 와 usage_events 는 dedup_key 네임스페이스가 달라
// (본문 키는 "content:"+텍스트 해시 — collect/mod.rs) 직접 조인이 불가하므로,
// 같은 세션 안에서 assistant 턴과 사용 이벤트를 ts 최근접(허용오차 내)으로 1:1 매칭한다.
// 표시용 메타데이터라 매칭 실패는 "정보 없음"으로 조용히 접히면 된다.

export interface TurnUsage {
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  costStatus: SessionUsageEventRow["costStatus"];
}

/** pull 수집은 같은 로그 라인에서 본문·usage 가 나와 ts 가 일치하고,
 *  OTLP 경로는 어긋날 수 있어 여유를 둔다. 이 이상 벌어지면 무매칭 처리. */
const MATCH_TOLERANCE_MS = 10_000;

/**
 * assistant 턴 ↔ 사용 이벤트 최근접 ts 매칭 (greedy 1:1).
 * 반환: dedupKey(턴) → TurnUsage. 매칭 실패 턴은 미포함.
 */
export function matchTurnUsage(
  turns: PromptHistoryItem[],
  events: SessionUsageEventRow[],
  toleranceMs = MATCH_TOLERANCE_MS,
): Map<string, TurnUsage> {
  const result = new Map<string, TurnUsage>();
  if (events.length === 0) return result;

  const used = new Array<boolean>(events.length).fill(false);
  for (const turn of turns) {
    if (turn.role !== "assistant") continue;
    const t = turn.ts.getTime();
    let best = -1;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (let i = 0; i < events.length; i++) {
      if (used[i]) continue;
      const delta = Math.abs(events[i]!.ts.getTime() - t);
      if (delta < bestDelta) {
        best = i;
        bestDelta = delta;
      }
    }
    if (best >= 0 && bestDelta <= toleranceMs) {
      used[best] = true;
      const e = events[best]!;
      result.set(turn.dedupKey, {
        model: e.model,
        inputTokens: e.inputTokens,
        outputTokens: e.outputTokens,
        cacheReadTokens: e.cacheReadTokens,
        cacheCreationTokens: e.cacheCreationTokens,
        costUsd: e.costUsd,
        costStatus: e.costStatus,
      });
    }
  }
  return result;
}
