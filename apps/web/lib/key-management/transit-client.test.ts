import assert from "node:assert/strict";
import test from "node:test";
import { TransitClient } from "./transit-client";
import type { TransitTokenSource } from "./transit-token-source";

const PAYLOAD = Buffer.alloc(68, 0x5a);
const AAD = Buffer.from('{"userId":"user-a"}');
const CIPHERTEXT = "vault:v1:Y2lwaGVydGV4dA==";

type RecordedRequest = {
  url: string;
  method: string;
  headers: Headers;
  body: Record<string, string>;
  signal: AbortSignal | null;
};

const TOKEN_SOURCE: TransitTokenSource = {
  description: {
    kind: "transit-kubernetes",
    staticCredential: false,
  },
  async getToken() {
    return "vault-token";
  },
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("Transit client는 associated_data와 namespace를 encrypt/decrypt에 동일 적용한다", async () => {
  const requests: RecordedRequest[] = [];
  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    requests.push({
      url: String(input),
      method: init.method ?? "GET",
      headers: new Headers(init.headers),
      body: JSON.parse(String(init.body)) as Record<string, string>,
      signal: init.signal ?? null,
    });
    if (requests.length === 1) {
      return response({ data: { ciphertext: CIPHERTEXT } });
    }
    return response({ data: { plaintext: PAYLOAD.toString("base64") } });
  };
  const client = new TransitClient({
    address: "https://vault.example.com",
    mount: "team/transit",
    keyName: "toard-user-keys",
    namespace: "team-a",
    tokenSource: TOKEN_SOURCE,
    fetch,
  });

  const ciphertext = await client.encrypt(PAYLOAD, AAD);
  const plaintext = await client.decrypt(ciphertext, AAD);
  assert.equal(ciphertext, CIPHERTEXT);
  assert.equal(
    requests[0]!.url,
    "https://vault.example.com/v1/team/transit/encrypt/toard-user-keys",
  );
  assert.equal(requests[1]!.url,
    "https://vault.example.com/v1/team/transit/decrypt/toard-user-keys");
  assert.deepEqual(requests.map((request) => request.body), [
    {
      plaintext: PAYLOAD.toString("base64"),
      associated_data: AAD.toString("base64"),
    },
    {
      ciphertext,
      associated_data: AAD.toString("base64"),
    },
  ]);
  for (const request of requests) {
    assert.equal(request.method, "POST");
    assert.equal(request.headers.get("content-type"), "application/json");
    assert.equal(request.headers.get("x-vault-token"), "vault-token");
    assert.equal(request.headers.get("x-vault-namespace"), "team-a");
    assert.ok(request.signal instanceof AbortSignal);
  }
  assert.deepEqual(plaintext, PAYLOAD);
  assert.deepEqual(await client.describeCredentialSource(), TOKEN_SOURCE.description);
});

test("Transit client 직접 생성은 unsafe address와 빈 path segment를 거부한다", () => {
  for (const address of [
    "http://vault.example.com",
    "https://user:pass@vault.example.com",
    "https://vault.example.com?token=secret",
    "https://vault.example.com#fragment",
    " https://vault.example.com",
  ]) {
    assert.throws(
      () => new TransitClient({
        address,
        mount: "transit",
        keyName: "toard",
        tokenSource: TOKEN_SOURCE,
      }),
      /TRANSIT_ADDRESS_INVALID/,
    );
  }
  for (const [mount, keyName] of [
    ["", "toard"],
    ["transit", ""],
    [".", "toard"],
    ["transit", ".."],
    ["transit\nmount", "toard"],
    ["team//transit", "toard"],
    ["team/../transit", "toard"],
    ["team/%2F/transit", "toard"],
    ["team\\transit", "toard"],
    ["transit", "toard/user-keys"],
    ["transit", "toard\\user-keys"],
    ["transit", "%2e%2e"],
  ] satisfies Array<[string, string]>) {
    assert.throws(
      () => new TransitClient({
        address: "https://vault.example.com",
        mount,
        keyName,
        tokenSource: TOKEN_SOURCE,
      }),
      /TRANSIT_PATH_INVALID/,
    );
  }
});

test("Transit client는 namespace와 token header를 fetch 전에 strict 검증한다", async () => {
  for (const namespace of [
    " team-a",
    "team-a ",
    "team a",
    "팀-a",
    "tëam-a",
    "team\r\nx-injected: yes",
    "team\u007fvalue",
    "x".repeat(513),
  ]) {
    assert.throws(
      () => new TransitClient({
        address: "https://vault.example.com",
        mount: "transit",
        keyName: "toard",
        namespace,
        tokenSource: TOKEN_SOURCE,
      }),
      /TRANSIT_NAMESPACE_INVALID/,
    );
  }

  for (const token of [
    " token",
    "token ",
    "token value",
    "토큰",
    "tökën",
    "token\r\nx-injected: yes",
    "token\u0000value",
    "token\u007fvalue",
    "x".repeat(4_097),
  ]) {
    let fetchCalls = 0;
    const client = new TransitClient({
      address: "https://vault.example.com",
      mount: "transit",
      keyName: "toard",
      tokenSource: {
        description: TOKEN_SOURCE.description,
        async getToken() {
          return token;
        },
      },
      fetch: async () => {
        fetchCalls += 1;
        return response({});
      },
    });
    await assert.rejects(
      client.encrypt(PAYLOAD, AAD),
      (error: Error) => error.message === "TRANSIT:AUTH_FAILED",
    );
    assert.equal(fetchCalls, 0);
  }
});

