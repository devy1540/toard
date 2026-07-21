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

export interface HistoryAgentRun {
  id: string;
  parentId: string | null;
  depth: number | null;
  name: string | null;
  role: string | null;
  turns: PromptHistoryItem[];
  firstTs: Date;
  latestTs: Date;
}

export type HistoryTimelineItem =
  | { type: "turn"; turn: PromptHistoryItem }
  | { type: "agents"; agents: HistoryAgentRun[]; firstTs: Date; latestTs: Date };

/**
 * 시간순 턴을 메인 턴과 연속된 서브에이전트 실행 묶음으로 변환한다.
 * 에이전트 내부에서는 원본 턴 순서를 유지하고, 묶음 안 에이전트는 첫 활동 시각순이다.
 */
export function groupHistoryAgents(turns: PromptHistoryItem[]): HistoryTimelineItem[] {
  const timeline: HistoryTimelineItem[] = [];
  let index = 0;
  while (index < turns.length) {
    const turn = turns[index]!;
    if (!turn.agent) {
      timeline.push({ type: "turn", turn });
      index += 1;
      continue;
    }

    const grouped = new Map<string, HistoryAgentRun>();
    let firstTs = turn.ts;
    let latestTs = turn.ts;
    while (index < turns.length && turns[index]!.agent) {
      const agentTurn = turns[index]!;
      const agent = agentTurn.agent!;
      const existing = grouped.get(agent.id);
      if (existing) {
        existing.turns.push(agentTurn);
        existing.latestTs = agentTurn.ts;
      } else {
        grouped.set(agent.id, {
          ...agent,
          turns: [agentTurn],
          firstTs: agentTurn.ts,
          latestTs: agentTurn.ts,
        });
      }
      if (agentTurn.ts < firstTs) firstTs = agentTurn.ts;
      if (agentTurn.ts > latestTs) latestTs = agentTurn.ts;
      index += 1;
    }
    timeline.push({
      type: "agents",
      agents: [...grouped.values()].sort((left, right) => left.firstTs.getTime() - right.firstTs.getTime()),
      firstTs,
      latestTs,
    });
  }
  return timeline;
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
