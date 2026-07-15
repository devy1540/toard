import assert from "node:assert/strict";
import test from "node:test";
import type { UsageEventReconciliationRequest } from "@toard/core";
import { POST } from "./route";

const key = "a".repeat(64);
const request = (body: unknown) => new Request("http://localhost/api/v1/events/reconcile", {
  method: "POST",
  headers: { authorization: "Bearer token" },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

test("Codex reconciliation은 인증 사용자 범위와 중복 제거된 키만 저장소에 전달한다", async () => {
  let captured: UsageEventReconciliationRequest | undefined;
  const handler = POST.withDependencies({
    authenticateIngestToken: async () => ({ userId: "server-user", tokenId: "token-1" }),
    reconcileUsageEvents: async (input) => {
      captured = input;
      return { reconciled: 1, affectedBuckets: [new Date()] };
    },
  });

  const response = await handler(request({
    userId: "attacker-controlled",
    providerKey: "anthropic",
    dedupKeys: [key, key],
  }));

  assert.equal(response.status, 200);
  assert.deepEqual(captured, {
    userId: "server-user",
    providerKey: "codex",
    logAdapter: "codex",
    dedupKeys: [key],
  });
  assert.deepEqual(await response.json(), { reconciled: 1 });
});

test("Codex reconciliation은 미인증 요청을 거부한다", async () => {
  const handler = POST.withDependencies({
    authenticateIngestToken: async () => null,
  });
  assert.equal((await handler(request({ dedupKeys: [key] }))).status, 401);
});

test("Codex reconciliation은 malformed JSON, 잘못된 키, 1001개 초과를 거부한다", async () => {
  const handler = POST.withDependencies({
    authenticateIngestToken: async () => ({ userId: "user-1", tokenId: "token-1" }),
  });

  for (const body of [
    "{",
    { dedupKeys: ["A".repeat(64)] },
    { dedupKeys: ["a".repeat(63)] },
    { dedupKeys: Array.from({ length: 1_001 }, (_, index) => index.toString(16).padStart(64, "0")) },
  ]) {
    const response = await handler(request(body));
    assert.equal(response.status, 400);
  }
});

test("Codex reconciliation 빈 배열은 저장소를 호출하지 않고 멱등 성공한다", async () => {
  let calls = 0;
  const handler = POST.withDependencies({
    authenticateIngestToken: async () => ({ userId: "user-1", tokenId: "token-1" }),
    reconcileUsageEvents: async () => {
      calls += 1;
      return { reconciled: 0, affectedBuckets: [] };
    },
  });

  const response = await handler(request({ dedupKeys: [] }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { reconciled: 0 });
  assert.equal(calls, 0);
});

test("Codex reconciliation은 Content-Length 초과를 body 읽기 전에 거부한다", async () => {
  const handler = POST.withDependencies({
    authenticateIngestToken: async () => ({ userId: "user-1", tokenId: "token-1" }),
  });
  const response = await handler(new Request("http://localhost/api/v1/events/reconcile", {
    method: "POST",
    headers: {
      authorization: "Bearer token",
      "content-length": String(129 * 1024),
    },
    body: JSON.stringify({ dedupKeys: [] }),
  }));
  assert.equal(response.status, 413);
});
