import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { Pool } from "pg";
import { PgRollupCoordinatorRepository } from "./rollup-coordinator-state";

test("coordinator migration은 job generation과 durable scheduler 상태를 추가한다", async () => {
  const migration = await readFile(
    new URL("../../../migrations/1700000026_clickhouse_rollup_coordinator.sql", import.meta.url),
    "utf8",
  );

  assert.match(migration, /ADD COLUMN source_to TIMESTAMPTZ/);
  assert.match(migration, /ADD COLUMN generation BIGINT NOT NULL DEFAULT 0/);
  assert.match(migration, /ADD COLUMN eligible_since TIMESTAMPTZ/);
  assert.match(migration, /CREATE TABLE clickhouse_rollup_scheduler_status/);
  assert.match(migration, /INSERT INTO clickhouse_rollup_scheduler_status/);
});

test("scheduler repository는 singleton 행을 domain record로 매핑한다", async () => {
  const row = {
    singleton: true,
    last_heartbeat_at: new Date("2026-07-13T03:00:00.000Z"),
    last_selected_task: "timezone",
    last_task_started_at: new Date("2026-07-13T02:59:59.000Z"),
    last_task_finished_at: new Date("2026-07-13T03:00:00.000Z"),
    last_task_outcome: "success",
    last_error: null,
    updated_at: new Date("2026-07-13T03:00:00.000Z"),
  } as const;
  const pool = {
    async query() {
      return { rows: [row], rowCount: 1 };
    },
  } as unknown as Pool;

  const record = await new PgRollupCoordinatorRepository(pool).get();

  assert.deepEqual(record, {
    singleton: true,
    lastHeartbeatAt: row.last_heartbeat_at,
    lastSelectedTask: "timezone",
    lastTaskStartedAt: row.last_task_started_at,
    lastTaskFinishedAt: row.last_task_finished_at,
    lastTaskOutcome: "success",
    lastError: null,
    updatedAt: row.updated_at,
  });
});

test("scheduler 완료 기록은 오류를 sanitize하고 outcome을 저장한다", async () => {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const pool = {
    async query(sql: string, params?: unknown[]) {
      queries.push({ sql, params });
      return { rows: [], rowCount: 1 };
    },
  } as unknown as Pool;
  const repository = new PgRollupCoordinatorRepository(pool);
  const at = new Date("2026-07-13T03:00:00.000Z");

  await repository.recordFinished(
    "validation",
    "failed",
    at,
    "postgres://admin:secret@db/toard?token=value",
  );

  assert.match(queries[0]!.sql, /last_task_outcome = \$2/);
  assert.deepEqual(queries[0]!.params, [
    "validation",
    "failed",
    at,
    "postgres://[redacted]@db/toard?token=[redacted]",
  ]);
});
