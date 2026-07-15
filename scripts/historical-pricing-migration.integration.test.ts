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

test("migration 29는 과거 가격 후보를 canonical revision과 분리한다", { timeout: 90_000 }, async () => {
  const container = `toard-pricing-history-migration-${randomUUID().slice(0, 8)}`;
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
      CREATE EXTENSION IF NOT EXISTS pgcrypto;
      CREATE TABLE pricing_revisions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        model_id TEXT NOT NULL,
        effective_at TIMESTAMPTZ NOT NULL,
        input_price_per_mtok NUMERIC NOT NULL,
        output_price_per_mtok NUMERIC NOT NULL,
        cache_read_price_per_mtok NUMERIC,
        cache_creation_price_per_mtok NUMERIC,
        input_price_above_200k_per_mtok NUMERIC,
        output_price_above_200k_per_mtok NUMERIC,
        fast_multiplier NUMERIC NOT NULL DEFAULT 1,
        source TEXT NOT NULL,
        observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (model_id, effective_at, source)
      );
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
      INSERT INTO pricing_repair_status (singleton) VALUES (TRUE);
      INSERT INTO pricing_revisions (
        model_id, effective_at, input_price_per_mtok, output_price_per_mtok, source
      ) VALUES
        ('bootstrap-model', '2026-06-01T00:00:00Z', 5, 25, 'litellm-bootstrap'),
        ('observed-model', '2026-07-01T00:00:00Z', 3, 15, 'litellm');
    `);

    const migration = await readFile("migrations/1700000029_historical_pricing_recovery.sql", "utf8");
    await client.query(migration.split("-- Down Migration", 1)[0]);

    const columns = await client.query<{ column_name: string }>(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'pricing_revisions'
        AND column_name IN ('authoritative', 'valid_until', 'source_ref', 'source_model_id')
      ORDER BY column_name
    `);
    assert.deepEqual(columns.rows.map((row) => row.column_name), [
      "authoritative",
      "source_model_id",
      "source_ref",
      "valid_until",
    ]);

    const authority = await client.query<{ model_id: string; authoritative: boolean }>(`
      SELECT model_id, authoritative
      FROM pricing_revisions
      ORDER BY model_id
    `);
    assert.deepEqual(authority.rows, [
      { model_id: "bootstrap-model", authoritative: false },
      { model_id: "observed-model", authoritative: true },
    ]);

    const repair = await client.query<{
      state: string;
      generation: Date;
      target_to: Date;
      next_attempt_at: Date;
    }>(`
      SELECT state, generation, target_to, next_attempt_at
      FROM pricing_repair_status
      WHERE singleton
    `);
    assert.equal(repair.rows[0]?.state, "pending");
    assert.ok(repair.rows[0]?.generation instanceof Date);
    assert.equal(repair.rows[0]?.target_to.toISOString(), repair.rows[0]?.generation.toISOString());
    assert.equal(repair.rows[0]?.next_attempt_at.toISOString(), repair.rows[0]?.generation.toISOString());

    const activeIndex = await client.query<{ indexdef: string }>(`
      SELECT indexdef FROM pg_indexes
      WHERE indexname = 'pricing_history_one_active_job'
    `);
    assert.match(activeIndex.rows[0]?.indexdef ?? "", /WHERE \(state <> 'completed'::text\)/);

    const job = await client.query<{ id: string }>(`
      INSERT INTO pricing_history_jobs (state, range_from, range_to, models)
      VALUES ('pending', '2026-06-01T00:00:00Z', '2026-07-01T00:00:00Z', '["claude-opus"]')
      RETURNING id
    `);
    await client.query(`
      INSERT INTO pricing_history_candidates (
        job_id, model_id, source_model_id, effective_at, valid_until,
        input_price_per_mtok, output_price_per_mtok,
        source_commit_sha, source_committed_at
      ) VALUES (
        $1, 'claude-opus', 'claude-opus',
        '2026-06-01T00:00:00Z', '2026-07-01T00:00:00Z',
        5, 25, repeat('a', 40), '2026-05-31T23:00:00Z'
      )
    `, [job.rows[0]?.id]);
    const canonical = await client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM pricing_revisions WHERE model_id = 'claude-opus'",
    );
    assert.equal(canonical.rows[0]?.count, 0);

    await assert.rejects(
      client.query(`
        INSERT INTO pricing_history_jobs (state, range_from, range_to, models)
        VALUES ('listing', '2026-06-01T00:00:00Z', '2026-06-02T00:00:00Z', '[]')
      `),
      /pricing_history_one_active_job/,
    );
  } finally {
    await client?.end().catch(() => undefined);
    await execFileAsync("docker", ["rm", "-f", container]).catch(() => undefined);
  }
});
