import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import { Client } from "pg";

const execFileAsync = promisify(execFile);
const MIGRATION = "migrations/1700000041_late_unpriced_ingest_repair.sql";

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

async function migrationSections(): Promise<{ up: string; down: string }> {
  const sql = await readFile(MIGRATION, "utf8");
  const [up, down] = sql.split("-- Down Migration", 2);
  assert.ok(up);
  assert.ok(down);
  return { up, down };
}

test("migration 41은 늦게 수집된 미확정 사용량을 실행 중 generation과 병합한다", { timeout: 90_000 }, async () => {
  const container = `toard-late-pricing-${randomUUID().slice(0, 8)}`;
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
        state TEXT NOT NULL DEFAULT 'idle'
          CHECK (state IN ('idle', 'pending', 'running', 'waiting_for_catalog', 'failed')),
        target_to TIMESTAMPTZ,
        processed_events BIGINT NOT NULL DEFAULT 0,
        recovered_events BIGINT NOT NULL DEFAULT 0,
        reconciled_events BIGINT NOT NULL DEFAULT 0,
        repriced_legacy_events BIGINT NOT NULL DEFAULT 0,
        remaining_unpriced_events BIGINT NOT NULL DEFAULT 0,
        remaining_legacy_events BIGINT NOT NULL DEFAULT 0,
        unresolved_models JSONB NOT NULL DEFAULT '[]'::jsonb,
        last_started_at TIMESTAMPTZ,
        last_succeeded_at TIMESTAMPTZ,
        last_error TEXT,
        adaptive_limit INTEGER NOT NULL DEFAULT 100,
        load_state TEXT NOT NULL DEFAULT 'normal',
        eligible_since TIMESTAMPTZ,
        next_attempt_at TIMESTAMPTZ,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      INSERT INTO pricing_repair_status (singleton) VALUES (TRUE);
    `);

    const migration = await migrationSections();
    await client.query(migration.up);

    const upgraded = await client.query<{
      state: string;
      generation: Date | null;
      target_to: Date | null;
      queued_target_to: Date | null;
    }>(`
      SELECT state, generation, target_to, queued_target_to
      FROM pricing_repair_status WHERE singleton
    `);
    assert.equal(upgraded.rows[0]?.state, "pending");
    assert.ok(upgraded.rows[0]?.generation instanceof Date);
    assert.ok(upgraded.rows[0]?.target_to instanceof Date);
    assert.equal(upgraded.rows[0]?.queued_target_to, null);

    const generation = new Date("2026-07-19T09:00:00.000Z");
    const target = new Date("2026-07-19T09:01:00.000Z");
    const retry = new Date("2026-07-19T10:00:00.000Z");
    await client.query(`
      UPDATE pricing_repair_status
      SET generation = $1, state = 'running', target_to = $2,
          processed_events = 17, recovered_events = 3,
          eligible_since = $1, next_attempt_at = $3
      WHERE singleton
    `, [generation, target, retry]);
    await client.query("SELECT enqueue_pricing_repair($1)", [new Date("2026-07-19T09:02:00.000Z")]);
    await client.query("SELECT enqueue_pricing_repair($1)", [new Date("2026-07-19T09:01:30.000Z")]);

    const running = await client.query<{
      state: string;
      generation: Date;
      target_to: Date;
      queued_target_to: Date;
      next_attempt_at: Date;
      processed_events: string;
      recovered_events: string;
    }>(`
      SELECT state, generation, target_to, queued_target_to, next_attempt_at,
             processed_events, recovered_events
      FROM pricing_repair_status WHERE singleton
    `);
    assert.equal(running.rows[0]?.state, "running");
    assert.equal(running.rows[0]?.generation.toISOString(), generation.toISOString());
    assert.equal(running.rows[0]?.target_to.toISOString(), target.toISOString());
    assert.equal(running.rows[0]?.queued_target_to.toISOString(), "2026-07-19T09:02:00.000Z");
    assert.equal(running.rows[0]?.next_attempt_at.toISOString(), retry.toISOString());
    assert.equal(running.rows[0]?.processed_events, "17");
    assert.equal(running.rows[0]?.recovered_events, "3");

    for (const state of ["waiting_for_catalog", "failed"] as const) {
      await client.query(`
        UPDATE pricing_repair_status
        SET state = $1, queued_target_to = NULL, next_attempt_at = $2
        WHERE singleton
      `, [state, retry]);
      await client.query("SELECT enqueue_pricing_repair($1)", [new Date("2026-07-19T09:03:00.000Z")]);
      const waiting = await client.query<{
        state: string;
        generation: Date;
        queued_target_to: Date;
        next_attempt_at: Date;
      }>(`
        SELECT state, generation, queued_target_to, next_attempt_at
        FROM pricing_repair_status WHERE singleton
      `);
      assert.equal(waiting.rows[0]?.state, state);
      assert.equal(waiting.rows[0]?.generation.toISOString(), generation.toISOString());
      assert.equal(waiting.rows[0]?.queued_target_to.toISOString(), "2026-07-19T09:03:00.000Z");
      assert.equal(waiting.rows[0]?.next_attempt_at.toISOString(), retry.toISOString());
    }

    await client.query(`
      UPDATE pricing_repair_status
      SET state = 'idle', processed_events = 44, recovered_events = 11,
          unresolved_models = '[{"model":"missing","events":33}]'::jsonb,
          consecutive_failures = 2, last_error = 'previous failure',
          queued_target_to = '2026-07-19 09:03:00+00'
      WHERE singleton
    `);
    const idleRequest = new Date("2026-07-19T09:04:00.000Z");
    await client.query("SELECT enqueue_pricing_repair($1)", [idleRequest]);
    const restarted = await client.query<{
      state: string;
      generation: Date;
      target_to: Date;
      queued_target_to: Date | null;
      processed_events: string;
      recovered_events: string;
      unresolved_models: unknown[];
      consecutive_failures: number;
      last_error: string | null;
    }>(`
      SELECT state, generation, target_to, queued_target_to,
             processed_events, recovered_events, unresolved_models,
             consecutive_failures, last_error
      FROM pricing_repair_status WHERE singleton
    `);
    assert.equal(restarted.rows[0]?.state, "pending");
    assert.equal(restarted.rows[0]?.generation.toISOString(), idleRequest.toISOString());
    assert.equal(restarted.rows[0]?.target_to.toISOString(), idleRequest.toISOString());
    assert.equal(restarted.rows[0]?.queued_target_to, null);
    assert.equal(restarted.rows[0]?.processed_events, "0");
    assert.equal(restarted.rows[0]?.recovered_events, "0");
    assert.deepEqual(restarted.rows[0]?.unresolved_models, []);
    assert.equal(restarted.rows[0]?.consecutive_failures, 0);
    assert.equal(restarted.rows[0]?.last_error, null);

    await client.query(migration.down);
    const column = await client.query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'pricing_repair_status' AND column_name = 'queued_target_to'
    `);
    assert.equal(column.rowCount, 0);
    const fn = await client.query(`
      SELECT 1 FROM pg_proc WHERE proname = 'enqueue_pricing_repair'
    `);
    assert.equal(fn.rowCount, 0);
  } finally {
    await client?.end().catch(() => undefined);
    await execFileAsync("docker", ["rm", "-f", container]).catch(() => undefined);
  }
});
