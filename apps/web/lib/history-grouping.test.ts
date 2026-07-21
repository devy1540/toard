import assert from "node:assert/strict";
import test from "node:test";
import { groupHistoryAgents, matchTurnUsage } from "./history-grouping";

test("턴 usage 매칭은 이벤트 costStatus를 UI까지 보존한다", () => {
  const ts = new Date("2026-07-01T00:00:00Z");
  const result = matchTurnUsage(
    [{
      dedupKey: "turn-1",
      sessionId: "session-1",
      providerKey: "anthropic",
      role: "assistant",
      ts,
      text: "response",
    }],
    [{
      ts,
      model: "model-a",
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0,
      costStatus: "unpriced",
    }],
  );

  assert.equal(result.get("turn-1")?.costStatus, "unpriced");
});

test("연속된 서브에이전트 턴을 실행별로 묶고 메인 흐름을 보존한다", () => {
  const at = (minute: number) => new Date(`2026-07-01T00:${String(minute).padStart(2, "0")}:00Z`);
  const turns = [
    { dedupKey: "main-1", sessionId: "root", providerKey: "codex", role: "assistant" as const, ts: at(0), text: "start" },
    { dedupKey: "a-1", sessionId: "root", providerKey: "codex", role: "user" as const, ts: at(1), text: "task a", agent: { id: "a", parentId: "root", depth: 1, name: "Galileo", role: "explorer" } },
    { dedupKey: "b-1", sessionId: "root", providerKey: "codex", role: "user" as const, ts: at(2), text: "task b", agent: { id: "b", parentId: "root", depth: 1, name: null, role: null } },
    { dedupKey: "a-2", sessionId: "root", providerKey: "codex", role: "assistant" as const, ts: at(3), text: "result a", agent: { id: "a", parentId: "root", depth: 1, name: "Galileo", role: "explorer" } },
    { dedupKey: "main-2", sessionId: "root", providerKey: "codex", role: "assistant" as const, ts: at(4), text: "finish" },
  ];

  const timeline = groupHistoryAgents(turns);
  assert.equal(timeline.length, 3);
  assert.equal(timeline[0]?.type, "turn");
  assert.equal(timeline[1]?.type, "agents");
  if (timeline[1]?.type !== "agents") throw new Error("agent group missing");
  assert.deepEqual(timeline[1].agents.map((agent) => agent.id), ["a", "b"]);
  assert.equal(timeline[1].agents[0]?.turns.length, 2);
  assert.equal(timeline[2]?.type, "turn");
});
