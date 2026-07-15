import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import { Client } from "pg";

const execFileAsync = promisify(execFile);

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

test("migration 32는 전체 보존 레거시 가격 복구를 pending으로 시작한다", { timeout: 90_000 }, async () => {
  const container = `toard-full-retention-pricing-${randomUUID().slice(0, 8)}`;
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
    await client.query(`
      CREATE TABLE pricing_repair_status (
        singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
        generation TIMESTAMPTZ,
        state TEXT NOT NULL DEFAULT 'idle',
        target_to TIMESTAMPTZ,
        processed_events BIGINT NOT NULL DEFAULT 0,
        recovered_events BIGINT NOT NULL DEFAULT 0,
        reconciled_events BIGINT NOT NULL DEFAULT 0,
        remaining_unpriced_events BIGINT NOT NULL DEFAULT 0,
        unresolved_models JSONB NOT NULL DEFAULT '[]'::jsonb,
        eligible_since TIMESTAMPTZ,
        next_attempt_at TIMESTAMPTZ,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      INSERT INTO pricing_repair_status (
        singleton, state, processed_events, recovered_events, reconciled_events,
        remaining_unpriced_events, unresolved_models, consecutive_failures, last_error
      ) VALUES (
        TRUE, 'idle', 100, 80, 20, 0, '[{"model":"old"}]', 3, 'old failure'
      );
    `);

    const migration = await readFile(
      "migrations/1700000032_full_retention_legacy_pricing_recovery.sql",
      "utf8",
    );
    await client.query(migration.split("-- Down Migration", 1)[0]);

    const status = await client.query<{
      state: string;
      generation: Date | null;
      target_to: Date | null;
      eligible_since: Date | null;
      next_attempt_at: Date | null;
      processed_events: string;
      recovered_events: string;
      reconciled_events: string;
      repriced_legacy_events: string;
      remaining_unpriced_events: string;
      remaining_legacy_events: string;
      unresolved_models: unknown[];
      consecutive_failures: number;
      last_error: string | null;
    }>(`
      SELECT state, generation, target_to, eligible_since, next_attempt_at,
             processed_events, recovered_events, reconciled_events,
             repriced_legacy_events, remaining_unpriced_events, remaining_legacy_events,
             unresolved_models, consecutive_failures, last_error
      FROM pricing_repair_status
      WHERE singleton
    `);

    assert.equal(status.rows[0]?.state, "pending");
    assert.ok(status.rows[0]?.generation instanceof Date);
    assert.ok(status.rows[0]?.target_to instanceof Date);
    assert.ok(status.rows[0]?.eligible_since instanceof Date);
    assert.ok(status.rows[0]?.next_attempt_at instanceof Date);
    assert.equal(status.rows[0]?.processed_events, "0");
    assert.equal(status.rows[0]?.recovered_events, "0");
    assert.equal(status.rows[0]?.reconciled_events, "0");
    assert.equal(status.rows[0]?.repriced_legacy_events, "0");
    assert.equal(status.rows[0]?.remaining_unpriced_events, "0");
    assert.equal(status.rows[0]?.remaining_legacy_events, "0");
    assert.deepEqual(status.rows[0]?.unresolved_models, []);
    assert.equal(status.rows[0]?.consecutive_failures, 0);
    assert.equal(status.rows[0]?.last_error, null);

    const down = migration.split("-- Down Migration", 2)[1];
    assert.ok(down);
    await client.query(down);
    const columns = await client.query<{ column_name: string }>(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'pricing_repair_status'
        AND column_name IN ('repriced_legacy_events', 'remaining_legacy_events')
    `);
    assert.deepEqual(columns.rows, []);
  } finally {
    await client?.end().catch(() => undefined);
    await execFileAsync("docker", ["rm", "-f", container]).catch(() => undefined);
  }
});
