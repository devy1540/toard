import assert from "node:assert/strict";
import { test } from "node:test";
import { claudeNormalizer } from "./normalizers/claude";
import { codexNormalizer } from "./normalizers/codex";
import { parseOtlpLogs } from "./otlp";
import type { FlatLogRecord } from "./types";

function rec(eventName: string | null, attrs: Record<string, string | number | boolean>): FlatLogRecord {
  return { resourceAttrs: {}, scopeName: null, eventName, ts: new Date(1_700_000_000_000), attrs };
}

test("Codex: cached 가 input 의 부분집합 → inputTokens = input - cached", () => {
  const out = codexNormalizer.normalize(
    [
      rec(null, {
        input_token_count: 5000,
        output_token_count: 1000,
        cached_token_count: 2000,
        model: "gpt-5",
        "conversation.id": "conv-1",
        request_id: "req-codex-1",
      }),
    ],
    { userId: "u1" },
  );
  assert.equal(out.length, 1);
  const u = out[0]!;
  assert.equal(u.inputTokens, 3000); // 5000 - 2000 (subset 보정)
  assert.equal(u.cacheReadTokens, 2000);
  assert.equal(u.cacheCreationTokens, 0); // Codex 미제공
  assert.equal(u.outputTokens, 1000);
  assert.equal(u.providedCostUsd, null); // pricing 으로 계산
  assert.equal(u.sessionId, "conv-1");
  assert.equal(u.providerKey, "codex");
});

test("Claude: cache 는 input 과 별개(가산), cost 제공", () => {
  const out = claudeNormalizer.normalize(
    [
      rec("claude_code.api_request", {
        input_tokens: 3000,
        output_tokens: 800,
        cache_read_tokens: 1000,
        cache_creation_tokens: 500,
        model: "claude-sonnet-4-5",
        "session.id": "sess-1",
        request_id: "req-claude-1",
        cost_usd: 0.05,
      }),
    ],
    { userId: "u1" },
  );
  assert.equal(out.length, 1);
  const u = out[0]!;
  assert.equal(u.inputTokens, 3000); // 보정 없음 (별개)
  assert.equal(u.cacheReadTokens, 1000);
  assert.equal(u.cacheCreationTokens, 500);
  assert.equal(u.providedCostUsd, 0.05);
});

test("Claude: api_request 가 아닌 이벤트는 무시", () => {
  const out = claudeNormalizer.normalize(
    [rec("claude_code.user_prompt", { prompt_length: 10 })],
    { userId: "u1" },
  );
  assert.equal(out.length, 0);
});

test("Claude: bare 'api_request' eventName 도 폴백 매칭 (attribute-only SDK)", () => {
  const out = claudeNormalizer.normalize(
    [rec("api_request", { input_tokens: 100, output_tokens: 50, model: "claude-sonnet-4-5", request_id: "r-bare" })],
    { userId: "u1" },
  );
  assert.equal(out.length, 1);
  assert.equal(out[0]!.inputTokens, 100);
});

test("parseOtlpLogs: timeUnixNano 없으면 레코드 제외 (epoch 오염 방지)", () => {
  const recs = parseOtlpLogs({
    resourceLogs: [{ scopeLogs: [{ logRecords: [{ eventName: "x", attributes: [] }] }] }],
  });
  assert.equal(recs.length, 0);
});
