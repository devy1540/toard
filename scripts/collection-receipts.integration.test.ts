import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import type { FinalizedUsageEvent } from "../packages/core/src/storage";
import { PostgresStorage } from "../packages/storage-postgres/src/storage";
import { ClickHouseStorage } from "../packages/storage-clickhouse/src/storage";
import { authenticateIngestTokenWithPool } from "../apps/web/lib/ingest-auth";
import { getTokenConnectionStatusWithPool } from "../apps/web/lib/tokens";
import { startTestPostgres } from "./test-support/postgres";
import { getCollectionHealth, recordCollectionHealth } from "../apps/web/lib/collection-health";

test("usage receipts reflect committed owned rows, never authentication or a failed write", { timeout: 120_000 }, async (t) => {
  const db = await startTestPostgres("receipts");
  try {
    const owner = (await db.pool.query("INSERT INTO users(email) VALUES ('receipt-owner@example.com') RETURNING id")).rows[0].id;
    const other = (await db.pool.query("INSERT INTO users(email) VALUES ('receipt-other@example.com') RETURNING id")).rows[0].id;
    await db.pool.query("INSERT INTO providers(key, display_name, service_name_patterns, collection_method) VALUES ('fixture','Fixture',ARRAY[]::text[],'logfile')");
    const makeToken = async (userId = owner) => {
      const token = randomUUID();
      const row = (await db.pool.query("INSERT INTO ingest_tokens(user_id, token_hash) VALUES ($1,$2) RETURNING id", [userId, createHash("sha256").update(token).digest("hex")])).rows[0];
      await authenticateIngestTokenWithPool(`Bearer ${token}`, db.pool);
      return { tokenId: row.id, userId };
    };
    const event = (key: string, userId = owner): FinalizedUsageEvent => ({
      dedupKey: key, providerKey: "fixture", userId, sessionId: "fixture-session", model: "fixture-model",
      ts: new Date(), inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0,
      costUsd: 0, pricingRevisionId: null, costStatus: "unpriced", costCalculationVersion: "cost-v2",
    });
    const pg = new PostgresStorage(db.pool);

    await t.test("authentication and an empty upload leave usage unconfirmed", async () => {
      const context = await makeToken();
      await pg.saveUsageEvents([], context);
      const status = await getTokenConnectionStatusWithPool(owner, context.tokenId, db.pool);
      assert.equal(status.connected, true);
      assert.equal(status.usageStored, false);
      assert.equal(status.firstUsageStoredAt, null);
      await recordCollectionHealth(owner, context.tokenId, {
        schemaVersion: 1, host: "fixture", collectors: [{ providerKey: "fixture", state: "ok", scannedFiles: 2, parsedEvents: 100, parseErrors: 0, pendingEvents: 0, errorCode: null }],
      }, db.pool);
      assert.equal((await getTokenConnectionStatusWithPool(owner, context.tokenId, db.pool)).usageStored, false, "a collector's claim of parsing data is not a storage receipt");
      assert.equal((await getCollectionHealth(owner, db.pool))[0]?.parsedEvents, 100);
      assert.equal((await getCollectionHealth(other, db.pool)).length, 0);
    });

    await t.test("committed usage and an owned replay establish a stable first receipt", async () => {
      const context = await makeToken();
      await pg.saveUsageEvents([event("owned")], context);
      const first = await getTokenConnectionStatusWithPool(owner, context.tokenId, db.pool);
      assert.equal(first.usageStored, true);
      assert.equal(first.lastUsageCount, 1);
      assert.ok(first.firstUsageStoredAt);
      assert.deepEqual(await pg.saveUsageEvents([event("owned")], context), { inserted: 0, deduped: 1, confirmed: 1 });
      const replay = await getTokenConnectionStatusWithPool(owner, context.tokenId, db.pool);
      assert.deepEqual(replay.firstUsageStoredAt, first.firstUsageStoredAt);
      const health = (await db.pool.query("SELECT last_usage_count FROM collection_provider_health WHERE token_id=$1 AND provider_key='fixture'", [context.tokenId])).rows[0];
      assert.equal(health.last_usage_count, 1);
    });

    await t.test("another user's dedup collision cannot claim a successful receipt", async () => {
      await pg.saveUsageEvents([event("foreign-collision", other)]);
      const context = await makeToken();
      assert.deepEqual(await pg.saveUsageEvents([event("foreign-collision")], context), { inserted: 0, deduped: 1, confirmed: 0 });
      assert.equal((await getTokenConnectionStatusWithPool(owner, context.tokenId, db.pool)).usageStored, false);
    });

    await t.test("a mismatching receipt owner rolls back the usage transaction", async () => {
      const foreign = await makeToken(other);
      await assert.rejects(pg.saveUsageEvents([event("must-rollback")], { ...foreign, userId: owner }), /receipt token owner mismatch/);
      assert.equal((await db.pool.query("SELECT 1 FROM usage_events WHERE dedup_key='must-rollback'")).rowCount, 0);
    });

    await t.test("a durable ClickHouse outbox is stored even while ClickHouse is unavailable", async () => {
      const context = await makeToken();
      const offline = { command: async () => { throw new Error("fixture offline"); } } as unknown as ConstructorParameters<typeof ClickHouseStorage>[0];
      const ch = new ClickHouseStorage(offline, db.pool);
      const warning = t.mock.method(console, "warn", () => undefined);
      try {
        assert.deepEqual(await ch.saveUsageEvents([event("queued")], context), { inserted: 1, deduped: 0, confirmed: 1 });
        assert.equal((await getTokenConnectionStatusWithPool(owner, context.tokenId, db.pool)).usageStored, true);
        assert.equal((await db.pool.query("SELECT 1 FROM clickhouse_usage_outbox WHERE dedup_key='queued' AND delivered_at IS NULL")).rowCount, 1);
      } finally { warning.mock.restore(); }
    });

    await t.test("receipt failure rolls back both the stored event and provider health", async () => {
      const context = await makeToken();
      await db.pool.query(`CREATE FUNCTION fail_receipt_fixture() RETURNS TRIGGER LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'fixture receipt failure'; END $$;
        CREATE TRIGGER fail_receipt_fixture BEFORE UPDATE OF first_usage_stored_at ON ingest_tokens
        FOR EACH ROW EXECUTE FUNCTION fail_receipt_fixture()`);
      await assert.rejects(pg.saveUsageEvents([event("receipt-failure")], context), /fixture receipt failure/);
      assert.equal((await db.pool.query("SELECT 1 FROM usage_events WHERE dedup_key='receipt-failure'")).rowCount, 0);
      assert.equal((await db.pool.query("SELECT 1 FROM collection_provider_health WHERE token_id=$1", [context.tokenId])).rowCount, 0);
      assert.equal((await getTokenConnectionStatusWithPool(owner, context.tokenId, db.pool)).usageStored, false);
    });
  } finally { await db.close(); }
});
