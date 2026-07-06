import assert from "node:assert/strict";
import { test } from "node:test";
import type { Provider } from "@toard/core";
import { identifyProvider } from "./provider";
import type { FlatLogRecord } from "./types";

function rec(serviceName: string): FlatLogRecord {
  return {
    resourceAttrs: { "service.name": serviceName },
    scopeName: null,
    eventName: null,
    ts: new Date(1_700_000_000_000),
    attrs: {},
  };
}

function provider(
  key: string,
  patterns: string[],
  collectionMethod: "otel" | "logfile",
  enabled = true,
): Provider {
  return { key, displayName: key, serviceNamePatterns: patterns, collectionMethod, enabled };
}

test("identifyProvider: otel provider 는 service.name 매칭 시 식별", () => {
  const providers = [provider("claude_code", ["claude-code", "claude-code-desktop"], "otel")];
  assert.equal(identifyProvider(rec("claude-code"), providers), "claude_code");
  assert.equal(identifyProvider(rec("claude-code-desktop"), providers), "claude_code");
});

test("identifyProvider: logfile provider 의 OTLP 는 드롭(null) — pull 전환 provider 이중집계 차단(§5.2②)", () => {
  // collection_method='logfile' 이면 service.name 이 매칭돼도 /v1/logs 에서 미식별 → raw·정규화 안 함.
  // /v1/events(pull)의 known 집합엔 여전히 들어 있어 pull 은 정상(enabled 유지).
  const providers = [provider("claude_code", ["claude-code"], "logfile")];
  assert.equal(identifyProvider(rec("claude-code"), providers), null);
});

test("identifyProvider: experimental 로 otel 되켜면 다시 식별", () => {
  const providers = [provider("codex", ["codex", "codex_cli_rs"], "otel")];
  assert.equal(identifyProvider(rec("codex_cli_rs"), providers), "codex");
});

test("identifyProvider: disabled provider 는 드롭", () => {
  const providers = [provider("claude_code", ["claude-code"], "otel", false)];
  assert.equal(identifyProvider(rec("claude-code"), providers), null);
});

test("identifyProvider: service.name 불일치·부재 → null", () => {
  const providers = [provider("codex", ["codex"], "otel")];
  assert.equal(identifyProvider(rec("unknown-svc"), providers), null);
  assert.equal(
    identifyProvider(
      { resourceAttrs: {}, scopeName: null, eventName: null, ts: new Date(0), attrs: {} },
      providers,
    ),
    null,
  );
});
