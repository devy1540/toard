import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { PricingMap } from "../packages/pricing/src/index";
import { resolveCostAt } from "../packages/pricing/src/index";
import {
  PgPricingHistoryRepository,
  runHistoricalPricingStepWith,
  type HistoricalPricingStepResult,
} from "../apps/web/lib/pricing-history";
import {
  PricingSnapshotInvalidError,
  type PricingHistoryCommitRef,
} from "../apps/web/lib/pricing-history-source";
import { loadPricingSchedule } from "../apps/web/lib/pricing";
import { PostgresStorage } from "../packages/storage-postgres/src/storage";
import { Client, Pool } from "pg";

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const NOW = new Date("2026-07-14T00:00:00.000Z");
const MODEL = "fixture-history-model";
const BASELINE: PricingHistoryCommitRef = {
  sha: "a".repeat(40),
  committedAt: "2025-09-14T23:00:00.000Z",
};
const CHANGE: PricingHistoryCommitRef = {
  sha: "b".repeat(40),
  committedAt: "2026-06-15T00:00:00.000Z",
};
const GAP_MODEL = "fixture-history-gap-model";
const GAP_BASELINE: PricingHistoryCommitRef = {
  sha: "c".repeat(40),
  committedAt: "2025-09-14T23:00:00.000Z",
};
const GAP_BROKEN: PricingHistoryCommitRef = {
  sha: "d".repeat(40),
  committedAt: "2025-10-01T00:00:00.000Z",
};
const GAP_AFTER: PricingHistoryCommitRef = {
  sha: "e".repeat(40),
  committedAt: "2025-11-01T00:00:00.000Z",
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function snapshot(inputPerM: number, outputPerM: number): PricingMap {
  return new Map([[MODEL, { inputPerM, outputPerM }]]);
}

async function verifyDurableHistoryPromotion(pool: Pool): Promise<Record<string, unknown>> {
  const source = {
    async listBaseline(): Promise<PricingHistoryCommitRef[]> {
      return [BASELINE];
    },
    async listChanges(): Promise<PricingHistoryCommitRef[]> {
      // GitHub commits API와 같은 newest-first 순서다.
      return [CHANGE];
    },
    async fetchSnapshot(sha: string): Promise<PricingMap> {
      if (sha === BASELINE.sha) return snapshot(5, 25);
      if (sha === CHANGE.sha) return snapshot(6, 30);
      throw new Error("unexpected fixture commit");
    },
  };
  const diagnostics = [{
    model: MODEL,
    events: 4,
    firstAt: "2025-09-15T12:00:00.000Z",
    lastAt: "2026-06-20T12:00:00.000Z",
  }];
  let result: HistoricalPricingStepResult | undefined;
  for (let step = 0; step < 8; step += 1) {
    // 매 tick마다 repository를 새로 만들어 process 재시작 뒤 durable cursor 재개를 검증한다.
    result = await runHistoricalPricingStepWith({
      repository: new PgPricingHistoryRepository(pool),
      source,
      now: () => NOW,
      timezone: "UTC",
      invalidateCache: () => undefined,
    }, diagnostics);
    if (result.state === "promoted") break;
  }
  assert.deepEqual(result, { state: "promoted", insertedRevisions: 2 });

  const revisions = await pool.query<{
    effective_at: Date;
    valid_until: Date;
    input_price_per_mtok: string;
    output_price_per_mtok: string;
    source_ref: string;
    source_model_id: string;
    authoritative: boolean;
  }>(
    `SELECT effective_at, valid_until, input_price_per_mtok, output_price_per_mtok,
            source_ref, source_model_id, authoritative
     FROM pricing_revisions
     WHERE model_id = $1 AND source = 'litellm-git-history'
     ORDER BY effective_at`,
    [MODEL],
  );
  assert.deepEqual(revisions.rows.map((row) => ({
    effectiveAt: row.effective_at.toISOString(),
    validUntil: row.valid_until.toISOString(),
    input: Number(row.input_price_per_mtok),
    output: Number(row.output_price_per_mtok),
    sourceRef: row.source_ref,
    sourceModelId: row.source_model_id,
    authoritative: row.authoritative,
  })), [
    {
      effectiveAt: "2025-09-15T00:00:00.000Z",
      validUntil: "2026-06-15T00:00:00.000Z",
      input: 5,
      output: 25,
      sourceRef: BASELINE.sha,
      sourceModelId: MODEL,
      authoritative: true,
    },
    {
      effectiveAt: "2026-06-15T00:00:00.000Z",
      validUntil: "2026-06-21T00:00:00.000Z",
      input: 6,
      output: 30,
      sourceRef: CHANGE.sha,
      sourceModelId: MODEL,
      authoritative: true,
    },
  ]);

  const schedule = await loadPricingSchedule(async (sql) => {
    const loaded = await pool.query(sql);
    return { rows: loaded.rows as never[] };
  });
  const costAt = (occurredAt: string) => resolveCostAt({
    model: MODEL,
    occurredAt: new Date(occurredAt),
    schedule,
    mode: "calculate",
    inputTokens: 1_000_000,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  });
  const before = costAt("2026-06-14T23:59:59.000Z");
  const after = costAt("2026-06-15T00:00:00.000Z");
  assert.equal(before.status, "priced");
  assert.equal(before.costUsd, 5);
  assert.equal(after.status, "priced");
  assert.equal(after.costUsd, 6);

  await pool.query(`
    INSERT INTO providers (key, display_name, service_name_patterns, collection_method)
    VALUES ('fixture', 'Fixture', ARRAY['fixture'], 'otel')
    ON CONFLICT (key) DO NOTHING
  `);
  await pool.query(
    `INSERT INTO usage_events (
       dedup_key, provider_key, model, ts,
       input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
       cost_usd, cost_status
     ) VALUES ($1, 'fixture', $2, $3, 1000000, 500000, 300000, 200000, 99, 'legacy')`,
    ["legacy-before-90-days", MODEL, new Date("2025-10-01T12:00:00.000Z")],
  );
  const invariantBefore = await pool.query<{
    events: string;
    input_tokens: string;
    output_tokens: string;
    cache_read_tokens: string;
    cache_creation_tokens: string;
  }>(`
    SELECT count(*) AS events,
           sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens,
           sum(cache_read_tokens) AS cache_read_tokens,
           sum(cache_creation_tokens) AS cache_creation_tokens
    FROM usage_events WHERE dedup_key = 'legacy-before-90-days'
  `);
  const storage = new PostgresStorage(pool, { timezone: "UTC" });
  const recoveryDiagnostics = await storage.getPricingRecoveryModels(new Date(0), NOW);
  assert.deepEqual(recoveryDiagnostics.map((item) => ({
    model: item.model,
    events: item.events,
    unpricedEvents: item.unpricedEvents,
    legacyEvents: item.legacyEvents,
    firstAt: item.firstAt.toISOString(),
  })), [{
    model: MODEL,
    events: 1,
    unpricedEvents: 0,
    legacyEvents: 1,
    firstAt: "2025-10-01T12:00:00.000Z",
  }]);
  const repaired = await storage.repairPricingUsage({
    from: new Date(0),
    to: NOW,
    models: [MODEL],
    replaceRevisionIds: [],
    limit: 100,
    generation: NOW.toISOString(),
  }, (event) => {
    const resolved = resolveCostAt({
      ...event,
      occurredAt: event.ts,
      schedule,
      mode: "calculate",
    });
    return resolved.status === "priced" && resolved.pricingRevisionId
      ? { costUsd: resolved.costUsd, pricingRevisionId: resolved.pricingRevisionId }
      : null;
  });
  assert.deepEqual(repaired, {
    scanned: 1,
    recovered: 0,
    repricedLegacy: 1,
    affectedBuckets: [new Date("2025-10-01T00:00:00.000Z")],
    hasMore: false,
  });
  const repriced = await pool.query<{
    cost_usd: string;
    cost_status: string;
    pricing_revision_id: string | null;
  }>(`
    SELECT cost_usd, cost_status, pricing_revision_id
    FROM usage_events WHERE dedup_key = 'legacy-before-90-days'
  `);
  assert.equal(Number(repriced.rows[0]?.cost_usd), 18.9);
  assert.equal(repriced.rows[0]?.cost_status, "priced");
  assert.ok(repriced.rows[0]?.pricing_revision_id);
  const invariantAfter = await pool.query(`
    SELECT count(*) AS events,
           sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens,
           sum(cache_read_tokens) AS cache_read_tokens,
           sum(cache_creation_tokens) AS cache_creation_tokens
    FROM usage_events WHERE dedup_key = 'legacy-before-90-days'
  `);
  assert.deepEqual(invariantAfter.rows, invariantBefore.rows);

  const repair = await pool.query<{ state: string; target_to: Date }>(
    "SELECT state, target_to FROM pricing_repair_status WHERE singleton",
  );
  assert.equal(repair.rows[0]?.state, "pending");
  assert.equal(repair.rows[0]?.target_to.toISOString(), NOW.toISOString());
  const version = await pool.query<{ value: { updatedAt?: string } }>(
    "SELECT value FROM app_settings WHERE key = 'pricing_cache_version'",
  );
  assert.equal(version.rows[0]?.value.updatedAt, NOW.toISOString());

  return {
    revisions: revisions.rows.length,
    beforeChangeCostUsd: before.costUsd,
    afterChangeCostUsd: after.costUsd,
    repricedLegacy: repaired.repricedLegacy,
    retainedEventInvariants: "preserved",
    repairState: repair.rows[0]?.state,
  };
}

async function verifyMalformedSnapshotContinuity(pool: Pool): Promise<Record<string, unknown>> {
  const rangeFrom = new Date("2025-09-15T00:00:00.000Z");
  const rangeTo = new Date("2025-12-01T00:00:00.000Z");
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO pricing_history_jobs (
       state, range_from, range_to, models, commit_refs,
       list_page, next_commit_index, consecutive_failures, last_started_at, updated_at
     ) VALUES ('fetching', $1, $2, $3::jsonb, $4::jsonb, 0, 0, 2, $5, $5)
     RETURNING id`,
    [rangeFrom, rangeTo, JSON.stringify([GAP_MODEL]), JSON.stringify([
      GAP_BASELINE,
      GAP_BROKEN,
      GAP_AFTER,
    ]), NOW],
  );
  const jobId = inserted.rows[0]?.id;
  assert.ok(jobId);
  const source = {
    async listBaseline(): Promise<PricingHistoryCommitRef[]> {
      throw new Error("unexpected baseline listing");
    },
    async listChanges(): Promise<PricingHistoryCommitRef[]> {
      throw new Error("unexpected changes listing");
    },
    async fetchSnapshot(sha: string): Promise<PricingMap> {
      if (sha === GAP_BASELINE.sha) return new Map([[GAP_MODEL, { inputPerM: 1, outputPerM: 2 }]]);
      if (sha === GAP_BROKEN.sha) throw new PricingSnapshotInvalidError(sha);
      if (sha === GAP_AFTER.sha) return new Map([[GAP_MODEL, { inputPerM: 3, outputPerM: 4 }]]);
      throw new Error("unexpected gap fixture commit");
    },
  };
  const runStep = () => runHistoricalPricingStepWith({
    repository: new PgPricingHistoryRepository(pool),
    source,
    now: () => NOW,
    timezone: "UTC",
    invalidateCache: () => undefined,
  }, []);

  assert.deepEqual(await runStep(), { state: "fetching", nextAttemptAt: NOW });
  const skipped = await pool.query<{
    next_commit_index: number;
    state: string;
    last_error: string | null;
  }>(
    `SELECT next_commit_index, state, last_error
     FROM pricing_history_jobs WHERE id = $1`,
    [jobId],
  );
  assert.deepEqual(skipped.rows[0], {
    next_commit_index: 2,
    state: "fetching",
    last_error: "invalid pricing snapshot skipped",
  });
  const beforeGap = await pool.query<{ effective_at: Date; valid_until: Date | null }>(
    `SELECT effective_at, valid_until
     FROM pricing_history_candidates WHERE job_id = $1 ORDER BY effective_at`,
    [jobId],
  );
  assert.deepEqual(beforeGap.rows.map((row) => ({
    effectiveAt: row.effective_at.toISOString(),
    validUntil: row.valid_until?.toISOString() ?? null,
  })), [{
    effectiveAt: rangeFrom.toISOString(),
    validUntil: null,
  }]);

  assert.deepEqual(await runStep(), { state: "fetching", nextAttemptAt: NOW });
  assert.deepEqual(await runStep(), { state: "promoted", insertedRevisions: 2 });
  const revisions = await pool.query<{
    effective_at: Date;
    valid_until: Date;
    input_price_per_mtok: string;
  }>(
    `SELECT effective_at, valid_until, input_price_per_mtok
     FROM pricing_revisions
     WHERE model_id = $1 AND source = 'litellm-git-history'
     ORDER BY effective_at`,
    [GAP_MODEL],
  );
  assert.deepEqual(revisions.rows.map((row) => ({
    effectiveAt: row.effective_at.toISOString(),
    validUntil: row.valid_until.toISOString(),
    input: Number(row.input_price_per_mtok),
  })), [{
    effectiveAt: rangeFrom.toISOString(),
    validUntil: GAP_AFTER.committedAt,
    input: 1,
  }, {
    effectiveAt: GAP_AFTER.committedAt,
    validUntil: rangeTo.toISOString(),
    input: 3,
  }]);

  return {
    skippedCommit: GAP_BROKEN.sha,
    continuousPricing: `${rangeFrom.toISOString()}/${rangeTo.toISOString()}`,
    revisions: revisions.rows.length,
  };
}

async function verifyExistingRepairAndRollups(): Promise<void> {
  const result = await execFileAsync("pnpm", ["verify:pricing-auto-recovery"], {
    cwd: ROOT,
    maxBuffer: 20 * 1024 * 1024,
  });
  assert.match(result.stdout, /PRICING_AUTO_RECOVERY_PASS/);
}

async function main(): Promise<void> {
  const container = `toard-pricing-history-verify-${randomUUID().slice(0, 8)}`;
  let pool: Pool | null = null;
  try {
    await execFileAsync("docker", [
      "run", "-d", "--rm", "--name", container,
      "--tmpfs", "/var/lib/postgresql/data:rw",
      "-e", "POSTGRES_PASSWORD=postgres",
      "-e", "POSTGRES_DB=toard",
      "-p", "127.0.0.1::5432",
      "postgres:16-alpine",
    ]);
    const { stdout } = await execFileAsync("docker", ["port", container, "5432/tcp"]);
    const port = stdout.trim().match(/:(\d+)$/)?.[1];
    assert.ok(port, `failed to resolve PostgreSQL port: ${stdout}`);
    const connectionString = `postgresql://postgres:postgres@127.0.0.1:${port}/toard`;
    await waitForPostgres(connectionString);
    const migrationClient = new Client({ connectionString });
    await migrationClient.connect();
    try {
      await applyMigrations(migrationClient);
    } finally {
      await migrationClient.end();
    }
    pool = new Pool({ connectionString, max: 4 });
    const history = await verifyDurableHistoryPromotion(pool);
    const malformedSnapshot = await verifyMalformedSnapshotContinuity(pool);
    await pool.end();
    pool = null;
    await execFileAsync("docker", ["rm", "-f", container]);

    await verifyExistingRepairAndRollups();
    process.stdout.write(`${JSON.stringify({ history, malformedSnapshot, rollups: "verified" }, null, 2)}\n`);
    process.stdout.write("HISTORICAL_PRICING_RECOVERY_PASS\n");
  } finally {
    await pool?.end().catch(() => undefined);
    await execFileAsync("docker", ["rm", "-f", container]).catch(() => undefined);
  }
}

await main();
