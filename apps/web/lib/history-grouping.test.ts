import assert from "node:assert/strict";
import test from "node:test";
import { matchTurnUsage } from "./history-grouping";

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
