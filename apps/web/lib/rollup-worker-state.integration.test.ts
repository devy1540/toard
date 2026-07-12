import assert from "node:assert/strict";
import test from "node:test";
import { Pool } from "pg";
import { PgRollupWorkerRepository } from "./rollup-worker-state";
import { createIsolatedPostgresPoolConfig } from "./rollup-worker-state.integration-test-support";

const databaseUrl = process.env.ROLLUP_WORKER_ISOLATED_TEST_DATABASE_URL;

test("격리 PostgreSQL에서 markSucceeded가 누적값과 EMA를 갱신한다", {
  skip: databaseUrl ? false : "ROLLUP_WORKER_ISOLATED_TEST_DATABASE_URL is not set",
}, async () => {
  const poolConfig = createIsolatedPostgresPoolConfig(databaseUrl!);
  const pool = new Pool(poolConfig);
  try {
    const activatedAt = new Date("2026-07-12T11:50:00.000Z");
    await pool.query(
      `UPDATE clickhouse_rollup_worker_status
       SET activated_at = $2,
           last_started_at = NULL,
           last_finished_at = NULL,
           last_success_at = NULL,
           last_progress_at = NULL,
           last_duration_ms = NULL,
           last_processed_units = 0,
           last_processed_rows = 0,
           processed_units_total = 7,
           processed_rows_total = 110,
           throughput_units_per_minute = 8
       WHERE worker = $1`,
      ["usage_15m_v2", activatedAt],
    );

    const repository = new PgRollupWorkerRepository(pool);
    const startedAt = new Date("2026-07-12T12:00:00.000Z");
    const finishedAt = new Date("2026-07-12T12:00:10.000Z");

    await repository.markSucceeded(
      "usage_15m_v2",
      startedAt,
      finishedAt,
      { units: 1, rows: 10 },
    );

    const record = await repository.get("usage_15m_v2");
    assert.equal(record.activatedAt.toISOString(), activatedAt.toISOString());
    assert.equal(record.lastStartedAt?.toISOString(), startedAt.toISOString());
    assert.equal(record.lastFinishedAt?.toISOString(), finishedAt.toISOString());
    assert.equal(record.lastSuccessAt?.toISOString(), finishedAt.toISOString());
    assert.equal(record.lastProgressAt?.toISOString(), finishedAt.toISOString());
    assert.equal(record.lastDurationMs, 10_000);
    assert.equal(record.lastProcessedUnits, 1);
    assert.equal(record.lastProcessedRows, 10);
    assert.equal(record.processedUnitsTotal, 8);
    assert.equal(record.processedRowsTotal, 120);
    assert.ok(
      record.throughputUnitsPerMinute != null &&
        Math.abs(record.throughputUnitsPerMinute - 5.9) < Number.EPSILON * 10,
    );
  } finally {
    await pool.end();
  }
});
