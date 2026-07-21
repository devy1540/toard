import assert from "node:assert/strict";
import test from "node:test";
import { GET as statusGet } from "./route";

const ADMIN = { role: "admin" } as never;
const MEMBER = { role: "member" } as never;

test("암호화 상태 API는 401/403/200 모두 no-store다", async () => {
  const unauthorized = await statusGet.withDependencies({ getSessionUser: async () => null })();
  const forbidden = await statusGet.withDependencies({ getSessionUser: async () => MEMBER })();
  const ok = await statusGet.withDependencies({
    getSessionUser: async () => ADMIN,
    getEncryptionAdminStatus: async () => ({ enabled: false }) as never,
  })();

  assert.deepEqual(await unauthorized.json(), { error: "unauthorized" });
  assert.deepEqual(await forbidden.json(), { error: "forbidden" });
  assert.equal(unauthorized.status, 401);
  assert.equal(forbidden.status, 403);
  assert.equal(ok.status, 200);
  for (const response of [unauthorized, forbidden, ok]) {
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});

test("내부 실패는 secret과 상세를 숨기며 거짓 status를 반환하지 않는다", async () => {
  const response = await statusGet.withDependencies({
    getSessionUser: async () => ADMIN,
    getEncryptionAdminStatus: async () => {
      throw new Error("credential=secret SELECT content_key_operation_daily internal.ts:20");
    },
  })();
  const text = await response.text();

  assert.equal(response.status, 500);
  assert.deepEqual(JSON.parse(text), { error: "internal error" });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.doesNotMatch(text, /credential|secret|SELECT|internal\.ts/i);
});
