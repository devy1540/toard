import assert from "node:assert/strict";
import test from "node:test";
import { VALID_E2EE_RECORD } from "@/lib/e2ee-test-fixtures";
import type { ManagedContentRuntime } from "@/lib/managed-content-runtime";
import { POST } from "./route";

const auth = async () => ({ userId: "user-1", tokenId: "token-1" });
const plainRecord = {
  dedupKey: "plain-1",
  sessionId: null,
  providerKey: "codex",
  turnRole: "user",
  ts: "2026-07-14T00:00:00.000Z",
  text: "secret prompt",
};
const providers = async () => [
  {
    key: "codex",
    displayName: "Codex",
    serviceNamePatterns: [],
    collectionMethod: "logfile" as const,
    enabled: true,
  },
];

function request(body: unknown, authorization = "Bearer token"): Request {
  return new Request("http://localhost/api/v1/prompts", {
    method: "POST",
    headers: { authorization },
    body: JSON.stringify(body),
  });
}

function streamingRequest(
  chunks: readonly string[],
  options: { contentLength?: string; authorization?: string } = {},
): { request: Request; cancelled: () => boolean; reads: () => number } {
  let index = 0;
  let wasCancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(Buffer.from(chunks[index++]!));
    },
    cancel() { wasCancelled = true; },
  });
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    headers: {
      authorization: options.authorization ?? "Bearer token",
      ...(options.contentLength ? { "content-length": options.contentLength } : {}),
    },
    body: stream,
    duplex: "half",
  };
  return {
    request: new Request("http://localhost/api/v1/prompts", init),
    cancelled: () => wasCancelled,
    reads: () => index,
  };
}

function managedRuntime(): ManagedContentRuntime {
  return {
    installationId: "installation-1",
    registry: {} as ManagedContentRuntime["registry"],
    userKeys: {} as ManagedContentRuntime["userKeys"],
    health: {} as ManagedContentRuntime["health"],
  };
}

test("e2ee prompt route never initializes the managed runtime", async () => {
  let runtimeLoads = 0;
  let e2eeSaves = 0;
  const handler = POST.withDependencies({
    authenticateIngestToken: auth,
    loadProviders: providers,
    getManagedContentRuntime: async () => {
      runtimeLoads += 1;
      throw new Error("must not initialize");
    },
    saveE2eePromptRecords: async () => {
      e2eeSaves += 1;
      return { inserted: 1, deduped: 0 };
    },
  });
  const response = await handler(request([VALID_E2EE_RECORD]));
  assert.equal(response.status, 200);
  assert.equal(runtimeLoads, 0);
  assert.equal(e2eeSaves, 1);
  assert.equal((await response.text()).includes("secret prompt"), false);
});

test("prompt route rejects mixed plaintext and e2ee batches", async () => {
  const handler = POST.withDependencies({ authenticateIngestToken: auth });
  const response = await handler(
    request([VALID_E2EE_RECORD, plainRecord]),
  );
  assert.equal(response.status, 400);
  assert.equal((await response.text()).includes("secret prompt"), false);
});

test("active legacy E2EE account의 schema 없는 payload도 managed 저장한다", async () => {
  const runtime = managedRuntime();
  const calls: unknown[][] = [];
  const handler = POST.withDependencies({
    authenticateIngestToken: auth,
    loadProviders: providers,
    getManagedContentRuntime: async () => runtime,
    saveManagedPromptRecords: async (...args: unknown[]) => {
      calls.push(args);
      return { inserted: 1, deduped: 0 };
    },
  });
  const response = await handler(request([plainRecord]));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { inserted: 1, deduped: 0 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.[0], "user-1");
  assert.equal(calls[0]?.[2], runtime);
});

test("body userId는 인증 token의 소유자 SSOT를 shadow하지 못한다", async () => {
  const runtime = managedRuntime();
  let savedUserId: unknown;
  const handler = POST.withDependencies({
    authenticateIngestToken: auth,
    loadProviders: providers,
    getManagedContentRuntime: async () => runtime,
    saveManagedPromptRecords: async (userId: unknown) => {
      savedUserId = userId;
      return { inserted: 1, deduped: 0 };
    },
  });

  const response = await handler(request([{ ...plainRecord, userId: "other-user" }]));

  assert.equal(response.status, 200);
  assert.equal(savedUserId, "user-1");
});

test("empty batch와 provider 거부는 managed runtime을 초기화하지 않는다", async () => {
  let runtimeLoads = 0;
  const handler = POST.withDependencies({
    authenticateIngestToken: auth,
    loadProviders: providers,
    getManagedContentRuntime: async () => {
      runtimeLoads += 1;
      return managedRuntime();
    },
  });

  const empty = await handler(request([]));
  const unknownProvider = await handler(
    request([{ ...plainRecord, providerKey: "unknown-provider" }]),
  );

  assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), { inserted: 0, deduped: 0 });
  assert.equal(unknownProvider.status, 400);
  assert.equal(runtimeLoads, 0);
});

