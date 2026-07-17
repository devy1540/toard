import assert from "node:assert/strict";
import test from "node:test";
import { POST as commitPost, postManagedMigrationCommit } from "./commit/route";
import { GET as pageGet, getManagedMigrationPageResponse } from "./page/route";
import { POST as statePost, postManagedMigrationState } from "./state/route";
import { GET as statusGet, getManagedMigrationStatusResponse } from "./status/route";
import { E2eeManagedMigrationError } from "@/lib/e2ee-to-managed-migration";

const USER = "11111111-1111-4111-8111-111111111111";
const DIGEST = Buffer.alloc(32).toString("base64url");

test("open mode는 managed migration 모든 endpoint를 403/no-store로 막는다", async () => {
  const previous = process.env.AUTH_MODE; process.env.AUTH_MODE = "open";
  try {
    const responses = await Promise.all([
      statusGet(), pageGet(new Request("http://localhost/api/content/managed-migration/page")),
      commitPost(new Request("http://localhost/api/content/managed-migration/commit", { method: "POST" })),
      statePost(new Request("http://localhost/api/content/managed-migration/state", { method: "POST" })),
    ]);
    for (const response of responses) {
      assert.equal(response.status, 403); assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(await response.json(), { code: "E2EE_AUTH_REQUIRED" });
    }
  } finally { if (previous === undefined) delete process.env.AUTH_MODE; else process.env.AUTH_MODE = previous; }
});

test("로그인 세션이 없으면 commit은 body/runtime 전에 401/no-store다", async () => {
  let runtimeCalls = 0;
  const response = await postManagedMigrationCommit(new Request("http://localhost", { method: "POST" }), {
    isAuthOpen: () => false, requireSession: async () => null,
    capability: async () => "migration",
    getRuntime: async () => { runtimeCalls += 1; return null; },
    commit: async () => { throw new Error("unused"); },
  });
  assert.equal(response.status, 401); assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(runtimeCalls, 0); assert.deepEqual(await response.json(), { code: "UNAUTHORIZED" });
});

test("commit은 4MiB Content-Length와 chunked overflow를 JSON parse/runtime 전에 거부한다", async () => {
  let runtimeCalls = 0;
  const dependencies = {
    isAuthOpen: () => false, requireSession: async () => USER,
    capability: async () => "migration" as const,
    getRuntime: async () => { runtimeCalls += 1; return null; },
    commit: async () => { throw new Error("must not run"); },
  };
  const tooLong = new Request("http://localhost", { method: "POST", headers: { "content-length": "4194305" }, body: "{}" });
  const first = await postManagedMigrationCommit(tooLong, dependencies);
  assert.equal(first.status, 413); assert.equal(runtimeCalls, 0);
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(4_194_305)); controller.close(); } });
  const second = await postManagedMigrationCommit(new Request("http://localhost", { method: "POST", body: stream, duplex: "half" } as RequestInit), dependencies);
  assert.equal(second.status, 413); assert.equal(runtimeCalls, 0);
});

test("commit은 strict parser 뒤 runtime을 얻고 exception/plaintext 없이 safe code만 반환한다", async () => {
  const secret = "do-not-echo-this"; let runtimeCalls = 0;
  const base = { isAuthOpen: () => false, requireSession: async () => USER,
    capability: async () => "migration" as const,
    getRuntime: async () => { runtimeCalls += 1; return {} as never; } };
  const invalid = await postManagedMigrationCommit(new Request("http://localhost", { method: "POST", body: JSON.stringify({ items: [{ id: "1", sourceDigest: DIGEST, text: "" }] }) }),
    { ...base, commit: async () => { throw new Error("unused"); } });
  assert.equal(invalid.status, 400); assert.equal(runtimeCalls, 0); assert.equal((await invalid.text()).includes(secret), false);
  const failed = await postManagedMigrationCommit(new Request("http://localhost", { method: "POST", body: JSON.stringify({ items: [{ id: "1", sourceDigest: DIGEST, text: secret }] }) }),
    { ...base, commit: async () => { throw new Error(secret); } });
  assert.equal(failed.status, 503); const body = await failed.text();
  assert.equal(body.includes(secret), false); assert.deepEqual(JSON.parse(body), { code: "MIGRATION_FAILED" });
  assert.equal(failed.headers.get("cache-control"), "no-store");
  const branded = await postManagedMigrationCommit(new Request("http://localhost", { method: "POST", body: JSON.stringify({ items: [{ id: "1", sourceDigest: DIGEST, text: secret }] }) }),
    { ...base, commit: async () => { throw new E2eeManagedMigrationError(secret); } });
  assert.equal(branded.status, 503); assert.deepEqual(await branded.json(), { code: "MIGRATION_FAILED" });
  for (const code of ["MIGRATION_FAILED", "MANAGED_ROUND_TRIP_FAILED", "E2EE_SOURCE_CORRUPT"] as const) {
    const internal = await postManagedMigrationCommit(new Request("http://localhost", { method: "POST", body: JSON.stringify({ items: [{ id: "1", sourceDigest: DIGEST, text: secret }] }) }),
      { ...base, commit: async () => { throw new E2eeManagedMigrationError(code); } });
    assert.equal(internal.status, 503, code);
    assert.deepEqual(await internal.json(), { code });
  }
});

