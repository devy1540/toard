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

test("migration 34는 Codex 가격 별칭 보정을 릴리스 직후 pending으로 시작한다", { timeout: 90_000 }, async () => {
  const container = `toard-codex-pricing-${randomUUID().slice(0, 8)}`;
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
        repriced_legacy_events BIGINT NOT NULL DEFAULT 0,
        remaining_unpriced_events BIGINT NOT NULL DEFAULT 0,
        remaining_legacy_events BIGINT NOT NULL DEFAULT 0,
        unresolved_models JSONB NOT NULL DEFAULT '[]'::jsonb,
        eligible_since TIMESTAMPTZ,
        next_attempt_at TIMESTAMPTZ,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      INSERT INTO pricing_repair_status (
        singleton, state, processed_events, recovered_events, reconciled_events,
        repriced_legacy_events, remaining_unpriced_events, remaining_legacy_events,
        unresolved_models, consecutive_failures, last_error, next_attempt_at
      ) VALUES (
        TRUE, 'waiting_for_catalog', 88374, 107, 0, 85352, 0, 3022,
        '[{"model":"codex-auto-review","events":2736},{"model":null,"events":286}]',
        0, NULL, now() + INTERVAL '1 hour'
      );
    `);

    const migration = await readFile(
      "migrations/1700000034_codex_pricing_alias_recovery.sql",
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
      repriced_legacy_events: string;
      remaining_legacy_events: string;
      unresolved_models: unknown[];
    }>(`
      SELECT state, generation, target_to, eligible_since, next_attempt_at,
             processed_events, repriced_legacy_events, remaining_legacy_events,
             unresolved_models
      FROM pricing_repair_status
      WHERE singleton
    `);

    assert.equal(status.rows[0]?.state, "pending");
    assert.ok(status.rows[0]?.generation instanceof Date);
    assert.ok(status.rows[0]?.target_to instanceof Date);
    assert.ok(status.rows[0]?.eligible_since instanceof Date);
    assert.ok(status.rows[0]?.next_attempt_at instanceof Date);
    assert.equal(status.rows[0]?.processed_events, "0");
    assert.equal(status.rows[0]?.repriced_legacy_events, "0");
    assert.equal(status.rows[0]?.remaining_legacy_events, "0");
    assert.deepEqual(status.rows[0]?.unresolved_models, []);
  } finally {
    await client?.end().catch(() => undefined);
    await execFileAsync("docker", ["rm", "-f", container]).catch(() => undefined);
  }
});
