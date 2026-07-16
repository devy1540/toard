import assert from "node:assert/strict";
import test from "node:test";
import {
  AppRoleTokenSource,
  FileTokenSource,
  KubernetesTokenSource,
} from "./transit-token-source";

type RecordedRequest = {
  url: string;
  init: RequestInit;
  body: Record<string, string>;
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("token-file source는 매 요청 최신 secret file을 읽고 임시 Buffer를 지운다", async () => {
  const files = new Map<string, Buffer>([
    ["/run/secrets/token", Buffer.from("token-a\n")],
  ]);
  const returned: Buffer[] = [];
  const source = new FileTokenSource(
    "/run/secrets/token",
    async (path) => {
      const value = Buffer.from(files.get(path) ?? []);
      returned.push(value);
      return value;
    },
  );

  assert.equal(await source.getToken(), "token-a");
  files.set("/run/secrets/token", Buffer.from("token-b\n"));
  assert.equal(await source.getToken(), "token-b");
  assert.deepEqual(returned.map((value) => [...value]), [
    [...Buffer.alloc(8)],
    [...Buffer.alloc(8)],
  ]);
  assert.deepEqual(source.description, {
    kind: "transit-token-file",
    staticCredential: true,
  });
});

test("token-file source는 절대 경로와 non-blank token만 허용한다", async () => {
  assert.throws(
    () => new FileTokenSource("relative/token", async () => Buffer.from("token")),
    /TRANSIT_TOKEN_FILE_PATH_INVALID/,
  );
  const source = new FileTokenSource(
    "/run/secrets/token",
    async () => Buffer.from(" \n\t"),
  );
  await assert.rejects(
    source.getToken(),
    (error: Error) => error.message === "TRANSIT_TOKEN_INVALID",
  );

  const secret = "token-leaked-by-filesystem-error";
  const failed = new FileTokenSource(
    "/run/secrets/token",
    async () => {
      throw new Error(secret);
    },
  );
  await assert.rejects(
    failed.getToken(),
    (error: Error) => (
      error.message === "TRANSIT_SECRET_FILE_READ_FAILED"
      && !error.message.includes(secret)
    ),
  );
});

test("AppRole source는 만료 30초 전에 다시 로그인하고 동시 요청을 single-flight한다", async () => {
  let now = 1_000;
  let loginCalls = 0;
  let releaseLogin: (() => void) | undefined;
  const requests: RecordedRequest[] = [];
  const requestBodies: Buffer[] = [];
  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    loginCalls += 1;
    assert.ok(Buffer.isBuffer(init.body));
    requestBodies.push(init.body);
    const body = JSON.parse(String(init.body)) as Record<string, string>;
    requests.push({ url: String(input), init, body });
    if (loginCalls === 2) {
      await new Promise<void>((resolve) => {
        releaseLogin = resolve;
      });
    }
    return jsonResponse({
      request_id: "must-not-be-propagated",
      auth: {
        client_token: loginCalls === 1 ? "first-token" : "second-token",
        lease_duration: 1_200,
        renewable: true,
      },
    });
  };
  const source = new AppRoleTokenSource({
    address: "https://vault.example.com/",
    mount: "approle",
    roleIdFile: "/run/secrets/role-id",
    secretIdFile: "/run/secrets/secret-id",
    namespace: "team-a",
    fetch,
    now: () => now,
    readFile: async (path) => Buffer.from(
      path.endsWith("role-id") ? "role-value\n" : "secret-value\n",
    ),
  });

  assert.equal(await source.getToken(), "first-token");
  now += 1_171_000;
  const first = source.getToken();
  const second = source.getToken();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(loginCalls, 2);
  releaseLogin?.();
  assert.equal(await first, "second-token");
  assert.equal(await second, "second-token");
  assert.deepEqual(requests.map((request) => request.body), [
    { role_id: "role-value", secret_id: "secret-value" },
    { role_id: "role-value", secret_id: "secret-value" },
  ]);
  assert.equal(requests[0]!.url, "https://vault.example.com/v1/auth/approle/login");
  assert.equal(
    new Headers(requests[0]!.init.headers).get("x-vault-namespace"),
    "team-a",
  );
  assert.ok(requests[0]!.init.signal instanceof AbortSignal);
  assert.deepEqual(
    requestBodies.map((body) => [...body]),
    requestBodies.map((body) => [...Buffer.alloc(body.length)]),
  );
  assert.deepEqual(source.description, {
    kind: "transit-approle",
    staticCredential: true,
  });
});

test("Kubernetes source는 JWT login만 사용하고 원격 오류의 비밀을 노출하지 않는다", async () => {
  const secretJwt = "ey-secret-jwt";
  const fetch: typeof globalThis.fetch = async () => jsonResponse({
    errors: [`jwt=${secretJwt}`],
    request_id: "sensitive-request-id",
  }, 403);
  const source = new KubernetesTokenSource({
    address: "https://openbao.example.com",
    mount: "kubernetes",
    role: "toard",
    jwtFile: "/var/run/secrets/kubernetes.io/serviceaccount/token",
    fetch,
    readFile: async () => Buffer.from(secretJwt),
  });

  await assert.rejects(
    source.getToken(),
    (error: Error) => (
      error.message === "TRANSIT_AUTH_FAILED"
      && !error.message.includes(secretJwt)
      && !error.message.includes("sensitive-request-id")
    ),
  );
  assert.deepEqual(source.description, {
    kind: "transit-kubernetes",
    staticCredential: false,
  });
});

test("login source는 invalid JSON과 malformed auth data를 고정 오류로 거부한다", async () => {
  const base = {
    address: "https://vault.example.com",
    mount: "approle",
    roleIdFile: "/run/secrets/role-id",
    secretIdFile: "/run/secrets/secret-id",
    readFile: async () => Buffer.from("secret"),
  };
  const invalidJson = new AppRoleTokenSource({
    ...base,
    fetch: async () => new Response("{not-json", { status: 200 }),
  });
  await assert.rejects(
    invalidJson.getToken(),
    (error: Error) => error.message === "TRANSIT_AUTH_RESPONSE_INVALID",
  );

  const malformed = new AppRoleTokenSource({
    ...base,
    fetch: async () => jsonResponse({
      auth: { client_token: "", lease_duration: 0 },
    }),
  });
  await assert.rejects(
    malformed.getToken(),
    (error: Error) => error.message === "TRANSIT_AUTH_RESPONSE_INVALID",
  );
});