test("Transit client는 HTTP status와 response shape를 비민감 고정 오류로 분류한다", async () => {
  const secret = "vault-secret-token";
  const cases: Array<[number, string]> = [
    [401, "TRANSIT:AUTH_FAILED"],
    [403, "TRANSIT:AUTH_FAILED"],
    [404, "TRANSIT:KEY_NOT_FOUND"],
    [429, "TRANSIT:THROTTLED"],
    [500, "TRANSIT:TEMPORARY"],
    [400, "TRANSIT:FAILED"],
  ];
  for (const [status, expected] of cases) {
    const client = new TransitClient({
      address: "https://vault.example.com",
      mount: "transit",
      keyName: "toard",
      tokenSource: TOKEN_SOURCE,
      fetch: async () => response({
        errors: [`token=${secret}`],
        request_id: "sensitive-request-id",
      }, status),
    });
    await assert.rejects(
      client.encrypt(PAYLOAD, AAD),
      (error: Error) => (
        error.message === expected
        && !error.message.includes(secret)
        && !error.message.includes("sensitive-request-id")
      ),
    );
  }

  for (const fetch of [
    async () => new Response("{invalid", { status: 200 }),
    async () => response({}),
    async () => response({ data: { ciphertext: "" } }),
    async () => response({ data: { ciphertext: { secret } } }),
    async () => response({ data: { ciphertext: "not-a-transit-ciphertext" } }),
    async () => response({ data: { ciphertext: "vault:v0:YQ==" } }),
    async () => response({ data: { ciphertext: "vault:v01:YQ==" } }),
    async () => response({ data: { ciphertext: "vault:v1:not_base64" } }),
    async () => response({ data: { ciphertext: "vault:v1:YQ==\r\n" } }),
    async () => response({
      data: { ciphertext: `vault:v1:${"YQ==".repeat(4_097)}` },
    }),
  ] satisfies Array<typeof globalThis.fetch>) {
    const client = new TransitClient({
      address: "https://vault.example.com",
      mount: "transit",
      keyName: "toard",
      tokenSource: TOKEN_SOURCE,
      fetch,
    });
    await assert.rejects(
      client.encrypt(PAYLOAD, AAD),
      (error: Error) => (
        error.message === "TRANSIT:RESPONSE_INVALID"
        && !error.message.includes(secret)
      ),
    );
  }
});

test("Transit client는 malformed base64 plaintext와 transport detail을 노출하지 않는다", async () => {
  const secret = "transport-secret";
  const malformed = new TransitClient({
    address: "https://vault.example.com",
    mount: "transit",
    keyName: "toard",
    tokenSource: TOKEN_SOURCE,
    fetch: async () => response({ data: { plaintext: "@@@not-base64@@@" } }),
  });
  await assert.rejects(
    malformed.decrypt(CIPHERTEXT, AAD),
    (error: Error) => error.message === "TRANSIT:RESPONSE_INVALID",
  );

  for (const ciphertext of [
    "ciphertext",
    "vault:v0:YQ==",
    "vault:v1:not_base64",
    "vault:v1:YQ==\r\n",
    `vault:v1:${"YQ==".repeat(4_097)}`,
  ]) {
    let fetchCalls = 0;
    await assert.rejects(
      new TransitClient({
        address: "https://vault.example.com",
        mount: "transit",
        keyName: "toard",
        tokenSource: TOKEN_SOURCE,
        fetch: async () => {
          fetchCalls += 1;
          return response({});
        },
      }).decrypt(ciphertext, AAD),
      (error: Error) => error.message === "TRANSIT:RESPONSE_INVALID",
    );
    assert.equal(fetchCalls, 0);
  }

  const failed = new TransitClient({
    address: "https://vault.example.com",
    mount: "transit",
    keyName: "toard",
    tokenSource: TOKEN_SOURCE,
    fetch: async () => {
      throw Object.assign(new Error(`token=${secret}`), {
        requestId: "sensitive-request-id",
      });
    },
  });
  await assert.rejects(
    failed.encrypt(PAYLOAD, AAD),
    (error: Error) => (
      error.message === "TRANSIT:TEMPORARY"
      && !error.message.includes(secret)
      && !error.message.includes("sensitive-request-id")
    ),
  );
});
