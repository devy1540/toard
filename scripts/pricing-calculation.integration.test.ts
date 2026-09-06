import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fromLiteLLM } from "../packages/pricing/src/sync";
import { PostgresStorage } from "../packages/storage-postgres/src/storage";
import { loadPricingSchedule } from "../apps/web/lib/pricing";
import { syncPricingRevisions } from "../apps/web/lib/pricing-sync";
import { finalizeUsageEvents } from "../apps/web/lib/usage-finalization";
import { startTestPostgres } from "./test-support/postgres";

test("pricing evidence survives migration, ingestion and immutable same-day rate updates", { timeout: 120_000 }, async () => {
  const migration = "1700000054_cost_calculation_evidence.sql";
  const db = await startTestPostgres("pricing", { beforeMigration: migration });
  try {
    const userId = (await db.pool.query("INSERT INTO users(email) VALUES ('price-test@example.com') RETURNING id")).rows[0].id;
    await db.pool.query("INSERT INTO providers(key, display_name, service_name_patterns, collection_method, enabled) VALUES ('gemini','Gemini',ARRAY[]::text[],'logfile',true), ('codex','Codex',ARRAY[]::text[],'logfile',true) ON CONFLICT DO NOTHING");
    await db.pool.query(
      `INSERT INTO usage_events(dedup_key, provider_key, user_id, model, ts, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, cost_status)
       VALUES('legacy-cost', 'gemini', $1, 'gemini-2.5-pro', now(), 300000, 10000, 0, 0, 0.60, 'priced')`, [userId],
    );
    await db.pool.query((await readFile(`migrations/${migration}`, "utf8")).split("-- Down Migration", 1)[0]!);
    const legacy = (await db.pool.query("SELECT cost_usd, cost_calculation_version FROM usage_events WHERE dedup_key='legacy-cost'")).rows[0];
    assert.equal(Number(legacy.cost_usd), 0.60, "migration must not pretend that an old calculation used new rules");
    assert.equal(legacy.cost_calculation_version, "cost-v1");

    const catalog = fromLiteLLM({
      "gemini-2.5-pro": { input_cost_per_token: 1.25e-6, output_cost_per_token: 10e-6, input_cost_per_token_above_200k_tokens: 2.5e-6, output_cost_per_token_above_200k_tokens: 15e-6 },
      "gpt-5.4": { input_cost_per_token: 2.5e-6, output_cost_per_token: 15e-6, input_cost_per_token_above_272k_tokens: 5e-6, output_cost_per_token_above_272k_tokens: 22.5e-6 },
    });
    const effectiveAt = new Date("2026-09-01T00:00:00Z");
    assert.equal(await syncPricingRevisions(db.pool, catalog, effectiveAt), 2);
    const schedule = await loadPricingSchedule((sql) => db.pool.query(sql));
    assert.equal(schedule.get("gpt-5.4")![0]!.pricing.contextTiers?.[0]?.aboveTokens, 272_000);
    const occurredAt = new Date("2026-09-05T00:00:00Z");
    const events = finalizeUsageEvents([
      { dedupKey: "new-gemini", providerKey: "gemini", userId: null, sessionId: "session-g", model: "gemini-2.5-pro", ts: occurredAt, inputTokens: 300_000, outputTokens: 10_000, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 },
      { dedupKey: "new-codex", providerKey: "codex", userId: null, sessionId: "session-c", model: "gpt-5.4", ts: occurredAt, inputTokens: 300_000, outputTokens: 10_000, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 },
    ], userId, schedule, { mode: "calculate" }, occurredAt).events;
    const storage = new PostgresStorage(db.pool);
    assert.deepEqual(await storage.saveUsageEvents(events), { inserted: 2, deduped: 0 });
    assert.deepEqual(await storage.saveUsageEvents(events), { inserted: 0, deduped: 2 });
    const saved = (await db.pool.query("SELECT dedup_key, cost_usd, cost_status, cost_calculation_version FROM usage_events WHERE dedup_key LIKE 'new-%' ORDER BY dedup_key")).rows;
    assert.equal(Number(saved[0].cost_usd), 1.725);
    assert.equal(saved[0].cost_status, "estimated");
    assert.equal(Number(saved[1].cost_usd), 0.90);
    assert.equal(saved.every((row) => row.cost_calculation_version === "cost-v2"), true);
    const overview = await storage.getOverview({ from: effectiveAt, to: new Date("2026-09-06T00:00:00Z"), userId });
    assert.equal(overview.costCoverage.estimatedEvents, 1);

    const otherId = (await db.pool.query("INSERT INTO users(email) VALUES ('other-price-test@example.com') RETURNING id")).rows[0].id;
    await storage.saveUsageEvents([{ ...events[0]!, dedupKey: "foreign-event", userId: otherId }]);
    const range = { from: occurredAt, to: new Date(occurredAt.getTime() + 1000), limit: 1 };
    const first = await storage.getCostEvidence(userId, range);
    assert.equal(first.events.length, 1);
    assert.equal(first.events[0]!.dedupKey, "new-gemini");
    assert.equal(first.events[0]!.costCalculationVersion, "cost-v2");
    assert.ok(first.next);
    const second = await storage.getCostEvidence(userId, { ...range, before: first.next });
    assert.equal(second.events[0]!.dedupKey, "new-codex");
    assert.equal(second.next, null);
    const own = await storage.getCostEvidence(userId, { ...range, limit: 100 });
    assert.equal(own.events.some((event) => event.dedupKey === "foreign-event"), false);

    const originalId = events[0]!.pricingRevisionId;
    catalog.get("gemini-2.5-pro")!.contextTiers![0]!.inputPerM = 3;
    assert.equal(await syncPricingRevisions(db.pool, catalog, effectiveAt), 1, "same-day changes create a new immutable revision");
    assert.equal((await db.pool.query("SELECT pricing_revision_id FROM usage_events WHERE dedup_key='new-gemini'")).rows[0].pricing_revision_id, originalId);
    assert.equal((await db.pool.query("SELECT 1 FROM pricing_revisions WHERE model_id='gemini-2.5-pro'")).rowCount, 2);
  } finally {
    await db.close();
  }
});
