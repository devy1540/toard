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

test("bounded JSON reader는 decode/JSON 오류를 safe SyntaxError로 바꾸고 internal bytes만 지운다", async () => {
  const raw = new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]);
  const invalidJson = new Uint8Array([0x7b]);
  const filled: Uint8Array[] = [];
  const originalFill = Uint8Array.prototype.fill;
  Uint8Array.prototype.fill = function (...args: Parameters<Uint8Array["fill"]>) {
    filled.push(this);
    return originalFill.apply(this, args);
  };
  try {
    await assert.rejects(
      readBoundedJson(new Request("http://localhost", { method: "POST", body: new ReadableStream({
        start(controller) { controller.enqueue(raw); controller.close(); },
      }), duplex: "half" } as RequestInit), 1024),
      (error: unknown) => error instanceof SyntaxError && error.message === "INVALID_JSON",
    );
    await assert.rejects(
      readBoundedJson(new Request("http://localhost", { method: "POST", body: new ReadableStream({
        start(controller) { controller.enqueue(invalidJson); controller.close(); },
      }), duplex: "half" } as RequestInit), 1024),
      (error: unknown) => error instanceof SyntaxError && error.message === "INVALID_JSON",
    );
  } finally { Uint8Array.prototype.fill = originalFill; }
  assert.equal(filled.includes(raw), false, "caller-owned chunk is never wiped or mutated");
  assert.ok(filled.filter((value) => value !== raw && value.byteLength === raw.byteLength).length >= 2,
    "internal chunk copy and merged bytes are wiped");
  assert.deepEqual([...raw], [0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]);
  assert.deepEqual([...invalidJson], [0x7b]);
  assert.ok(filled.filter((value) => value !== invalidJson && value.byteLength === 1).length >= 2,
    "JSON parse error internal chunk and merged bytes are wiped");
  assert.equal(toolIngestClientError(new SyntaxError("INVALID_JSON"))?.status, 400);
});

test("bounded JSON reader는 success/read-error/overflow에서 caller bytes를 보존하고 internal copies를 지운다", async () => {
  const success = new TextEncoder().encode('{"ok":true}');
  const first = new Uint8Array([1, 1, 1, 1]);
  const overflow = new Uint8Array([2, 2, 2, 2]);
  const readErrorChunk = new Uint8Array([9, 9, 9]);
  const filled: Uint8Array[] = [];
  const originalFill = Uint8Array.prototype.fill;
  Uint8Array.prototype.fill = function (...args: Parameters<Uint8Array["fill"]>) {
    filled.push(this);
    return originalFill.apply(this, args);
  };
  try {
    const parsed = await readBoundedJson(new Request("http://localhost", { method: "POST", body: new ReadableStream({
      start(controller) { controller.enqueue(success); controller.close(); },
    }), duplex: "half" } as RequestInit), 1024);
    assert.deepEqual(parsed, { ok: true });
    await assert.rejects(readBoundedJson(new Request("http://localhost", { method: "POST", body: new ReadableStream({
      start(controller) { controller.enqueue(first); controller.enqueue(overflow); controller.close(); },
    }), duplex: "half" } as RequestInit), 5), RangeError);
    let pulled = false;
    await assert.rejects(readBoundedJson(new Request("http://localhost", { method: "POST", body: new ReadableStream({
      pull(controller) {
        if (!pulled) { pulled = true; controller.enqueue(readErrorChunk); return; }
        controller.error(new Error("stream failed"));
      },
    }), duplex: "half" } as RequestInit), 1024), /stream failed/);
  } finally { Uint8Array.prototype.fill = originalFill; }
  assert.equal(new TextDecoder().decode(success), '{"ok":true}');
  assert.deepEqual([...first], [1, 1, 1, 1]);
  assert.deepEqual([...overflow], [2, 2, 2, 2]);
  assert.deepEqual([...readErrorChunk], [9, 9, 9]);
  for (const callerOwned of [success, first, overflow, readErrorChunk]) assert.equal(filled.includes(callerOwned), false);
  assert.ok(filled.some((value) => value.byteLength === first.byteLength), "overflow prior internal copy is wiped");
  assert.ok(filled.some((value) => value.byteLength === readErrorChunk.byteLength), "read-error internal copy is wiped");
});