test("managed runtime disabled는 비민감 no-store 503을 반환한다", async () => {
  const handler = POST.withDependencies({
    authenticateIngestToken: auth,
    loadProviders: providers,
    getManagedContentRuntime: async () => null,
  });

  const response = await handler(request([plainRecord]));

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { code: "CONTENT_COLLECTION_DISABLED" });
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("managed runtime 초기화와 저장 실패는 원문을 숨긴 고정 no-store 503이다", async (t) => {
  for (const [name, overrides] of [
    [
      "runtime",
      {
        getManagedContentRuntime: async () => {
          throw new Error("AWS credential secret prompt request-id=abc");
        },
      },
    ],
    [
      "save",
      {
        getManagedContentRuntime: async () => managedRuntime(),
        saveManagedPromptRecords: async () => {
          throw new Error("postgres secret prompt password=unsafe");
        },
      },
    ],
  ] as const) {
    await t.test(name, async () => {
      const captured: string[] = [];
      const originalError = console.error;
      const originalWarn = console.warn;
      console.error = (...args: unknown[]) => captured.push(args.map(String).join(" "));
      console.warn = (...args: unknown[]) => captured.push(args.map(String).join(" "));
      try {
        const handler = POST.withDependencies({
          authenticateIngestToken: auth,
          loadProviders: providers,
          ...overrides,
        });
        const response = await handler(request([plainRecord]));
        const body = await response.text();

        assert.equal(response.status, 503);
        assert.deepEqual(JSON.parse(body), { code: "CONTENT_KEY_UNAVAILABLE" });
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.equal(body.includes("secret prompt"), false);
        assert.equal(body.includes("request-id"), false);
        assert.equal(body.includes("password"), false);
        assert.equal(captured.join("\n").includes("secret prompt"), false);
      } finally {
        console.error = originalError;
        console.warn = originalWarn;
      }
    });
  }
});

test("E2eePromptSaveError는 transitional 400 code 동작을 유지한다", async () => {
  const { E2eePromptSaveError } = await import("@/lib/prompt-records");
  const handler = POST.withDependencies({
    authenticateIngestToken: auth,
    loadProviders: providers,
    saveE2eePromptRecords: async () => {
      throw new E2eePromptSaveError("CONTENT_OWNER_MISMATCH");
    },
  });

  const response = await handler(request([VALID_E2EE_RECORD]));

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { code: "CONTENT_OWNER_MISMATCH" });
});

test("기존 인증, 4MB, invalid JSON 계약을 유지한다", async () => {
  const unauthorized = await POST.withDependencies({
    authenticateIngestToken: async () => null,
  })(request([plainRecord], "Bearer invalid"));
  assert.equal(unauthorized.status, 401);

  const tooLarge = await POST.withDependencies({
    authenticateIngestToken: auth,
  })(new Request("http://localhost/api/v1/prompts", {
    method: "POST",
    headers: { authorization: "Bearer token" },
    body: "x".repeat(4 * 1024 * 1024 + 1),
  }));
  assert.equal(tooLarge.status, 413);

  const invalidJson = await POST.withDependencies({
    authenticateIngestToken: auth,
  })(new Request("http://localhost/api/v1/prompts", {
    method: "POST",
    headers: { authorization: "Bearer token" },
    body: "{",
  }));
  assert.equal(invalidJson.status, 400);
});

test("prompt route는 인증 뒤 oversized Content-Length를 본문 read 전에 413으로 거부한다", async () => {
  const input = streamingRequest([JSON.stringify([plainRecord])], {
    contentLength: String(4 * 1024 * 1024 + 1),
  });
  const response = await POST.withDependencies({ authenticateIngestToken: auth })(input.request);
  assert.equal(response.status, 413);
  assert.equal(input.request.bodyUsed, false);
});

test("prompt route는 chunked 4MiB 초과를 조기 cancel하고 exact boundary는 허용한다", async () => {
  const oversized = streamingRequest(["[\"", "x".repeat(4 * 1024 * 1024), "\"]"]);
  const oversizedResponse = await POST.withDependencies({ authenticateIngestToken: auth })(oversized.request);
  assert.equal(oversizedResponse.status, 413);
  assert.equal(oversized.request.bodyUsed, true);

  const exactBody = " ".repeat(4 * 1024 * 1024 - 2) + "[]";
  const exact = streamingRequest([exactBody]);
  const exactResponse = await POST.withDependencies({ authenticateIngestToken: auth })(exact.request);
  assert.equal(exactResponse.status, 200);
  assert.deepEqual(await exactResponse.json(), { inserted: 0, deduped: 0 });
});

test("prompt route는 인증 전 본문을 읽지 않고 malformed JSON은 400으로 거부한다", async () => {
  const unauthorized = streamingRequest(["{"], { authorization: "Bearer invalid" });
  const unauthorizedResponse = await POST.withDependencies({
    authenticateIngestToken: async () => null,
  })(unauthorized.request);
  assert.equal(unauthorizedResponse.status, 401);
  assert.equal(unauthorized.request.bodyUsed, false);

  const malformed = await POST.withDependencies({ authenticateIngestToken: auth })(request("{"));
  assert.equal(malformed.status, 400);
});
