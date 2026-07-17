import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { GET as historyGet } from "../app/api/content/history/sessions/route";
import { GET as statusGet } from "../app/api/content/status/route";
import { POST as setupPost } from "../app/api/v1/content/setup/route";
import { POST as activatePost } from "../app/api/v1/content/activate/route";
import { POST as approvalListPost } from "../app/api/v1/content/approval-requests/route";

test("open mode blocks E2EE content endpoints with no-store", async () => {
  const previous = process.env.AUTH_MODE;
  process.env.AUTH_MODE = "open";
  try {
    const responses = await Promise.all([
      statusGet(),
      historyGet(new Request("http://localhost/api/content/history/sessions")),
    ]);
    for (const response of responses) {
      assert.equal(response.status, 403);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(await response.json(), { code: "E2EE_AUTH_REQUIRED" });
    }
  } finally {
    if (previous === undefined) delete process.env.AUTH_MODE;
    else process.env.AUTH_MODE = previous;
  }
});

test("history middleware delegates nonce CSP and disables response transforms", () => {
  const source = readFileSync(new URL("../middleware.ts", import.meta.url), "utf8");
  assert.match(source, /createHistoryCsp\(nonce\)/);
  assert.match(source, /HISTORY_CACHE_CONTROL/);
  assert.doesNotMatch(source, /require-trusted-types-for/);
});

test("신규 E2EE setup/activate는 인증 뒤 body parsing과 계정 mutation 없이 410이다", async () => {
  let setupMutations = 0;
  let activateMutations = 0;
  let bodyReads = 0;
  const request = new Request("http://localhost/api/v1/content/activate", {
    method: "POST",
    headers: { authorization: "Bearer test" },
    body: "this is intentionally invalid JSON",
  });
  Object.defineProperty(request, "text", {
    value: async () => { bodyReads += 1; throw new Error("body must not be read"); },
  });
  const authenticated = async () => ({ userId: "11111111-1111-4111-8111-111111111111", tokenId: "token" });

  const setup = await setupPost.withDependencies({
    authenticate: authenticated,
    prepare: async () => { setupMutations += 1; throw new Error("must not run"); },
  })(new Request("http://localhost/api/v1/content/setup", { method: "POST", headers: { authorization: "Bearer test" } }));
  const activate = await activatePost.withDependencies({
    authenticate: authenticated,
    activate: async () => { activateMutations += 1; throw new Error("must not run"); },
  })(request);

  for (const response of [setup, activate]) {
    assert.equal(response.status, 410);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { code: "E2EE_SETUP_RETIRED" });
  }
  assert.equal(setupMutations, 0);
  assert.equal(activateMutations, 0);
  assert.equal(bodyReads, 0);
});

test("retired E2EE route는 인증 실패를 기존처럼 401로 먼저 반환한다", async () => {
  for (const route of [setupPost, activatePost]) {
    const response = await route.withDependencies({ authenticate: async () => null })(
      new Request("http://localhost", { method: "POST" }),
    );
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { code: "UNAUTHORIZED" });
  }
});

test("approval list는 migration/recovery만 유지하고 disabled는 410으로 숨긴다", async () => {
  const authenticate = async () => ({ userId: "11111111-1111-4111-8111-111111111111", tokenId: "token" });
  for (const capability of ["migration", "recovery"] as const) {
    let calls = 0;
    const response = await approvalListPost.withDependencies({
      authenticate,
      capability: async () => capability,
      list: async () => { calls += 1; return [{ id: capability }] as never; },
    })(new Request("http://localhost", { method: "POST" }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { requests: [{ id: capability }] });
    assert.equal(calls, 1);
  }

  let calls = 0;
  const retired = await approvalListPost.withDependencies({
    authenticate,
    capability: async () => "disabled",
    list: async () => { calls += 1; return [] as never; },
  })(new Request("http://localhost", { method: "POST" }));
  assert.equal(retired.status, 410);
  assert.deepEqual(await retired.json(), { code: "E2EE_SETUP_RETIRED" });
  assert.equal(calls, 0);
});

test("approval list gate 실패는 safe 500/no-store이고 account 상태를 노출하지 않는다", async () => {
  const response = await approvalListPost.withDependencies({
    authenticate: async () => ({ userId: "11111111-1111-4111-8111-111111111111", tokenId: "token" }),
    capability: async () => { throw new Error("database password"); },
    list: async () => { throw new Error("must not run"); },
  })(new Request("http://localhost", { method: "POST" }));
  assert.equal(response.status, 500);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { code: "DEVICE_APPROVAL_LIST_FAILED" });
});

test("retired route 인증 helper 예외는 secret-free 500/no-store로 닫힌다", async () => {
  const secret = "postgresql://must-not-leak";
  const cases = [
    [setupPost, "CONTENT_SETUP_FAILED"],
    [activatePost, "CONTENT_ACTIVATION_FAILED"],
    [approvalListPost, "DEVICE_APPROVAL_LIST_FAILED"],
  ] as const;
  for (const [route, code] of cases) {
    const response = await route.withDependencies({
      authenticate: async () => { throw new Error(secret); },
    })(new Request("http://localhost", { method: "POST" }));
    assert.equal(response.status, 500);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.text();
    assert.equal(body.includes(secret), false);
    assert.deepEqual(JSON.parse(body), { code });
  }
});

test("기존 recovery와 managed migration route는 E2EE 잔여 데이터 처리를 위해 유지된다", () => {
  const recoveryWrapper = readFileSync(new URL("../app/api/content/recovery/wrapper/route.ts", import.meta.url), "utf8");
  const recoveryComplete = readFileSync(new URL("../app/api/content/recovery/complete/route.ts", import.meta.url), "utf8");
  const migrationPage = readFileSync(new URL("../app/api/content/managed-migration/page/route.ts", import.meta.url), "utf8");
  const migrationCommit = readFileSync(new URL("../app/api/content/managed-migration/commit/route.ts", import.meta.url), "utf8");
  const migrationStatus = readFileSync(new URL("../app/api/content/managed-migration/status/route.ts", import.meta.url), "utf8");
  const migrationState = readFileSync(new URL("../app/api/content/managed-migration/state/route.ts", import.meta.url), "utf8");
  assert.match(recoveryWrapper, /getRecoveryWrapper/);
  assert.match(recoveryComplete, /registerRecoveredBrowser/);
  assert.match(migrationPage, /getE2eeManagedMigrationPage/);
  assert.match(migrationCommit, /commitE2eeManagedBatch/);
  assert.match(migrationStatus, /getE2eeManagedMigrationStatus/);
  assert.match(migrationState, /setE2eeManagedMigrationState/);
});
