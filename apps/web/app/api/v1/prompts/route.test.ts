import assert from "node:assert/strict";
import test from "node:test";
import { VALID_E2EE_RECORD } from "@/lib/e2ee-test-fixtures";
import { POST } from "./route";

const auth = async () => ({ userId: "user-1", tokenId: "token-1" });
const providers = async () => [
  {
    key: "codex",
    displayName: "Codex",
    serviceNamePatterns: [],
    collectionMethod: "logfile" as const,
    enabled: true,
  },
];

test("e2ee prompt route never loads the server KEK", async () => {
  let kekLoads = 0;
  let e2eeSaves = 0;
  const handler = POST.withDependencies({
    authenticateIngestToken: auth,
    loadProviders: providers,
    loadKek: () => {
      kekLoads += 1;
      throw new Error("must not load");
    },
    saveE2eePromptRecords: async () => {
      e2eeSaves += 1;
      return { inserted: 1, deduped: 0 };
    },
  });
  const response = await handler(
    new Request("http://localhost/api/v1/prompts", {
      method: "POST",
      headers: { authorization: "Bearer token" },
      body: JSON.stringify([VALID_E2EE_RECORD]),
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(kekLoads, 0);
  assert.equal(e2eeSaves, 1);
  assert.equal((await response.text()).includes("secret prompt"), false);
});

test("prompt route rejects mixed plaintext and e2ee batches", async () => {
  const handler = POST.withDependencies({ authenticateIngestToken: auth });
  const response = await handler(
    new Request("http://localhost/api/v1/prompts", {
      method: "POST",
      headers: { authorization: "Bearer token" },
      body: JSON.stringify([
        VALID_E2EE_RECORD,
        {
          dedupKey: "legacy",
          sessionId: null,
          providerKey: "codex",
          turnRole: "user",
          ts: "2026-07-14T00:00:00.000Z",
          text: "secret prompt",
        },
      ]),
    }),
  );
  assert.equal(response.status, 400);
  assert.equal((await response.text()).includes("secret prompt"), false);
});

test("active E2EE account rejects new server_v1 prompt writes", async () => {
  let saved = 0;
  const handler = POST.withDependencies({
    authenticateIngestToken: auth,
    loadProviders: providers,
    isE2eeContentActive: async () => true,
    savePromptRecords: async () => {
      saved += 1;
      return { inserted: 1, deduped: 0 };
    },
  });
  const response = await handler(new Request("http://localhost/api/v1/prompts", {
    method: "POST",
    headers: { authorization: "Bearer token" },
    body: JSON.stringify([{
      dedupKey: "legacy",
      sessionId: null,
      providerKey: "codex",
      turnRole: "user",
      ts: "2026-07-14T00:00:00.000Z",
      text: "secret prompt",
    }]),
  }));
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { code: "E2EE_REQUIRED" });
  assert.equal(saved, 0);
});
