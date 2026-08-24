import assert from "node:assert/strict";
import test from "node:test";
import {
  browserSetupConfigured,
  createFirstAdmin,
  hasAdminUser,
  verifyBootstrapSetupToken,
  type SetupPool,
} from "./setup";

test("browser setup은 32자 이상의 별도 token에서만 활성화된다", () => {
  assert.equal(browserSetupConfigured({}), false);
  assert.equal(browserSetupConfigured({ BOOTSTRAP_SETUP_TOKEN: "x".repeat(31) }), false);
  assert.equal(browserSetupConfigured({ BOOTSTRAP_SETUP_TOKEN: "x".repeat(32) }), true);
  assert.equal(
    verifyBootstrapSetupToken("x".repeat(32), { BOOTSTRAP_SETUP_TOKEN: "x".repeat(32) }),
    true,
  );
  assert.equal(
    verifyBootstrapSetupToken("y".repeat(32), { BOOTSTRAP_SETUP_TOKEN: "x".repeat(32) }),
    false,
  );
});

test("설치 완료 여부는 일반 사용자가 아니라 admin 존재로 판단한다", async () => {
  assert.equal(await hasAdminUser({ async query() { return { rows: [], rowCount: 0 }; } }), false);
  assert.equal(
    await hasAdminUser({
      async query<T = Record<string, unknown>>() {
        return { rows: [{ exists: 1 }] as T[], rowCount: 1 };
      },
    }),
    true,
  );
});

function setupPool(adminExists: boolean): {
  pool: SetupPool;
  queries: Array<{ sql: string; params?: unknown[] }>;
  released(): boolean;
} {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  let released = false;
  const pool: SetupPool = {
    async connect() {
      return {
        async query<T = Record<string, unknown>>(sql: string, params?: unknown[]) {
          queries.push({ sql, params });
          if (sql.includes("WHERE role = 'admin'")) {
            return {
              rows: (adminExists ? [{ exists: 1 }] : []) as T[],
              rowCount: adminExists ? 1 : 0,
            };
          }
          if (sql.includes("INSERT INTO users")) {
            return { rows: [{ id: "admin-1" }] as T[], rowCount: 1 };
          }
          return { rows: [] as T[], rowCount: 0 };
        },
        release() { released = true; },
      };
    },
  };
  return { pool, queries, released: () => released };
}

test("첫 admin은 transaction advisory lock 뒤 생성된다", async () => {
  const fixture = setupPool(false);
  const result = await createFirstAdmin(fixture.pool, {
    email: "admin@example.com",
    name: "Admin",
    passwordHash: "hash",
  });

  assert.deepEqual(result, { ok: true, id: "admin-1" });
  assert.deepEqual(
    fixture.queries.map(({ sql }) => sql.split("\n")[0]),
    [
      "BEGIN",
      "SELECT pg_advisory_xact_lock(hashtext($1))",
      "SELECT 1 FROM users WHERE role = 'admin' LIMIT 1",
      "INSERT INTO users (email, name, password_hash, role)",
      "COMMIT",
    ],
  );
  assert.deepEqual(fixture.queries[1]?.params, ["toard:bootstrap-admin"]);
  assert.equal(fixture.released(), true);
});

test("lock 획득 뒤 admin이 확인되면 추가 생성 없이 rollback한다", async () => {
  const fixture = setupPool(true);
  const result = await createFirstAdmin(fixture.pool, {
    email: "second@example.com",
    name: "Second",
    passwordHash: "hash",
  });

  assert.deepEqual(result, { ok: false, reason: "admin-exists" });
  assert.deepEqual(
    fixture.queries.map(({ sql }) => sql),
    [
      "BEGIN",
      "SELECT pg_advisory_xact_lock(hashtext($1))",
      "SELECT 1 FROM users WHERE role = 'admin' LIMIT 1",
      "ROLLBACK",
    ],
  );
  assert.equal(fixture.released(), true);
});

test("OAuth-only bootstrap은 password hash 없이도 같은 직렬화 경계를 사용한다", async () => {
  const fixture = setupPool(false);
  const result = await createFirstAdmin(fixture.pool, {
    email: "oauth-admin@example.com",
    name: "OAuth Admin",
    passwordHash: null,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(fixture.queries[3]?.params, ["oauth-admin@example.com", "OAuth Admin", null]);
});
