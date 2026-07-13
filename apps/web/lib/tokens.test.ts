import assert from "node:assert/strict";
import test from "node:test";
import {
  getTokenConnectionStatusWithPool,
  issueDeviceTokenWithPool,
  issueTokenWithPool,
  listActiveTokensWithPool,
  recordTokenHostWithPool,
  revokeTokenWithPool,
} from "./tokens";

type Query = { sql: string; params?: unknown[] };

test("issueToken adds a new active token without revoking existing machine tokens", async () => {
  const queries: Query[] = [];
  const pool = {
    async query(sql: string, params?: unknown[]) {
      queries.push({ sql, params });
      return { rows: [{ id: "token-1" }] };
    },
  };

  const token = await issueTokenWithPool("user-1", pool, "MacBook Pro");

  assert.match(token, /^tk_[0-9a-f]{48}$/);
  assert.equal(
    queries.some((q) => q.sql.includes("UPDATE ingest_tokens SET revoked_at")),
    false,
  );
  assert.equal(queries.length, 1);
  assert.match(queries[0]!.sql, /INSERT INTO ingest_tokens/);
  assert.match(queries[0]!.sql, /device_label/);
  assert.equal(queries[0]!.params?.[0], "user-1");
  assert.equal(typeof queries[0]!.params?.[1], "string");
  assert.equal(queries[0]!.params?.[2], "MacBook Pro");
});

test("issueDeviceToken returns token ID without revoking existing tokens", async () => {
  const queries: Query[] = [];
  const pool = {
    async query(sql: string, params?: unknown[]) {
      queries.push({ sql, params });
      return { rows: [{ id: "token-new" }] };
    },
  };

  const issued = await issueDeviceTokenWithPool("user-1", pool);

  assert.match(issued.token, /^tk_[0-9a-f]{48}$/);
  assert.equal(issued.tokenId, "token-new");
  assert.match(queries[0]!.sql, /RETURNING id/);
  assert.equal(queries.some((query) => /revoked_at = now/.test(query.sql)), false);
});

test("connection status lookup requires both owner and token ID", async () => {
  const queries: Query[] = [];
  const usedAt = new Date("2026-07-13T01:00:00Z");
  const pool = {
    async query(sql: string, params?: unknown[]) {
      queries.push({ sql, params });
      return { rows: [{ last_used_at: usedAt, last_host: null }] };
    },
  };

  const status = await getTokenConnectionStatusWithPool("user-1", "token-1", pool);

  assert.deepEqual(status, { connected: true, lastUsedAt: usedAt, lastHost: null });
  assert.match(queries[0]!.sql, /user_id = \$1 AND id = \$2/);
  assert.deepEqual(queries[0]!.params, ["user-1", "token-1"]);
});

test("listActiveTokens maps active token metadata without exposing hashes", async () => {
  const createdAt = new Date("2026-07-09T01:00:00Z");
  const lastUsedAt = new Date("2026-07-09T02:00:00Z");
  const queries: Query[] = [];
  const pool = {
    async query(sql: string, params?: unknown[]) {
      queries.push({ sql, params });
      return {
        rows: [
          {
            id: "token-1",
            device_label: "MacBook Pro",
            last_host: "hjyoon-macbookpro.local",
            created_at: createdAt,
            last_used_at: lastUsedAt,
            expires_at: null,
            revoked_at: null,
          },
        ],
      };
    },
  };

  const tokens = await listActiveTokensWithPool("user-1", pool);

  assert.deepEqual(tokens, [
    {
      id: "token-1",
      label: "MacBook Pro",
      lastHost: "hjyoon-macbookpro.local",
      createdAt,
      lastUsedAt,
      expiresAt: null,
      revokedAt: null,
    },
  ]);
  assert.match(queries[0]!.sql, /WHERE user_id = \$1/);
  assert.match(queries[0]!.sql, /revoked_at IS NULL/);
  assert.doesNotMatch(queries[0]!.sql, /token_hash/);
});

test("revokeToken revokes only the selected token owned by the user", async () => {
  const queries: Query[] = [];
  const pool = {
    async query(sql: string, params?: unknown[]) {
      queries.push({ sql, params });
      return { rowCount: 1, rows: [] };
    },
  };

  const revoked = await revokeTokenWithPool("user-1", "token-1", pool);

  assert.equal(revoked, true);
  assert.match(queries[0]!.sql, /UPDATE ingest_tokens SET revoked_at = now\(\)/);
  assert.match(queries[0]!.sql, /WHERE user_id = \$1 AND id = \$2/);
  assert.equal(queries[0]!.params?.[0], "user-1");
  assert.equal(queries[0]!.params?.[1], "token-1");
});

test("recordTokenHost stores the first non-empty host for the authenticating token", async () => {
  const queries: Query[] = [];
  const pool = {
    async query(sql: string, params?: unknown[]): Promise<void> {
      queries.push({ sql, params });
    },
  };

  await recordTokenHostWithPool("token-1", [null, "", "hjyoon-macbookpro.local"], pool);

  assert.equal(queries.length, 1);
  assert.match(queries[0]!.sql, /UPDATE ingest_tokens SET last_host = \$2/);
  assert.match(queries[0]!.sql, /WHERE id = \$1/);
  assert.equal(queries[0]!.params?.[0], "token-1");
  assert.equal(queries[0]!.params?.[1], "hjyoon-macbookpro.local");
});

test("recordTokenHost skips updates when no host is known", async () => {
  const queries: Query[] = [];
  const pool = {
    async query(sql: string, params?: unknown[]): Promise<void> {
      queries.push({ sql, params });
    },
  };

  await recordTokenHostWithPool("token-1", [null, undefined, ""], pool);

  assert.equal(queries.length, 0);
});
