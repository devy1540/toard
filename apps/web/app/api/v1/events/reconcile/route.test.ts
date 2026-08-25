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
  const invalidated: string[] = [];
  const generation: string[] = [];
  const handler = POST.withDependencies({
    authenticateIngestToken: async () => ({ userId: "server-user", tokenId: "token-1" }),
    reconcileUsageEvents: async (input) => {
      captured = input;
      return { reconciled: 1, affectedBuckets: [new Date()] };
    },
    invalidateUtilizationForUser: async (userId) => { invalidated.push(userId); },
    withUserUtilizationCacheChange: async (userId, operation) => {
      const result = await operation();
      generation.push(userId);
      return result;
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
  assert.deepEqual(invalidated, ["server-user"]);
  assert.deepEqual(generation, ["server-user"]);
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
  let invalidations = 0;
  const handler = POST.withDependencies({
    authenticateIngestToken: async () => ({ userId: "user-1", tokenId: "token-1" }),
    reconcileUsageEvents: async () => {
      calls += 1;
      return { reconciled: 0, affectedBuckets: [] };
    },
    invalidateUtilizationForUser: async () => { invalidations += 1; },
  });

  const response = await handler(request({ dedupKeys: [] }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { reconciled: 0 });
  assert.equal(calls, 0);
  assert.equal(invalidations, 0);
});

test("Codex reconciliation은 실제 삭제가 없으면 활용 지수 cache를 무효화하지 않는다", async () => {
  let invalidations = 0;
  const handler = POST.withDependencies({
    authenticateIngestToken: async () => ({ userId: "user-1", tokenId: "token-1" }),
    reconcileUsageEvents: async () => ({ reconciled: 0, affectedBuckets: [] }),
    invalidateUtilizationForUser: async () => { invalidations += 1; },
  });

  const response = await handler(request({ dedupKeys: [key] }));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { reconciled: 0 });
  assert.equal(invalidations, 0);
});

test("공유 generation 완료 뒤 local tag 정리가 실패해도 보정 결과는 성공한다", async () => {
  let generationFinished = false;
  const handler = POST.withDependencies({
    authenticateIngestToken: async () => ({ userId: "user-1", tokenId: "token-1" }),
    reconcileUsageEvents: async () => ({ reconciled: 1, affectedBuckets: [] }),
    withUserUtilizationCacheChange: async (_userId, operation) => {
      const result = await operation();
      generationFinished = true;
      return result;
    },
    invalidateUtilizationForUser: async () => { throw new Error("local cache unavailable"); },
  });

  const response = await handler(request({ dedupKeys: [key] }));

  assert.equal(response.status, 200);
  assert.equal(generationFinished, true);
  assert.deepEqual(await response.json(), { reconciled: 1 });
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

test("Codex reconciliation은 authenticated malformed UTF-8을 safe 400으로 반환한다", async () => {
  const handler = POST.withDependencies({
    authenticateIngestToken: async () => ({ userId: "user-1", tokenId: "token-1" }),
  });
  const response = await handler(new Request("http://localhost/api/v1/events/reconcile", {
    method: "POST", headers: { authorization: "Bearer token" },
    body: new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]),
  }));
  assert.equal(response.status, 400);
  assert.equal((await response.text()).includes("ff"), false);
});
