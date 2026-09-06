import assert from "node:assert/strict";
import test from "node:test";
import { createClickHouseStorage } from "../packages/storage-clickhouse/src/storage";
import type { FinalizedUsageEvent } from "../packages/core/src/storage";
import { startTestPostgres } from "./test-support/postgres";
import { startTestClickHouse } from "./test-support/clickhouse";

test("ClickHouse outbox, personal ledger and organization snapshot retain estimated cost evidence", { timeout: 120_000 }, async () => {
  const db = await startTestPostgres("pricing-ch");
  const keys = ["CLICKHOUSE_URL", "CLICKHOUSE_USER", "CLICKHOUSE_PASSWORD", "CLICKHOUSE_DB"] as const;
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  let ch: Awaited<ReturnType<typeof startTestClickHouse>> | undefined;
  let storage: ReturnType<typeof createClickHouseStorage> | undefined;
  try {
    ch = await startTestClickHouse();
    process.env.CLICKHOUSE_URL = ch.url;
    process.env.CLICKHOUSE_USER = ch.username;
    process.env.CLICKHOUSE_PASSWORD = ch.password;
    process.env.CLICKHOUSE_DB = "toard";
    const owner = (await db.pool.query("INSERT INTO users(email) VALUES ('ch-owner@example.com') RETURNING id")).rows[0].id;
    const other = (await db.pool.query("INSERT INTO users(email) VALUES ('ch-other@example.com') RETURNING id")).rows[0].id;
    await db.pool.query("INSERT INTO providers(key, display_name, service_name_patterns, collection_method) VALUES('fixture','Fixture',ARRAY[]::text[],'logfile')");
    const revision = (await db.pool.query("INSERT INTO pricing_revisions(model_id, effective_at, input_price_per_mtok, output_price_per_mtok, source) VALUES('fixture-model', '2026-01-01', 1, 1, 'integration-fixture') RETURNING id")).rows[0].id;
    storage = createClickHouseStorage(db.pool, { readFinal: true, readRollup: false, read15mV2Rollup: false });
    const event: FinalizedUsageEvent = {
      dedupKey: "owner-event", providerKey: "fixture", userId: owner, sessionId: "session-owner", model: "fixture-model",
      ts: new Date("2026-09-05T10:00:00Z"), inputTokens: 100, outputTokens: 20,
      cacheReadTokens: 0, cacheCreationTokens: 3, cacheCreation1hTokens: 2, isFast: true,
      costUsd: 0.25, costStatus: "estimated", pricingRevisionId: revision, costCalculationVersion: "cost-v2",
    };
    assert.deepEqual(await storage.saveUsageEvents([event, { ...event, userId: other, dedupKey: "other-event", sessionId: "other-session", costUsd: 0.50, costStatus: "priced" }]), { inserted: 2, deduped: 0 });
    // saveUsageEvents can acknowledge a durable PG queue before a failed CH flush.
    // Querying the real CH ledger below proves that delivery actually completed.
    const period = { from: new Date("2026-09-05T00:00:00Z"), to: new Date("2026-09-06T00:00:00Z"), timezone: "UTC", bucket: "day" as const };
    const ledger = await storage.getCostEvidence(owner, period);
    assert.equal(ledger.events.length, 1);
    assert.equal(ledger.events[0]!.dedupKey, "owner-event");
    assert.equal(ledger.events[0]!.costCalculationVersion, "cost-v2");
    assert.equal(ledger.events[0]!.costStatus, "estimated");
    assert.equal(ledger.events[0]!.cacheCreation1hTokens, 2);
    assert.equal(ledger.events[0]!.isFast, true);
    const personal = await storage.getOverview({ ...period, userId: owner });
    assert.equal(personal.costCoverage.estimatedEvents, 1);
    assert.equal(personal.totalCostUsd, 0.25);
    const organization = await storage.getOrganizationDashboard({
      current: period,
      previous: { from: new Date("2026-09-04T00:00:00Z"), to: period.from },
      includeTeamLeaderboard: false, leaderboardOrder: "tokens",
    });
    assert.equal(organization.overview.costCoverage.estimatedEvents, 1);
    assert.equal(organization.overview.totalCostUsd, 0.75);
    assert.equal(organization.topUsers.find((row) => row.key === owner)?.costCoverage.estimatedEvents, 1);
  } finally {
    await storage?.close();
    await ch?.close();
    await db.close();
    for (const key of keys) {
      if (before[key] == null) delete process.env[key]; else process.env[key] = before[key];
    }
  }
});