test("status DB failure와 session helper throw는 secret-free 503/no-store다", async () => {
  const secret = "postgresql://secret";
  for (const dependencies of [
    { isAuthOpen: () => false, requireSession: async () => USER,
      capability: async () => "migration" as const,
      status: async () => { throw new E2eeManagedMigrationError("MIGRATION_FAILED"); } },
    { isAuthOpen: () => false, requireSession: async () => { throw new Error(secret); },
      capability: async () => "migration" as const,
      status: async () => { throw new Error("unused"); } },
  ]) {
    const response = await getManagedMigrationStatusResponse(dependencies);
    assert.equal(response.status, 503); assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal((await response.text()).includes(secret), false);
  }
  const missing = await getManagedMigrationStatusResponse({
    isAuthOpen: () => false, requireSession: async () => USER,
    capability: async () => "migration",
    status: async () => { throw new E2eeManagedMigrationError("MIGRATION_NOT_FOUND"); },
  });
  assert.equal(missing.status, 409); assert.deepEqual(await missing.json(), { code: "MIGRATION_NOT_FOUND" });
});

test("commit은 malformed UTF-8 JSON을 runtime 전에 거부한다", async () => {
  let runtimeCalls = 0;
  const response = await postManagedMigrationCommit(new Request("http://localhost", {
    method: "POST", body: new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]),
  }), {
    isAuthOpen: () => false, requireSession: async () => USER,
    capability: async () => "migration",
    getRuntime: async () => { runtimeCalls += 1; return null; },
    commit: async () => { throw new Error("unused"); },
  });
  assert.equal(response.status, 400); assert.equal(runtimeCalls, 0);
  assert.deepEqual(await response.json(), { code: "INVALID_JSON" });
});

test("managed migration 4 routes는 disabled에서 body/runtime/downstream 전에 410이다", async () => {
  let bodyReads = 0; let downstream = 0;
  const body = new Request("http://localhost", { method: "POST", body: "{}" });
  Object.defineProperty(body, "text", { value: async () => { bodyReads += 1; return "{}"; } });
  const common = { isAuthOpen: () => false, requireSession: async () => USER, capability: async () => "disabled" as const };
  const responses = [
    await getManagedMigrationStatusResponse({ ...common, status: async () => { downstream += 1; return {}; } }),
    await getManagedMigrationPageResponse(new Request("http://localhost?limit=5"), { ...common, page: async () => { downstream += 1; return {} as never; } }),
    await postManagedMigrationState(body, { ...common, state: async () => { downstream += 1; return {} as never; } }),
    await postManagedMigrationCommit(body, { ...common, getRuntime: async () => { downstream += 1; return null; }, commit: async () => { downstream += 1; return {} as never; } }),
  ];
  for (const response of responses) {
    assert.equal(response.status, 410); assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { code: "E2EE_SETUP_RETIRED" });
  }
  assert.equal(bodyReads, 0); assert.equal(downstream, 0);
});

test("managed migration gate 실패는 500이고 migration/recovery는 기존 payload를 유지한다", async () => {
  const common = {
    isAuthOpen: () => false,
    requireSession: async () => USER,
    capability: async () => { throw new Error("secret"); },
  };
  const failed = [
    await getManagedMigrationStatusResponse({ ...common, status: async () => ({}) }),
    await getManagedMigrationPageResponse(new Request("http://localhost?limit=5"), { ...common, page: async () => ({}) }),
    await postManagedMigrationState(new Request("http://localhost", { method: "POST", body: "{}" }), { ...common, state: async () => ({}) }),
    await postManagedMigrationCommit(new Request("http://localhost", { method: "POST", body: "{}" }), {
      ...common, getRuntime: async () => null, commit: async () => ({} as never),
    }),
  ];
  for (const response of failed) {
    assert.equal(response.status, 500); assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { code: "E2EE_LEGACY_GATE_FAILED" });
  }
  for (const capability of ["migration", "recovery"] as const) {
    const response = await getManagedMigrationStatusResponse({
      isAuthOpen: () => false, requireSession: async () => USER,
      capability: async () => capability, status: async () => ({ capability }),
    });
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { capability });
  }
});
