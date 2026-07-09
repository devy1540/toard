import assert from "node:assert/strict";
import test from "node:test";
import { assignUserRoleWithPool, parseUserRole, type RolePool } from "./admin-members";

type Query = { sql: string; params?: unknown[] };
type Response = { rows: unknown[]; rowCount?: number };

function createPool(responses: Response[]) {
  const queries: Query[] = [];
  let released = false;
  let connected = false;

  const pool: RolePool = {
    async connect() {
      connected = true;
      return {
        async query<T>(sql: string, params?: unknown[]) {
          queries.push({ sql, params });
          if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
          const response = responses.shift();
          if (!response) throw new Error(`No response for query: ${sql}`);
          return response as { rows: T[]; rowCount?: number };
        },
        release() {
          released = true;
        },
      };
    },
  };

  return {
    pool,
    queries,
    get connected() {
      return connected;
    },
    get released() {
      return released;
    },
  };
}

test("parseUserRole accepts only supported roles", () => {
  assert.equal(parseUserRole("member"), "member");
  assert.equal(parseUserRole("admin"), "admin");
  assert.equal(parseUserRole("owner"), null);
});

test("assignUserRoleWithPool rejects invalid roles before opening a connection", async () => {
  const fixture = createPool([]);

  const result = await assignUserRoleWithPool(fixture.pool, "user-1", "owner");

  assert.deepEqual(result, { ok: false, reason: "invalid-role" });
  assert.equal(fixture.connected, false);
  assert.equal(fixture.queries.length, 0);
});

test("assignUserRoleWithPool rejects demoting the last admin", async () => {
  const fixture = createPool([
    { rows: [{ role: "admin" }], rowCount: 1 },
    { rows: [{ id: "admin-1" }], rowCount: 1 },
  ]);

  const result = await assignUserRoleWithPool(fixture.pool, "admin-1", "member");

  assert.deepEqual(result, { ok: false, reason: "last-admin" });
  assert.deepEqual(
    fixture.queries.map((q) => q.sql),
    [
      "BEGIN",
      "SELECT role FROM users WHERE id = $1 FOR UPDATE",
      "SELECT id FROM users WHERE role = 'admin' FOR UPDATE",
      "ROLLBACK",
    ],
  );
  assert.equal(fixture.released, true);
});

test("assignUserRoleWithPool updates when another admin remains", async () => {
  const fixture = createPool([
    { rows: [{ role: "admin" }], rowCount: 1 },
    { rows: [{ id: "admin-1" }, { id: "admin-2" }], rowCount: 2 },
    { rows: [], rowCount: 1 },
  ]);

  const result = await assignUserRoleWithPool(fixture.pool, "admin-1", "member");

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(
    fixture.queries.map((q) => q.sql),
    [
      "BEGIN",
      "SELECT role FROM users WHERE id = $1 FOR UPDATE",
      "SELECT id FROM users WHERE role = 'admin' FOR UPDATE",
      "UPDATE users SET role = $2 WHERE id = $1",
      "COMMIT",
    ],
  );
  assert.deepEqual(fixture.queries[3]!.params, ["admin-1", "member"]);
  assert.equal(fixture.released, true);
});

test("assignUserRoleWithPool returns user-not-found for missing members", async () => {
  const fixture = createPool([{ rows: [], rowCount: 0 }]);

  const result = await assignUserRoleWithPool(fixture.pool, "missing-user", "admin");

  assert.deepEqual(result, { ok: false, reason: "user-not-found" });
  assert.deepEqual(
    fixture.queries.map((q) => q.sql),
    ["BEGIN", "SELECT role FROM users WHERE id = $1 FOR UPDATE", "ROLLBACK"],
  );
  assert.equal(fixture.released, true);
});
