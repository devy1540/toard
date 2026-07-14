import assert from "node:assert/strict";
import test from "node:test";
import type { ToolActivityEvent, ToolInventorySnapshot } from "@toard/core";
import { ToolWireParseError } from "@toard/core";
import { finalizeToolActivity, finalizeToolInventory, readBoundedJson, toolIngestClientError } from "./tool-ingest";

const event: ToolActivityEvent = {
  dedupKey: "a".repeat(64),
  providerKey: "codex",
  sessionId: "session-1",
  host: "mac\u0000book.local",
  ts: new Date("2026-07-10T00:00:00Z"),
  activityKind: "skill",
  itemKey: "brainstorming",
  displayName: "brainstorming",
  pluginKey: "superpowers",
  outcome: "unknown",
  detection: "derived_load",
};

test("활동 ingest는 인증 소유권과 살균된 host를 강제한다", () => {
  const [result] = finalizeToolActivity({ userId: "user-auth", tokenId: "token-auth" }, [event]);
  assert.equal(result?.userId, "user-auth");
  assert.equal(result?.ingestTokenId, "token-auth");
  assert.equal(result?.host, "macbook.local");
  assert.equal("arguments" in (result ?? {}), false);
  assert.equal("output" in (result ?? {}), false);
});

test("인벤토리 ingest는 인증 소유권을 강제하고 안전한 필드만 유지한다", () => {
  const snapshot: ToolInventorySnapshot = {
    host: "mac\u0000book.local",
    fingerprint: "b".repeat(64),
    observedAt: new Date("2026-07-10T00:00:00Z"),
    items: [{
      kind: "skill",
      itemKey: "brainstorming",
      displayName: "brainstorming",
      sourceProvider: "codex",
      pluginKey: "superpowers",
      version: "6.1.1",
      enabled: true,
    }],
  };
  const result = finalizeToolInventory({ userId: "user-auth", tokenId: "token-auth" }, snapshot);
  assert.equal(result.userId, "user-auth");
  assert.equal(result.ingestTokenId, "token-auth");
  assert.equal(result.host, "macbook.local");
  assert.equal("endpoint" in result.items[0]!, false);
  assert.equal("path" in result.items[0]!, false);
});

test("수집 API는 클라이언트 오류만 4xx로 변환한다", () => {
  assert.equal(toolIngestClientError(new RangeError("too large"))?.status, 413);
  assert.equal(toolIngestClientError(new SyntaxError("bad json"))?.status, 400);
  assert.equal(toolIngestClientError(new ToolWireParseError("bad field"))?.status, 400);
  assert.equal(toolIngestClientError(new Error("database unavailable")), null);
});

test("bounded JSON reader는 Content-Length 초과를 body 읽기 전에 거부한다", async () => {
  const request = new Request("http://localhost", {
    method: "POST",
    headers: { "Content-Length": "4097" },
    body: "{}",
  });
  await assert.rejects(readBoundedJson(request, 4096), RangeError);
});

test("bounded JSON reader는 stream이 상한을 넘는 즉시 취소한다", async () => {
  let cancelled = false;
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      controller.enqueue(new Uint8Array(1024));
      if (pulls === 10) controller.close();
    },
    cancel() { cancelled = true; },
  });
  const request = new Request("http://localhost", {
    method: "POST",
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  await assert.rejects(readBoundedJson(request, 1500), RangeError);
  assert.equal(cancelled, true);
  assert.ok(pulls < 10);
});
