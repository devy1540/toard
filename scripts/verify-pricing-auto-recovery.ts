import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { createClient } from "../packages/storage-clickhouse/node_modules/@clickhouse/client/dist/index.js";
import type {
  FinalizedUsageEvent,
  PricingRepairResolver,
  StorageBackend,
} from "../packages/core/src/storage";
import { resolveCostAt, type PricingSchedule } from "../packages/pricing/src/index";
import { ClickHouseStorage } from "../packages/storage-clickhouse/src/storage";
import { PostgresStorage } from "../packages/storage-postgres/src/storage";
import {
  PgPricingRepairRepository,
  runPricingRepairTaskWith,
} from "../apps/web/lib/pricing-repair";
import { Client, Pool } from "pg";

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const POSTGRES_IMAGE = "postgres:16-alpine";
const CLICKHOUSE_IMAGE = "clickhouse/clickhouse-server:24-alpine";
const FIFTEEN_MINUTES_MS = 15 * 60 * 1_000;

type Fixture = {
  events: FinalizedUsageEvent[];
  knownModel: string;
  unsupportedModel: string;
  oldRevisionId: string;
  newRevisionId: string;
  schedule: PricingSchedule;
  from: Date;
  to: Date;
  generation: Date;
};

type Summary = {
  events: number;
  priced: number;
  unpriced: number;
  legacy: number;
  totalTokens: number;
  costUsd: number;
};

type ReplaySummary = {
  events: number;
  totalTokens: number;
};

