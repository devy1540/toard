import assert from "node:assert/strict";
import test from "node:test";
import { Pool } from "pg";
import { PostgresStorage } from "../packages/storage-postgres/src/storage";
import { startTestPostgres } from "./test-support/postgres";
import { reportPeriod } from "../apps/web/lib/report-period";
import { buildWeeklyReport } from "../apps/web/lib/weekly-report";
import { getCostEvidenceRevisionIds } from "../apps/web/lib/cost-evidence";
import { readUtilizationCacheGeneration } from "../apps/web/lib/utilization-cache-generation";
import { getReportHealth } from "../apps/web/lib/report-health";
import { weeklyReportCsv } from "../apps/web/lib/report-csv";
import { createClickHouseStorage } from "../packages/storage-clickhouse/src/storage";
import { startTestClickHouse } from "./test-support/clickhouse";

test("weekly reports consume all records, preserve historical team attribution and work with a one-connection pool", { timeout: 120_000 }, async () => {
  const db = await startTestPostgres("weekly-report");
  const pool = new Pool({ connectionString: db.connectionString, max: 1 });
  try {
    const teams = (await db.pool.query("INSERT INTO teams(name) VALUES('Previous Team'),('Current Team') RETURNING id")).rows;
    const owner = (await db.pool.query("INSERT INTO users(email,team_id) VALUES('report-owner@example.test',$1) RETURNING id", [teams[1].id])).rows[0].id;
    const other = (await db.pool.query("INSERT INTO users(email,team_id) VALUES('report-other@example.test',$1) RETURNING id", [teams[1].id])).rows[0].id;
    await db.pool.query("INSERT INTO providers(key,display_name,service_name_patterns,collection_method) VALUES('report_fixture','Report',ARRAY[]::text[],'logfile')");
    const price = (await db.pool.query("INSERT INTO pricing_revisions(model_id,effective_at,input_price_per_mtok,output_price_per_mtok,fast_multiplier,source) VALUES('report-model','2026-01-01',1,5,1,'integration-fixture') RETURNING id")).rows[0].id;
    const period = reportPeriod("2026-08-30", "UTC", new Date("2026-09-06T12:00:00Z"));
    await db.pool.query(`INSERT INTO usage_events(dedup_key,user_id,team_id,provider_key,model,ts,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,cost_usd,cost_status,pricing_revision_id,cost_calculation_version)
      SELECT 'report-'||g, $1, $2, 'report_fixture','report-model',CASE WHEN g<=1000 THEN $3::timestamptz ELSE $4::timestamptz END,1000000,0,0,0,1,'priced',$5,'cost-v2' FROM generate_series(1,2001) g`,
    [owner, teams[0].id, period.previous.from, period.current.from, price]);
    await db.pool.query(`INSERT INTO usage_events(dedup_key,user_id,team_id,provider_key,model,ts,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,cost_usd,cost_status,cost_calculation_version)
      VALUES('legacy',$1,$2,'report_fixture','legacy-model',$3,10,0,0,0,7,'legacy','cost-v1'),('unpriced',$1,$2,'report_fixture','=2+2',$3,10,0,0,0,0,'unpriced','cost-v2'),('foreign',$4,$5,'report_fixture','other-model',$3,10,0,0,0,100,'legacy','cost-v1')`,
    [owner, teams[0].id, period.current.from, other, teams[1].id]);
    const storage = new PostgresStorage(pool);
    const dependencies = {
      revisionIds: storage.getReportPricingRevisionIds.bind(storage), consume: storage.consumeReportCostEvidence.bind(storage),
      readRevisions: (ids: string[]) => getCostEvidenceRevisionIds(ids, pool), generation: (id: string | null) => readUtilizationCacheGeneration(id, pool),
    };
    const personal = await buildWeeklyReport({ kind: "user", userId: owner }, period, dependencies);
    assert.equal(personal.current.events, 1003); assert.equal(personal.previous.events, 1000);
    assert.equal(personal.current.costUsd, 1008);
    assert.ok(Math.abs(personal.change.driversUsd.volume - 1) < 1e-9);
    assert.ok(Math.abs(personal.change.unexplainedUsd - 7) < 1e-9);
    assert.equal(personal.models.some(row => row.model === "other-model"), false);
    const historicalTeam = await buildWeeklyReport({ kind: "team", teamId: teams[0].id }, period, dependencies);
    assert.equal(historicalTeam.current.costUsd, personal.current.costUsd);
    const organization = await buildWeeklyReport({ kind: "organization" }, period, dependencies);
    assert.equal(organization.current.costUsd, 1108);
    const health = await getReportHealth({ kind: "user", userId: owner }, { from: period.previous.from, to: period.current.to }, pool, false);
    assert.equal(health.pendingEvents, null);
    const csv = weeklyReportCsv(personal, health);
    assert.ok(csv.includes('"\'=2+2"')); assert.ok(csv.includes(price));
    assert.equal(csv.includes("report-other@example.test"), false);
    assert.equal(csv.includes(owner), false);
    await assert.rejects(storage.getReportPricingRevisionIds({ kind: "user", userId: "" }, period.current), /invalid_report_scope/);

    let observed = 0;
    await storage.consumeReportCostEvidence({ kind: "user", userId: owner }, { from: period.previous.from, to: period.current.to }, async rows => {
      assert.ok(rows.every(row => row.sessionId === null && row.host === null));
      if (observed === 0) await db.pool.query(`INSERT INTO usage_events(dedup_key,user_id,team_id,provider_key,model,ts,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,cost_usd,cost_status)
        VALUES('arrived-during-read',$1,$2,'report_fixture','late',$3,10,0,0,0,0,'unpriced')`, [owner, teams[0].id, period.current.from]);
      observed += rows.length;
    });
    assert.equal(observed, 2003, "a late insert must not alter a cursor's snapshot");
    await assert.rejects(storage.consumeReportCostEvidence({ kind: "user", userId: owner }, period.current, () => { throw new Error("consumer-failed"); }), /consumer-failed/);
    assert.equal((await pool.query("SELECT 1 AS value")).rows[0].value, 1, "failed consumption releases the one available connection");
  } finally { await pool.end(); await db.close(); }
});

