import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { authenticateIngestTokenWithPool } from "./ingest-auth";

test("authenticateIngestToken returns the authenticated token id and owner", async () => {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const pool = {
    async query(sql: string, params?: unknown[]) {
      queries.push({ sql, params });
      return { rows: [{ id: "token-1", user_id: "user-1" }] };
    },
  };

  const result = await authenticateIngestTokenWithPool("Bearer tk_example", pool);

  assert.deepEqual(result, { tokenId: "token-1", userId: "user-1" });
  assert.match(queries[0]!.sql, /RETURNING id, user_id/);
  assert.equal(
    queries[0]!.params?.[0],
    createHash("sha256").update("tk_example").digest("hex"),
  );
});

test("authenticateIngestToken rejects missing bearer tokens without querying", async () => {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const pool = {
    async query(sql: string, params?: unknown[]) {
      queries.push({ sql, params });
      return { rows: [] };
    },
  };

  const result = await authenticateIngestTokenWithPool(null, pool);

  assert.equal(result, null);
  assert.equal(queries.length, 0);
});
