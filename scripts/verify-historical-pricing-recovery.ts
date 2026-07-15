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
import type { PricingHistoryCommitRef } from "../apps/web/lib/pricing-history-source";
import { loadPricingSchedule } from "../apps/web/lib/pricing";
import { Client, Pool } from "pg";

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const NOW = new Date("2026-07-14T00:00:00.000Z");
const MODEL = "fixture-history-model";
const BASELINE: PricingHistoryCommitRef = {
  sha: "a".repeat(40),
  committedAt: "2026-05-31T23:00:00.000Z",
};
const CHANGE: PricingHistoryCommitRef = {
  sha: "b".repeat(40),
  committedAt: "2026-06-15T00:00:00.000Z",
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
    firstAt: "2026-06-10T12:00:00.000Z",
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
      effectiveAt: "2026-06-10T00:00:00.000Z",
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
    repairState: repair.rows[0]?.state,
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
    await pool.end();
    pool = null;
    await execFileAsync("docker", ["rm", "-f", container]);

    await verifyExistingRepairAndRollups();
    process.stdout.write(`${JSON.stringify({ history, rollups: "verified" }, null, 2)}\n`);
    process.stdout.write("HISTORICAL_PRICING_RECOVERY_PASS\n");
  } finally {
    await pool?.end().catch(() => undefined);
    await execFileAsync("docker", ["rm", "-f", container]).catch(() => undefined);
  }
}

await main();
