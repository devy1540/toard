import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { Pool } from "pg";
import { PgRollupCutoverRepository } from "./rollup-cutover-state";

const cutoverRow = {
  layer: "usage_15m_v2",
  state: "observing",
  target_watermark: new Date("2026-07-13T01:30:00.000Z"),
  healthy_seconds: "600",
  last_checked_at: new Date("2026-07-13T01:40:00.000Z"),
  last_validation_at: new Date("2026-07-13T01:30:00.000Z"),
  consecutive_failures: "0",
  last_failure_kind: null,
  last_failure: null,
  activated_at: null,
  updated_at: new Date("2026-07-13T01:40:00.000Z"),
} as const;

test("automation migration은 고정 목표와 누적 관찰 상태를 저장한다", async () => {
  const migration = await readFile(
    new URL("../../../migrations/1700000025_clickhouse_rollup_automation.sql", import.meta.url),
    "utf8",
  );

  assert.match(migration, /CREATE TABLE clickhouse_rollup_cutover_status/);
  assert.match(migration, /layer IN \('usage_15m_v2', 'timezone'\)/);
  assert.match(migration, /state IN \('backfilling', 'observing', 'active', 'fallback'\)/);
  assert.match(migration, /target_watermark TIMESTAMPTZ/);
  assert.match(migration, /healthy_seconds INTEGER NOT NULL DEFAULT 0/);
  assert.match(migration, /adaptive_limit INTEGER NOT NULL DEFAULT 16/);
  assert.match(migration, /UPDATE clickhouse_rollup_worker_status SET adaptive_limit = 8/);
  assert.match(migration, /-- Down Migration[\s\S]*DROP TABLE clickhouse_rollup_cutover_status/);
});

test("cutover repository는 PostgreSQL 행을 domain record로 매핑한다", async () => {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const pool = {
    async query(sql: string, params?: unknown[]) {
      queries.push({ sql, params });
      return { rows: [cutoverRow], rowCount: 1 };
    },
  } as unknown as Pool;
  const repository = new PgRollupCutoverRepository(pool);

  const record = await repository.get("usage_15m_v2");

  assert.equal(record.state, "observing");
  assert.equal(record.healthySeconds, 600);
  assert.equal(record.targetWatermark?.toISOString(), "2026-07-13T01:30:00.000Z");
  assert.deepEqual(queries[0]?.params, ["usage_15m_v2"]);
});

test("cutover repository는 저장 오류에서 민감값을 제거한다", async () => {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const pool = {
    async query(sql: string, params?: unknown[]) {
      queries.push({ sql, params });
      return { rows: [cutoverRow], rowCount: 1 };
    },
  } as unknown as Pool;
  const repository = new PgRollupCutoverRepository(pool);

  await repository.save("usage_15m_v2", {
    state: "fallback",
    targetWatermark: cutoverRow.target_watermark,
    healthySeconds: 600,
    lastCheckedAt: cutoverRow.last_checked_at,
    lastValidationAt: cutoverRow.last_validation_at,
    consecutiveFailures: 1,
    lastFailureKind: "unavailable",
    lastFailure: "postgres://admin:secret@db/toard?token=value",
    activatedAt: null,
  });

  assert.equal(queries[0]?.params?.[8], "postgres://[redacted]@db/toard?token=[redacted]");
});
