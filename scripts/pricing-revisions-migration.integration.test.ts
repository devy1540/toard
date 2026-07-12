import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";

const execFileAsync = promisify(execFile);

async function waitForPostgres(container: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await execFileAsync("docker", ["exec", container, "pg_isready", "-U", "postgres", "-d", "toard"]);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError;
}

test("pricing revision migration deduplicates legacy rows with the same revision key", { timeout: 60_000 }, async () => {
  const container = `toard-pricing-migration-${randomUUID().slice(0, 8)}`;
  let client: Client | null = null;

  try {
    await execFileAsync("docker", [
      "run", "-d", "--rm", "--name", container,
      "-e", "POSTGRES_PASSWORD=postgres",
      "-e", "POSTGRES_DB=toard",
      "-p", "127.0.0.1::5432",
      "postgres:16-alpine",
    ]);
    await waitForPostgres(container);

    const { stdout } = await execFileAsync("docker", ["port", container, "5432/tcp"]);
    const port = stdout.trim().match(/:(\d+)$/)?.[1];
    assert.ok(port, `failed to resolve PostgreSQL port from: ${stdout}`);

    client = new Client({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${port}/toard` });
    await client.connect();
    await client.query(`
      CREATE TABLE pricing_models (
        model_id TEXT NOT NULL,
        input_price_per_mtok NUMERIC NOT NULL,
        output_price_per_mtok NUMERIC NOT NULL,
        cache_read_price_per_mtok NUMERIC,
        cache_creation_price_per_mtok NUMERIC,
        input_price_above_200k_per_mtok NUMERIC,
        output_price_above_200k_per_mtok NUMERIC,
        fast_multiplier NUMERIC NOT NULL DEFAULT 1,
        effective_date DATE NOT NULL,
        source TEXT NOT NULL DEFAULT 'litellm'
      );
      CREATE TABLE usage_events (id UUID PRIMARY KEY DEFAULT gen_random_uuid());
      INSERT INTO pricing_models (
        model_id, input_price_per_mtok, output_price_per_mtok, effective_date, source
      ) VALUES
        ('duplicate-model', 3, 15, DATE '2026-07-10', 'litellm'),
        ('duplicate-model', 3, 15, DATE '2026-07-10', 'litellm');
    `);

    const migration = await readFile("migrations/1700000020_pricing_revisions.sql", "utf8");
    const upMigration = migration.split("-- Down Migration", 1)[0];
    await client.query(upMigration);

    const result = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM pricing_revisions
       WHERE model_id = 'duplicate-model'
         AND effective_at = TIMESTAMPTZ '2026-07-10T00:00:00Z'
         AND source = 'litellm'`,
    );
    assert.equal(result.rows[0]?.count, 1);
  } finally {
    await client?.end().catch(() => undefined);
    await execFileAsync("docker", ["rm", "-f", container]).catch(() => undefined);
  }
});