test("ClickHouse report streams use final event ownership and do not expose superseded team rows", { timeout: 120_000 }, async () => {
  const db = await startTestPostgres("weekly-report-ch");
  const keys = ["CLICKHOUSE_URL", "CLICKHOUSE_USER", "CLICKHOUSE_PASSWORD", "CLICKHOUSE_DB"] as const;
  const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  let ch: Awaited<ReturnType<typeof startTestClickHouse>> | undefined;
  let storage: ReturnType<typeof createClickHouseStorage> | undefined;
  try {
    ch = await startTestClickHouse();
    process.env.CLICKHOUSE_URL = ch.url; process.env.CLICKHOUSE_USER = ch.username; process.env.CLICKHOUSE_PASSWORD = ch.password; process.env.CLICKHOUSE_DB = "toard";
    const teams = (await db.pool.query("INSERT INTO teams(name) VALUES('Historical'),('Current') RETURNING id")).rows;
    const users = (await db.pool.query("INSERT INTO users(email) VALUES('stream-owner@example.test'),('stream-other@example.test') RETURNING id")).rows;
    const price = (await db.pool.query("INSERT INTO pricing_revisions(model_id,effective_at,input_price_per_mtok,output_price_per_mtok,fast_multiplier,source) VALUES('stream-model','2026-01-01',1,5,1,'integration-fixture') RETURNING id")).rows[0].id;
    const period = reportPeriod("2026-08-30", "UTC", new Date("2026-09-06T12:00:00Z"));
    storage = createClickHouseStorage(db.pool, { readFinal: true, readRollup: false, read15mV2Rollup: false });
    await storage.getCostEvidence(users[0].id, period.current);
    const row = (dedup: string, user: string, team: string, cost: number, inserted = "2026-09-06 11:00:00.000") => ({
      dedup_key: dedup, provider_key: "fixture", user_id: user, team_id: team, session_id: "must-not-be-returned", host: "private-device", model: "stream-model",
      ts: "2026-08-31 00:00:00.000", input_tokens: cost * 1_000_000, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0,
      cost_usd: cost, pricing_revision_id: price, cost_status: "priced", cost_calculation_version: "cost-v2", inserted_at: inserted,
    });
    const response = await fetch(`${ch.url}/?database=toard`, { method: "POST", headers: { Authorization: `Basic ${Buffer.from(`${ch.username}:${ch.password}`).toString("base64")}` },
      body: "INSERT INTO usage_events FORMAT JSONEachRow\n" + [row("owner", users[0].id, teams[0].id, 1), row("other", users[1].id, teams[1].id, 5),
        row("moved", users[0].id, teams[0].id, 1), row("moved", users[0].id, teams[1].id, 1, "2026-09-06 12:00:00.000")].map(value => JSON.stringify(value)).join("\n") });
    assert.equal(response.ok, true, await response.text());
    const deps = { revisionIds: storage.getReportPricingRevisionIds.bind(storage), consume: storage.consumeReportCostEvidence.bind(storage),
      readRevisions: (ids: string[]) => getCostEvidenceRevisionIds(ids, db.pool), generation: (id: string | null) => readUtilizationCacheGeneration(id, db.pool) };
    const own = await buildWeeklyReport({ kind: "user", userId: users[0].id }, period, deps);
    assert.equal(own.current.events, 2); assert.equal(own.current.costUsd, 2);
    const historical = await buildWeeklyReport({ kind: "team", teamId: teams[0].id }, period, deps);
    assert.equal(historical.current.events, 1); assert.equal(historical.current.costUsd, 1);
    const organization = await buildWeeklyReport({ kind: "organization" }, period, deps);
    assert.equal(organization.current.events, 3); assert.equal(organization.current.costUsd, 7);
    await storage.consumeReportCostEvidence({ kind: "organization" }, period.current, rows => {
      assert.ok(rows.every(event => event.sessionId === null && event.host === null));
    });
  } finally {
    await storage?.close(); await ch?.close(); await db.close();
    for (const key of keys) { if (original[key] == null) delete process.env[key]; else process.env[key] = original[key]; }
  }
});
