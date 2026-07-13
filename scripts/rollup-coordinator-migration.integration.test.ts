import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import { Client, Pool } from "pg";
import { PgTimezoneRollupRepository } from "../apps/web/lib/timezone-rollup";

const execFileAsync = promisify(execFile);
const PRE_COORDINATOR_MIGRATIONS = [
  "1700000018_clickhouse_rollup_watermark.sql",
  "1700000022_clickhouse_timezone_rollup.sql",
  "1700000023_clickhouse_timezone_rollup_coverage.sql",
  "1700000024_clickhouse_rollup_worker_status.sql",
  "1700000025_clickhouse_rollup_automation.sql",
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

test("migration 26은 기존 DST day job의 source_to와 generation을 보존한다", { timeout: 90_000 }, async () => {
  const container = `toard-rollup-coordinator-migration-${randomUUID().slice(0, 8)}`;
  let client: Client | null = null;
  let pool: Pool | null = null;

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
    for (const migration of PRE_COORDINATOR_MIGRATIONS) {
      await applyUpMigration(client, migration);
    }
    await client.query(`
      INSERT INTO clickhouse_rollup_timezones (timezone)
      VALUES ('America/Los_Angeles');
      INSERT INTO clickhouse_timezone_rollup_jobs (resolution, timezone, bucket)
      VALUES
        ('day', 'America/Los_Angeles', TIMESTAMPTZ '2026-03-08T08:00:00Z'),
        ('day', 'America/Los_Angeles', TIMESTAMPTZ '2026-11-01T07:00:00Z');
    `);
    await applyUpMigration(client, "1700000026_clickhouse_rollup_coordinator.sql");

    const result = await client.query<{
      bucket: Date;
      source_to: Date;
      generation: string | number;
    }>(`
      SELECT bucket, source_to, generation
      FROM clickhouse_timezone_rollup_jobs
      ORDER BY bucket
    `);
    assert.deepEqual(
      result.rows.map(({ bucket, source_to, generation }) => ({
        hours: (source_to.getTime() - bucket.getTime()) / 3_600_000,
        generation: Number(generation),
      })),
      [
        { hours: 23, generation: 0 },
        { hours: 25, generation: 0 },
      ],
    );

    const scheduler = await client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM clickhouse_rollup_scheduler_status WHERE singleton",
    );
    assert.equal(scheduler.rows[0]?.count, 1);

    await client.query(`
      UPDATE clickhouse_timezone_rollup_jobs SET status = 'done';
      INSERT INTO clickhouse_rollup_watermarks (name, watermark)
      VALUES ('usage_15m_v2', TIMESTAMPTZ '2026-07-13T02:00:00Z');
    `);
    const inserted = await client.query<{ id: string }>(`
      INSERT INTO clickhouse_timezone_rollup_jobs (
        resolution, timezone, bucket, source_to
      ) VALUES (
        'hour', 'America/Los_Angeles',
        TIMESTAMPTZ '2026-07-13T00:00:00Z',
        TIMESTAMPTZ '2026-07-13T01:00:00Z'
      )
      RETURNING id::text
    `);
    const jobId = inserted.rows[0]?.id;
    assert.ok(jobId);

    pool = new Pool({ connectionString, max: 3 });
    const repository = new PgTimezoneRollupRepository(pool);
    const [claimed] = await repository.claimJobs(1);
    assert.equal(claimed?.id, jobId);
    assert.equal(claimed?.generation, 0);

    const invalidator = await pool.connect();
    try {
      await invalidator.query("BEGIN");
      await invalidator.query(
        `UPDATE clickhouse_timezone_rollup_jobs
         SET status = 'pending', generation = generation + 1, updated_at = now()
         WHERE id = $1`,
        [jobId],
      );
      await invalidator.query(
        `INSERT INTO clickhouse_rollup_dirty_buckets (name, bucket)
         VALUES ('usage_15m_v2', TIMESTAMPTZ '2026-07-13T00:15:00Z')`,
      );

      const staleCompletion = repository.markDone(jobId, claimed!.generation);
      await new Promise((resolve) => setImmediate(resolve));
      await invalidator.query("COMMIT");
      assert.equal(await staleCompletion, false);
    } catch (error) {
      await invalidator.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      invalidator.release();
    }

    const staleResult = await client.query<{
      status: string;
      generation: string | number;
      coverage: number;
    }>(`
      SELECT job.status, job.generation,
             count(coverage.bucket)::int AS coverage
      FROM clickhouse_timezone_rollup_jobs AS job
      LEFT JOIN clickhouse_timezone_rollup_coverage AS coverage
        ON coverage.resolution = job.resolution
       AND coverage.timezone = job.timezone
       AND coverage.bucket = job.bucket
      WHERE job.id = $1
      GROUP BY job.status, job.generation
    `, [jobId]);
    assert.deepEqual(staleResult.rows[0], {
      status: "pending",
      generation: "1",
      coverage: 0,
    });
  } finally {
    await pool?.end().catch(() => undefined);
    await client?.end().catch(() => undefined);
    await execFileAsync("docker", ["rm", "-f", container]).catch(() => undefined);
  }
});
