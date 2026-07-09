import assert from "node:assert/strict";
import test from "node:test";
import { issueTokenWithPool } from "./tokens";

test("issueToken adds a new active token without revoking existing machine tokens", async () => {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const pool = {
    async query(sql: string, params?: unknown[]): Promise<void> {
      queries.push({ sql, params });
    },
  };

  const token = await issueTokenWithPool("user-1", pool);

  assert.match(token, /^tk_[0-9a-f]{48}$/);
  assert.equal(
    queries.some((q) => q.sql.includes("UPDATE ingest_tokens SET revoked_at")),
    false,
  );
  assert.equal(queries.length, 1);
  assert.match(queries[0]!.sql, /INSERT INTO ingest_tokens/);
  assert.equal(queries[0]!.params?.[0], "user-1");
  assert.equal(typeof queries[0]!.params?.[1], "string");
});