function floor15m(value: Date): Date {
  return new Date(Math.floor(value.getTime() / FIFTEEN_MINUTES_MS) * FIFTEEN_MINUTES_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dockerPort(output: string, service: string): number {
  const port = Number(output.trim().match(/:(\d+)$/)?.[1]);
  assert.ok(Number.isInteger(port) && port > 0, `failed to resolve ${service} port: ${output}`);
  return port;
}

async function waitForPostgres(connectionString: string): Promise<void> {
  const deadline = Date.now() + 45_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const client = new Client({ connectionString, connectionTimeoutMillis: 1_000 });
    try {
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      return;
    } catch (error) {
      lastError = error;
      await client.end().catch(() => undefined);
      await sleep(250);
    }
  }
  throw lastError;
}

async function waitForClickHouse(url: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  let lastError: unknown;
  let consecutiveReady = 0;
  while (Date.now() < deadline) {
    try {
      const query = encodeURIComponent(
        `SELECT count() FROM system.tables
         WHERE database = 'toard'
           AND name IN ('usage_events', 'usage_15m_rollup_v2')`,
      );
      const response = await fetch(`${url}/?query=${query}`, {
        headers: {
          authorization: `Basic ${Buffer.from("toard:toard").toString("base64")}`,
        },
      });
      if (!response.ok) throw new Error(`ClickHouse health returned ${response.status}`);
      const tables = Number((await response.text()).trim());
      consecutiveReady = tables === 2 ? consecutiveReady + 1 : 0;
      if (consecutiveReady >= 4) return;
      await sleep(500);
    } catch (error) {
      lastError = error;
      consecutiveReady = 0;
      await sleep(300);
    }
  }
  throw lastError;
}

async function applyMigrations(client: Client): Promise<void> {
  const filenames = (await readdir(path.join(ROOT, "migrations")))
    .filter((filename) => filename.endsWith(".sql"))
    .sort();
  for (const filename of filenames) {
    const sql = await readFile(path.join(ROOT, "migrations", filename), "utf8");
    await client.query("BEGIN");
    try {
      await client.query(sql.split("-- Down Migration", 1)[0]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw new Error(`migration failed: ${filename}`, { cause: error });
    }
  }
}

async function seedMetadata(pool: Pool, prefix: string): Promise<{ providerKey: string; userId: string }> {
  const providerKey = `${prefix}_provider`;
  await pool.query(
    `INSERT INTO providers (key, display_name, service_name_patterns, collection_method, enabled)
     VALUES ($1, $1, ARRAY[$1], 'logfile', true)`,
    [providerKey],
  );
  const team = await pool.query<{ id: string }>(
    "INSERT INTO teams (name) VALUES ($1) RETURNING id::text",
    [`${prefix}_team`],
  );
  const user = await pool.query<{ id: string }>(
    `INSERT INTO users (email, name, team_id, role)
     VALUES ($1, $2, $3, 'member')
     RETURNING id::text`,
    [`${prefix}@example.test`, prefix, team.rows[0]!.id],
  );
  return { providerKey, userId: user.rows[0]!.id };
}

async function seedReplayUser(pool: Pool, prefix: string): Promise<string> {
  await pool.query(
    `INSERT INTO providers (key, display_name, service_name_patterns, collection_method, enabled)
     VALUES ('codex', 'codex', ARRAY['codex'], 'logfile', true)
     ON CONFLICT (key) DO NOTHING`,
  );
  const team = await pool.query<{ id: string }>(
    "INSERT INTO teams (name) VALUES ($1) RETURNING id::text",
    [`${prefix}_team`],
  );
  const user = await pool.query<{ id: string }>(
    `INSERT INTO users (email, name, team_id, role)
     VALUES ($1, $2, $3, 'member')
     RETURNING id::text`,
    [`${prefix}@example.test`, prefix, team.rows[0]!.id],
  );
  return user.rows[0]!.id;
}

function replayFixture(prefix: string, userId: string, targetTo: Date): FinalizedUsageEvent[] {
  const ts = new Date(targetTo.getTime() - 29 * 60 * 1_000);
  const event = (
    suffix: string,
    model: string | null,
    inputTokens: number,
    outputTokens: number,
    costStatus: FinalizedUsageEvent["costStatus"],
  ): FinalizedUsageEvent => ({
    dedupKey: `${prefix}_${suffix}`,
    providerKey: "codex",
    userId,
    sessionId: `${prefix}_session`,
    model,
    ts,
    inputTokens,
    outputTokens,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    logAdapter: "codex",
    host: "verify-host",
    pricingRevisionId: null,
    costStatus,
  });
  return [
    event("good", "gpt-5.6-sol", 100, 20, "legacy"),
    event("replayed_1", null, 100, 20, "unpriced"),
    event("replayed_2", null, 100, 20, "unpriced"),
    event("unmatched", null, 7, 3, "unpriced"),
  ];
}

async function postgresReplaySummary(pool: Pool, prefix: string): Promise<ReplaySummary> {
  const result = await pool.query<{ events: string; total_tokens: string }>(
    `SELECT count(*) AS events,
            sum(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens) AS total_tokens
     FROM usage_events
     WHERE dedup_key LIKE $1`,
    [`${prefix}_%`],
  );
  return {
    events: Number(result.rows[0]?.events ?? 0),
    totalTokens: Number(result.rows[0]?.total_tokens ?? 0),
  };
}

async function verifyPostgresReplayReconciliation(
  pool: Pool,
  targetTo: Date,
): Promise<Record<string, unknown>> {
  const prefix = `verify_pg_replay_${randomUUID().slice(0, 8)}`;
  const userId = await seedReplayUser(pool, prefix);
  const events = replayFixture(prefix, userId, targetTo);
  const storage = new PostgresStorage(pool, { timezone: "UTC" });
  assert.deepEqual(await storage.saveUsageEvents(events), { inserted: 4, deduped: 0 });
  const before = await postgresReplaySummary(pool, prefix);
  assert.deepEqual(before, { events: 4, totalTokens: 370 });

  const result = await storage.reconcileCodexReplayUsage({
    from: new Date(targetTo.getTime() - 90 * 24 * 60 * 60 * 1_000),
    to: targetTo,
    limit: 100,
  });
  assert.equal(result.reconciled, 2);
  const after = await postgresReplaySummary(pool, prefix);
  assert.deepEqual(after, { events: 2, totalTokens: 130 });
  const remaining = await pool.query<{ dedup_key: string }>(
    "SELECT dedup_key FROM usage_events WHERE dedup_key LIKE $1 ORDER BY dedup_key",
    [`${prefix}_%`],
  );
  assert.deepEqual(
    remaining.rows.map(({ dedup_key }) => dedup_key),
    [`${prefix}_good`, `${prefix}_unmatched`],
  );
  const day = events[0]!.ts.toISOString().slice(0, 10);
  const mart = await pool.query<{ requests: string }>(
    `SELECT COALESCE(sum(request_count), 0)::text AS requests
     FROM usage_daily_user
     WHERE user_id = $1 AND day = $2::date AND provider_key = 'codex'`,
    [userId, day],
  );
  assert.equal(Number(mart.rows[0]?.requests), 2);
  return { before, after, reconciled: result.reconciled };
}

async function createFixture(
  pool: Pool,
  prefix: string,
  providerKey: string,
  userId: string,
  targetTo: Date,
): Promise<Fixture> {
  const knownModel = `${prefix}_known`;
  const unsupportedModel = `${prefix}_unsupported`;
  const oldEffectiveAt = new Date(targetTo.getTime() - 89 * 24 * 60 * 60 * 1_000);
  const newEffectiveAt = new Date(targetTo.getTime() - 24 * 60 * 60 * 1_000);
  const revisions = await pool.query<{ id: string; effective_at: Date }>(
    `INSERT INTO pricing_revisions (
       model_id, effective_at, input_price_per_mtok, output_price_per_mtok, source
     ) VALUES
       ($1, $2, 1, 2, 'verify-old'),
       ($1, $3, 3, 4, 'verify-new')
     RETURNING id::text, effective_at`,
    [knownModel, oldEffectiveAt, newEffectiveAt],
  );
  const orderedRevisions = revisions.rows.sort(
    (left, right) => left.effective_at.getTime() - right.effective_at.getTime(),
  );
  const oldRevisionId = orderedRevisions[0]!.id;
  const newRevisionId = orderedRevisions[1]!.id;
  const schedule: PricingSchedule = new Map([[knownModel, [
    {
      id: oldRevisionId,
      modelId: knownModel,
      effectiveAt: oldEffectiveAt,
      pricing: { inputPerM: 1, outputPerM: 2 },
    },
    {
      id: newRevisionId,
      modelId: knownModel,
      effectiveAt: newEffectiveAt,
      pricing: { inputPerM: 3, outputPerM: 4 },
    },
  ]] as const]);
  const event = (
    suffix: string,
    model: string,
    ts: Date,
    costStatus: FinalizedUsageEvent["costStatus"],
    costUsd: number,
    pricingRevisionId: string | null,
  ): FinalizedUsageEvent => ({
    dedupKey: `${prefix}_${suffix}`,
    providerKey,
    userId,
    sessionId: `${prefix}_session_${suffix}`,
    model,
    ts,
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd,
    logAdapter: "verify",
    host: "verify-host",
    pricingRevisionId,
    costStatus,
  });
  const events = [
    event("known_old", knownModel, new Date(targetTo.getTime() - 48 * 60 * 60 * 1_000), "unpriced", 0, null),
    event("known_new", knownModel, new Date(targetTo.getTime() - 2 * 60 * 60 * 1_000), "unpriced", 0, null),
    event("unsupported", unsupportedModel, new Date(targetTo.getTime() - 90 * 60 * 1_000), "unpriced", 0, null),
    event("priced", knownModel, new Date(targetTo.getTime() - 60 * 60 * 1_000), "priced", 0.75, newRevisionId),
    event("legacy", knownModel, new Date(targetTo.getTime() - 45 * 60 * 1_000), "legacy", 0.25, null),
  ];
  return {
    events,
    knownModel,
    unsupportedModel,
    oldRevisionId,
    newRevisionId,
    schedule,
    from: new Date(targetTo.getTime() - 90 * 24 * 60 * 60 * 1_000),
    to: targetTo,
    generation: new Date(targetTo.getTime() + 1_000),
  };
}

function resolver(schedule: PricingSchedule): PricingRepairResolver {
  return (event) => {
    const resolved = resolveCostAt({
      ...event,
      occurredAt: event.ts,
      schedule,
      mode: "calculate",
    });
    return resolved.status === "priced" && resolved.pricingRevisionId
      ? { costUsd: resolved.costUsd, pricingRevisionId: resolved.pricingRevisionId }
      : null;
  };
}

async function storageSummary(storage: StorageBackend, fixture: Fixture): Promise<Summary> {
  const overview = await storage.getOverview({ from: fixture.from, to: fixture.to });
  const coverage = overview.costCoverage;
  return {
    events: coverage.pricedEvents + coverage.unpricedEvents + coverage.legacyEvents,
    priced: coverage.pricedEvents,
    unpriced: coverage.unpricedEvents,
    legacy: coverage.legacyEvents,
    totalTokens:
      overview.totalInputTokens
      + overview.totalOutputTokens
      + overview.totalCacheReadTokens
      + overview.totalCacheCreationTokens,
    costUsd: overview.totalCostUsd,
  };
}

function assertBefore(summary: Summary, label: string): void {
  assert.deepEqual(
    {
      events: summary.events,
      priced: summary.priced,
      unpriced: summary.unpriced,
      legacy: summary.legacy,
      totalTokens: summary.totalTokens,
    },
    { events: 5, priced: 1, unpriced: 3, legacy: 1, totalTokens: 750 },
    `${label} before summary`,
  );
}

function assertAfter(before: Summary, after: Summary, label: string): void {
  assert.deepEqual(
    {
      events: after.events,
      priced: after.priced,
      unpriced: after.unpriced,
      legacy: after.legacy,
      totalTokens: after.totalTokens,
    },
    { events: 5, priced: 3, unpriced: 1, legacy: 1, totalTokens: 750 },
    `${label} after summary`,
  );
  assert.equal(after.events, before.events, `${label} event count`);
  assert.equal(after.totalTokens, before.totalTokens, `${label} token total`);
  assert.ok(Math.abs(after.costUsd - 1.0007) < 1e-8, `${label} cost total: ${after.costUsd}`);
}

async function resetRepairStatus(pool: Pool, fixture: Fixture): Promise<void> {
  await pool.query(
    `UPDATE pricing_repair_status
     SET generation = $1,
         state = 'pending',
         target_to = $2,
         processed_events = 0,
         recovered_events = 0,
         remaining_unpriced_events = 3,
         unresolved_models = '[]'::jsonb,
         last_started_at = NULL,
         last_succeeded_at = NULL,
         last_error = NULL,
         adaptive_limit = 100,
         load_state = 'normal',
         eligible_since = $1,
         next_attempt_at = $1,
         consecutive_failures = 0,
         updated_at = $1
     WHERE singleton`,
    [fixture.generation, fixture.to],
  );
}

async function verifyPostgres(pool: Pool, targetTo: Date): Promise<Record<string, unknown>> {
  const prefix = `verify_pg_${randomUUID().slice(0, 8)}`;
  const metadata = await seedMetadata(pool, prefix);
  const fixture = await createFixture(pool, prefix, metadata.providerKey, metadata.userId, targetTo);
  const storage = new PostgresStorage(pool, { timezone: "UTC" });
  assert.deepEqual(await storage.saveUsageEvents(fixture.events), { inserted: 5, deduped: 0 });
  const before = await storageSummary(storage, fixture);
  assertBefore(before, "PostgreSQL");

  await resetRepairStatus(pool, fixture);
  const clock = new Date(fixture.generation.getTime() + 1_000);
  const outcome = await runPricingRepairTaskWith({
    repository: new PgPricingRepairRepository(pool),
    storage,
    getSchedule: async () => fixture.schedule,
    now: () => clock,
  });
  assert.equal(outcome, "success");

  const after = await storageSummary(storage, fixture);
  assertAfter(before, after, "PostgreSQL");
  const rows = await pool.query<{
    dedup_key: string;
    cost_status: string;
    cost_usd: string;
    pricing_revision_id: string | null;
  }>(
    `SELECT dedup_key, cost_status, cost_usd::text, pricing_revision_id::text
     FROM usage_events
     WHERE dedup_key LIKE $1
     ORDER BY dedup_key`,
    [`${prefix}_%`],
  );
  const byKey = new Map(rows.rows.map((row) => [row.dedup_key, row]));
  assert.equal(byKey.get(`${prefix}_known_old`)?.pricing_revision_id, fixture.oldRevisionId);
  assert.equal(byKey.get(`${prefix}_known_new`)?.pricing_revision_id, fixture.newRevisionId);
  assert.equal(byKey.get(`${prefix}_unsupported`)?.cost_status, "unpriced");
  assert.equal(byKey.get(`${prefix}_priced`)?.cost_usd, "0.75000000");
  assert.equal(byKey.get(`${prefix}_legacy`)?.cost_status, "legacy");
  const status = await new PgPricingRepairRepository(pool).get();
  assert.equal(status.state, "waiting_for_catalog");
  assert.equal(status.remainingUnpricedEvents, 1);
  assert.equal(status.unresolvedModels[0]?.model, fixture.unsupportedModel);
  return { before, after, state: status.state };
}

async function clickHouseSummary(
  client: ReturnType<typeof createClient>,
  prefix: string,
): Promise<Summary> {
  const response = await client.query({
    query: `SELECT count() AS events,
                   countIf(cost_status = 'priced') AS priced,
                   countIf(cost_status = 'unpriced') AS unpriced,
                   countIf(cost_status = 'legacy') AS legacy,
                   sum(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens) AS total_tokens,
                   sumIf(cost_usd, cost_status != 'unpriced') AS cost_usd
            FROM usage_events FINAL
            WHERE startsWith(dedup_key, {prefix:String})`,
    query_params: { prefix: `${prefix}_` },
    format: "JSONEachRow",
  });
  const row = (await response.json<{
    events: string;
    priced: string;
    unpriced: string;
    legacy: string;
    total_tokens: string;
    cost_usd: string;
  }>())[0]!;
  return {
    events: Number(row.events),
    priced: Number(row.priced),
    unpriced: Number(row.unpriced),
    legacy: Number(row.legacy),
    totalTokens: Number(row.total_tokens),
    costUsd: Number(row.cost_usd),
  };
}

async function clickHouseReplaySummary(
  client: ReturnType<typeof createClient>,
  source: "usage_events" | "usage_15m_rollup_v2" | "usage_hourly_timezone_rollup" | "usage_daily_timezone_rollup",
  prefix: string,
  bucket?: Date,
): Promise<ReplaySummary> {
  const bucketFilter = source === "usage_events"
    ? ""
    : source === "usage_15m_rollup_v2"
      ? "AND bucket_15m = {bucket:DateTime64(3)}"
      : "AND timezone = 'UTC' AND bucket_start = {bucket:DateTime64(3)}";
  const eventAggregate = source === "usage_events" ? "count()" : "sum(event_count)";
  const response = await client.query({
    query: `SELECT ${eventAggregate} AS events,
                   sum(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens) AS total_tokens
            FROM ${source} FINAL
            WHERE session_id = {session:String}
              ${bucketFilter}`,
    query_params: {
      session: `${prefix}_session`,
      ...(bucket ? { bucket: bucket.toISOString().replace("T", " ").replace("Z", "") } : {}),
    },
    format: "JSONEachRow",
  });
  const row = (await response.json<{ events: string | null; total_tokens: string | null }>())[0];
  return {
    events: Number(row?.events ?? 0),
    totalTokens: Number(row?.total_tokens ?? 0),
  };
}

async function verifyClickHouseReplayReconciliation(
  pool: Pool,
  client: ReturnType<typeof createClient>,
  targetTo: Date,
): Promise<Record<string, unknown>> {
  const prefix = `verify_ch_replay_${randomUUID().slice(0, 8)}`;
  const userId = await seedReplayUser(pool, prefix);
  const events = replayFixture(prefix, userId, targetTo);
  const eventBucket = floor15m(events[0]!.ts);
  const hourBucket = new Date(eventBucket);
  hourBucket.setUTCMinutes(0, 0, 0);
  const dayBucket = new Date(eventBucket);
  dayBucket.setUTCHours(0, 0, 0, 0);
  const storage = new ClickHouseStorage(client, pool, { timezone: "UTC", readFinal: true });
  assert.deepEqual(await storage.saveUsageEvents(events), { inserted: 4, deduped: 0 });
  await storage.flushUsageOutbox(100);
  assert.deepEqual(await clickHouseReplaySummary(client, "usage_events", prefix), {
    events: 4,
    totalTokens: 370,
  });

  await pool.query("INSERT INTO clickhouse_rollup_timezones (timezone) VALUES ('UTC') ON CONFLICT DO NOTHING");
  await storage.compactUsage15mV2(256);
  await storage.compactTimezoneRollup("hour", "UTC", hourBucket);
  await storage.compactTimezoneRollup("day", "UTC", dayBucket);
  assert.deepEqual(await clickHouseReplaySummary(client, "usage_15m_rollup_v2", prefix, eventBucket), {
    events: 4,
    totalTokens: 370,
  });

  const result = await storage.reconcileCodexReplayUsage({
    from: new Date(targetTo.getTime() - 90 * 24 * 60 * 60 * 1_000),
    to: targetTo,
    limit: 100,
  });
  assert.equal(result.reconciled, 2);
  assert.deepEqual(await clickHouseReplaySummary(client, "usage_events", prefix), {
    events: 2,
    totalTokens: 130,
  });

  await storage.compactUsage15mV2(256);
  await storage.compactTimezoneRollup("hour", "UTC", hourBucket);
  await storage.compactTimezoneRollup("day", "UTC", dayBucket);
  for (const [source, bucket] of [
    ["usage_15m_rollup_v2", eventBucket],
    ["usage_hourly_timezone_rollup", hourBucket],
    ["usage_daily_timezone_rollup", dayBucket],
  ] as const) {
    assert.deepEqual(await clickHouseReplaySummary(client, source, prefix, bucket), {
      events: 2,
      totalTokens: 130,
    }, `${source} reconciliation`);
  }
  return { before: { events: 4, totalTokens: 370 }, after: { events: 2, totalTokens: 130 }, reconciled: 2 };
}

async function verifyClickHouse(
  pool: Pool,
  client: ReturnType<typeof createClient>,
  targetTo: Date,
): Promise<Record<string, unknown>> {
  const prefix = `verify_ch_${randomUUID().slice(0, 8)}`;
  const metadata = await seedMetadata(pool, prefix);
  const fixture = await createFixture(pool, prefix, metadata.providerKey, metadata.userId, targetTo);
  const storage = new ClickHouseStorage(client, pool, { timezone: "UTC", readFinal: true });
  assert.deepEqual(await storage.saveUsageEvents(fixture.events), { inserted: 5, deduped: 0 });
  await storage.flushUsageOutbox(100);
  const before = await clickHouseSummary(client, prefix);
  assertBefore(before, "ClickHouse");

  const newEvent = fixture.events.find((event) => event.dedupKey.endsWith("known_new"))!;
  await pool.query("INSERT INTO clickhouse_rollup_timezones (timezone) VALUES ('UTC') ON CONFLICT DO NOTHING");
  await pool.query(
    `WITH buckets AS (
       SELECT 'hour'::text AS resolution, date_trunc('hour', $1::timestamptz) AS bucket
       UNION ALL
       SELECT 'day', date_trunc('day', $1::timestamptz)
     )
     INSERT INTO clickhouse_timezone_rollup_jobs (resolution, timezone, bucket, source_to, status)
     SELECT resolution, 'UTC', bucket,
            bucket + CASE WHEN resolution = 'hour' THEN interval '1 hour' ELSE interval '1 day' END,
            'done'
     FROM buckets
     ON CONFLICT (resolution, timezone, bucket) DO UPDATE SET status = 'done'`,
    [newEvent.ts],
  );
  await pool.query(
    `WITH buckets AS (
       SELECT 'hour'::text AS resolution, date_trunc('hour', $1::timestamptz) AS bucket
       UNION ALL
       SELECT 'day', date_trunc('day', $1::timestamptz)
     )
     INSERT INTO clickhouse_timezone_rollup_coverage (resolution, timezone, bucket)
     SELECT resolution, 'UTC', bucket FROM buckets
     ON CONFLICT DO NOTHING`,
    [newEvent.ts],
  );

  const request = {
    from: fixture.from,
    to: fixture.to,
    models: [fixture.knownModel],
    limit: 100,
    generation: fixture.generation.toISOString(),
  };
  await client.command({ query: "SYSTEM STOP MERGES usage_events" });
  try {
    await Promise.all([
      storage.repairUnpricedUsage(request, resolver(fixture.schedule)),
      storage.repairUnpricedUsage(request, resolver(fixture.schedule)),
    ]);
    const physical = await client.query({
      query: `SELECT count() AS rows
              FROM usage_events
              WHERE dedup_key IN {keys:Array(String)}`,
      query_params: {
        keys: [`${prefix}_known_old`, `${prefix}_known_new`],
      },
      format: "JSONEachRow",
    });
    assert.equal(Number((await physical.json<{ rows: string }>())[0]?.rows), 4, "replacement retry physical rows");
  } finally {
    await client.command({ query: "SYSTEM START MERGES usage_events" });
  }

  const after = await clickHouseSummary(client, prefix);
  assertAfter(before, after, "ClickHouse");
  const remaining = await storage.getUnpricedUsageModels(fixture.from, fixture.to);
  assert.deepEqual(
    remaining.map(({ model, events }) => ({ model, events })),
    [{ model: fixture.unsupportedModel, events: 1 }],
  );

  const compacted = await storage.compactUsage15mV2(256);
  assert.ok(compacted.buckets > 0, "15m v2 compactor must process dirty buckets");
  const validation = await storage.validateUsage15mV2(fixture.to, 90 * 24 * 60 * 60 * 1_000);
  assert.deepEqual(validation, { ok: true, detail: null });

  const invalidation = await pool.query<{
    pending: number;
    coverage: number;
    min_generation: string;
  }>(
    `WITH expected AS (
       SELECT 'hour'::text AS resolution, date_trunc('hour', $1::timestamptz) AS bucket
       UNION ALL
       SELECT 'day', date_trunc('day', $1::timestamptz)
     )
     SELECT
       count(*) FILTER (WHERE jobs.status = 'pending')::int AS pending,
       count(coverage.bucket)::int AS coverage,
       min(jobs.generation)::text AS min_generation
     FROM expected
     JOIN clickhouse_timezone_rollup_jobs AS jobs
       ON jobs.resolution = expected.resolution
      AND jobs.timezone = 'UTC'
      AND jobs.bucket = expected.bucket
     LEFT JOIN clickhouse_timezone_rollup_coverage AS coverage
       ON coverage.resolution = expected.resolution
      AND coverage.timezone = 'UTC'
      AND coverage.bucket = expected.bucket`,
    [newEvent.ts],
  );
  assert.deepEqual(invalidation.rows[0], { pending: 2, coverage: 0, min_generation: "1" });
  return { before, after, validation, compactedBuckets: compacted.buckets };
}

async function main(): Promise<void> {
  const suffix = randomUUID().slice(0, 8);
  const postgresContainer = `toard-pricing-verify-pg-${suffix}`;
  const clickhouseContainer = `toard-pricing-verify-ch-${suffix}`;
  let pool: Pool | null = null;
  let clickhouse: ReturnType<typeof createClient> | null = null;
  try {
    await execFileAsync("docker", [
      "run", "-d", "--rm", "--name", postgresContainer,
      "--tmpfs", "/var/lib/postgresql/data:rw",
      "-e", "POSTGRES_PASSWORD=postgres",
      "-e", "POSTGRES_DB=toard",
      "-p", "127.0.0.1::5432",
      POSTGRES_IMAGE,
    ]);
    await execFileAsync("docker", [
      "run", "-d", "--rm", "--name", clickhouseContainer,
      "--tmpfs", "/var/lib/clickhouse:rw",
      "-e", "CLICKHOUSE_USER=toard",
      "-e", "CLICKHOUSE_PASSWORD=toard",
      "-e", "CLICKHOUSE_DB=toard",
      "-e", "CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1",
      "-p", "127.0.0.1::8123",
      "-v", `${path.join(ROOT, "clickhouse", "init")}:/docker-entrypoint-initdb.d:ro`,
      CLICKHOUSE_IMAGE,
    ]);
    const [{ stdout: pgPortOutput }, { stdout: chPortOutput }] = await Promise.all([
      execFileAsync("docker", ["port", postgresContainer, "5432/tcp"]),
      execFileAsync("docker", ["port", clickhouseContainer, "8123/tcp"]),
    ]);
    const pgPort = dockerPort(pgPortOutput, "PostgreSQL");
    const chPort = dockerPort(chPortOutput, "ClickHouse");
    const connectionString = `postgresql://postgres:postgres@127.0.0.1:${pgPort}/toard`;
    const clickhouseUrl = `http://127.0.0.1:${chPort}`;
    await Promise.all([
      waitForPostgres(connectionString),
      waitForClickHouse(clickhouseUrl),
    ]);

    const migrationClient = new Client({ connectionString });
    await migrationClient.connect();
    try {
      await applyMigrations(migrationClient);
    } finally {
      await migrationClient.end();
    }
    pool = new Pool({ connectionString, max: 8 });
    clickhouse = createClient({
      url: clickhouseUrl,
      username: "toard",
      password: "toard",
      database: "toard",
    });
    const targetTo = floor15m(new Date(Date.now() - 31 * 60 * 1_000));
    const postgres = await verifyPostgres(pool, targetTo);
    const clickHouseResult = await verifyClickHouse(pool, clickhouse, targetTo);
    const postgresReplay = await verifyPostgresReplayReconciliation(pool, targetTo);
    const clickHouseReplay = await verifyClickHouseReplayReconciliation(pool, clickhouse, targetTo);
    process.stdout.write(`${JSON.stringify({
      postgres,
      clickhouse: clickHouseResult,
      replay: { postgres: postgresReplay, clickhouse: clickHouseReplay },
    }, null, 2)}\n`);
    process.stdout.write("PRICING_AUTO_RECOVERY_PASS\n");
  } finally {
    await clickhouse?.close().catch(() => undefined);
    await pool?.end().catch(() => undefined);
    await Promise.all([
      execFileAsync("docker", ["rm", "-f", postgresContainer]).catch(() => undefined),
      execFileAsync("docker", ["rm", "-f", clickhouseContainer]).catch(() => undefined),
    ]);
  }
}

await main();
