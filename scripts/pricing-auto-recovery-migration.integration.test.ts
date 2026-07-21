import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import { Client, type Pool } from "pg";
import { PgPricingRepairRepository } from "../apps/web/lib/pricing-repair";

const execFileAsync = promisify(execFile);
const PREREQUISITE_MIGRATIONS = [
  "1700000018_clickhouse_rollup_watermark.sql",
  "1700000022_clickhouse_timezone_rollup.sql",
  "1700000023_clickhouse_timezone_rollup_coverage.sql",
  "1700000024_clickhouse_rollup_worker_status.sql",
  "1700000025_clickhouse_rollup_automation.sql",
  "1700000026_clickhouse_rollup_coordinator.sql",
] as const;

async function waitForPostgres(connectionString: string): Promise<void> {
  let lastError: unknown;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const probe = new Client({ connectionString, connectionTimeoutMillis: 1_000, query_timeout: 1_000 });
    try {
      await probe.connect();
      await probe.query("SELECT 1");
      await probe.end();
      return;
    } catch (error) {
      lastError = error;
      await probe.end().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError;
}

async function applyUpMigration(client: Client, filename: string): Promise<void> {
  const migration = await readFile(`migrations/${filename}`, "utf8");
  await client.query(migration.split("-- Down Migration", 1)[0]);
}

test("migration 28은 기존 설치의 가격 자동 복구를 즉시 pending으로 시작한다", { timeout: 90_000 }, async () => {
  const container = `toard-pricing-repair-migration-${randomUUID().slice(0, 8)}`;
  let client: Client | null = null;

  try {
    await execFileAsync("docker", [
      "run", "-d", "--rm", "--name", container,
      "-e", "POSTGRES_PASSWORD=postgres",
      "-e", "POSTGRES_DB=toard",
      "-p", "127.0.0.1::5432",
      "postgres:16-alpine",
    ]);
    const { stdout } = await execFileAsync("docker", ["port", container, "5432/tcp"]);
    const port = stdout.trim().match(/:(\d+)$/)?.[1];
    assert.ok(port, `failed to resolve PostgreSQL port from: ${stdout}`);
    const connectionString = `postgresql://postgres:postgres@127.0.0.1:${port}/toard`;
    await waitForPostgres(connectionString);

    client = new Client({ connectionString });
    await client.connect();
    for (const migration of PREREQUISITE_MIGRATIONS) {
      await applyUpMigration(client, migration);
    }
    await applyUpMigration(client, "1700000027_pricing_auto_recovery.sql");

    const status = await client.query<{ state: string; adaptive_limit: number; unresolved_models: unknown[] }>(
      "SELECT state, adaptive_limit, unresolved_models FROM pricing_repair_status WHERE singleton",
    );
    assert.equal(status.rows[0]?.state, "idle");
    assert.equal(status.rows[0]?.adaptive_limit, 100);
    assert.deepEqual(status.rows[0]?.unresolved_models, []);

    await applyUpMigration(client, "1700000028_pricing_replay_reconciliation.sql");
    const initialized = await client.query<{
      state: string;
      generation: Date | null;
      target_to: Date | null;
      eligible_since: Date | null;
      next_attempt_at: Date | null;
      reconciled_events: number;
    }>(
      `SELECT state, generation, target_to, eligible_since, next_attempt_at, reconciled_events
       FROM pricing_repair_status WHERE singleton`,
    );
    assert.equal(initialized.rows[0]?.state, "pending");
    assert.ok(initialized.rows[0]?.generation);
    assert.ok(initialized.rows[0]?.target_to);
    assert.ok(initialized.rows[0]?.eligible_since);
    assert.ok(initialized.rows[0]?.next_attempt_at);
    assert.equal(Number(initialized.rows[0]?.reconciled_events), 0);

    await applyUpMigration(client, "1700000032_full_retention_legacy_pricing_recovery.sql");
    await applyUpMigration(client, "1700000041_late_unpriced_ingest_repair.sql");

    const exactGeneration = "2026-07-14 01:56:45.690911+00";
    await client.query(
      `UPDATE pricing_repair_status
       SET generation = $1::timestamptz,
           state = 'pending',
           target_to = $2,
           eligible_since = $2,
           next_attempt_at = $2,
           updated_at = $2
       WHERE singleton`,
      [exactGeneration, new Date("2026-07-14T02:00:00.000Z")],
    );
    const repository = new PgPricingRepairRepository(client as unknown as Pool);
    const claimed = await repository.claim(new Date("2026-07-14T02:00:01.000Z"));
    assert.equal(claimed?.generation, exactGeneration);
    assert.equal(await repository.markProgress({
      generation: claimed!.generation!,
      state: "pending",
      processed: 100,
      recovered: 0,
      reconciled: 100,
      repricedLegacy: 0,
      remaining: 9_833,
      remainingLegacy: 0,
      unresolvedModels: [],
      adaptiveLimit: 125,
      loadState: "normal",
      nextAttemptAt: new Date("2026-07-14T02:00:02.000Z"),
      at: new Date("2026-07-14T02:00:02.000Z"),
    }), true);
    const progressed = await client.query<{
      state: string;
      processed_events: string;
      reconciled_events: string;
      remaining_unpriced_events: string;
    }>(
      `SELECT state, processed_events, reconciled_events, remaining_unpriced_events
       FROM pricing_repair_status WHERE singleton`,
    );
    assert.deepEqual(progressed.rows[0], {
      state: "pending",
      processed_events: "100",
      reconciled_events: "100",
      remaining_unpriced_events: "9833",
    });

    const constraint = await client.query<{ definition: string }>(`
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = 'clickhouse_rollup_scheduler_status'::regclass
        AND conname = 'clickhouse_rollup_scheduler_status_last_selected_task_check'
    `);
    assert.match(constraint.rows[0]?.definition ?? "", /pricing_repair/);
    await client.query(
      "UPDATE clickhouse_rollup_scheduler_status SET last_selected_task = 'pricing_repair' WHERE singleton",
    );
  } finally {
    await client?.end().catch(() => undefined);
    await execFileAsync("docker", ["rm", "-f", container]).catch(() => undefined);
  }
});
