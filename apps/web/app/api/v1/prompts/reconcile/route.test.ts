import assert from "node:assert/strict";
import test from "node:test";
import type { PromptAgentMetadataReconciliationWire } from "@/lib/prompt-wire";
import { POST } from "./route";

const record: PromptAgentMetadataReconciliationWire = {
  dedupKey: "a".repeat(64),
  providerKey: "codex",
  agent: {
    id: "agent-1",
    parentId: "root-1",
    depth: 1,
    name: "Reviewer",
    role: "reviewer",
  },
};

function request(body: unknown): Request {
  return new Request("http://localhost/api/v1/prompts/reconcile", {
    method: "POST",
    headers: { authorization: "Bearer token" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("prompt agent reconciliation은 토큰 사용자 범위와 중복 제거된 레코드만 전달한다", async () => {
  let captured: { userId: string; records: PromptAgentMetadataReconciliationWire[] } | undefined;
  const handler = POST.withDependencies({
    authenticateIngestToken: async () => ({ userId: "server-user", tokenId: "token-1" }),
    reconcilePromptAgentMetadata: async (userId, records) => {
      captured = { userId, records };
      return { reconciled: 1 };
    },
  });

  const response = await handler(request({
    userId: "attacker-controlled",
    records: [record, record],
  }));

  assert.equal(response.status, 200);
  assert.deepEqual(captured, { userId: "server-user", records: [record] });
  assert.deepEqual(await response.json(), { reconciled: 1 });
});

test("prompt agent reconciliation은 미인증·잘못된 입력·상충 중복을 거부한다", async () => {
  assert.equal((await POST.withDependencies({
    authenticateIngestToken: async () => null,
  })(request({ records: [record] }))).status, 401);

  const handler = POST.withDependencies({
    authenticateIngestToken: async () => ({ userId: "user-1", tokenId: "token-1" }),
  });
  for (const body of [
    "{",
    { records: [{ ...record, dedupKey: "invalid" }] },
    { records: [{ ...record, providerKey: "gemini" }] },
    { records: [{ ...record, agent: null }] },
    {
      records: [
        record,
        { ...record, agent: { ...record.agent, id: "agent-2" } },
      ],
    },
  ]) {
    assert.equal((await handler(request(body))).status, 400);
  }
});

test("prompt agent reconciliation 빈 배열은 저장소를 호출하지 않는다", async () => {
  let calls = 0;
  const response = await POST.withDependencies({
    authenticateIngestToken: async () => ({ userId: "user-1", tokenId: "token-1" }),
    reconcilePromptAgentMetadata: async () => {
      calls += 1;
      return { reconciled: 0 };
    },
  })(request({ records: [] }));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { reconciled: 0 });
  assert.equal(calls, 0);
});

test("prompt agent reconciliation은 body 상한을 적용한다", async () => {
  const response = await POST.withDependencies({
    authenticateIngestToken: async () => ({ userId: "user-1", tokenId: "token-1" }),
  })(new Request("http://localhost/api/v1/prompts/reconcile", {
    method: "POST",
    headers: {
      authorization: "Bearer token",
      "content-length": String(1024 * 1024 + 1),
    },
    body: JSON.stringify({ records: [] }),
  }));
  assert.equal(response.status, 413);
});

test("prompt agent reconciliation은 Content-Length가 없어도 실제 body 상한을 적용한다", async () => {
  const response = await POST.withDependencies({
    authenticateIngestToken: async () => ({ userId: "user-1", tokenId: "token-1" }),
  })(new Request("http://localhost/api/v1/prompts/reconcile", {
    method: "POST",
    headers: { authorization: "Bearer token" },
    body: JSON.stringify({
      records: [{
        ...record,
        agent: { ...record.agent, name: "x".repeat(1024 * 1024) },
      }],
    }),
  }));

  assert.equal(response.status, 413);
});

test("prompt agent reconciliation은 필드 상한의 1000건 payload를 허용한다", async () => {
  const records = Array.from({ length: 1_000 }, (_, index) => ({
    dedupKey: index.toString(16).padStart(64, "0"),
    providerKey: "claude_code",
    agent: {
      id: "i".repeat(255),
      parentId: "p".repeat(255),
      depth: 32,
      name: "n".repeat(100),
      role: "r".repeat(100),
    },
  }));
  const body = JSON.stringify({ records });
  assert.ok(Buffer.byteLength(body) < 1024 * 1024);

  let received = 0;
  const response = await POST.withDependencies({
    authenticateIngestToken: async () => ({ userId: "user-1", tokenId: "token-1" }),
    reconcilePromptAgentMetadata: async (_userId, input) => {
      received = input.length;
      return { reconciled: input.length };
    },
  })(new Request("http://localhost/api/v1/prompts/reconcile", {
    method: "POST",
    headers: { authorization: "Bearer token" },
    body,
  }));

  assert.equal(response.status, 200);
  assert.equal(received, 1_000);
  assert.deepEqual(await response.json(), { reconciled: 1_000 });
});

test("prompt agent reconciliation은 잘못된 UTF-8을 입력 내용 노출 없이 거부한다", async () => {
  const response = await POST.withDependencies({
    authenticateIngestToken: async () => ({ userId: "user-1", tokenId: "token-1" }),
  })(new Request("http://localhost/api/v1/prompts/reconcile", {
    method: "POST",
    headers: { authorization: "Bearer token" },
    body: new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]),
  }));

  assert.equal(response.status, 400);
  assert.equal((await response.text()).includes("ff"), false);
});
