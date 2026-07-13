import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { Pool } from "pg";
import {
  PgRollupWorkerRepository,
  deriveWorkerState,
  sanitizeRollupError,
  shadowWorkerEnabled,
} from "./rollup-worker-state";

type Query = { sql: string; params?: unknown[] };
type Response = { rows: Array<Record<string, unknown>>; rowCount?: number | null };

function createPool(responses: Response[] = []) {
  const queries: Query[] = [];
  const pool = {
    async query(sql: string, params?: unknown[]) {
      queries.push({ sql, params });
      return responses.shift() ?? { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  return { pool, queries };
}

const workerRow = {
  worker: "usage_15m_v2",
  paused: false,
  activated_at: new Date("2026-07-12T11:50:00.000Z"),
  last_started_at: new Date("2026-07-12T11:59:00.000Z"),
  last_finished_at: new Date("2026-07-12T12:00:00.000Z"),
  last_success_at: new Date("2026-07-12T12:00:00.000Z"),
  last_progress_at: new Date("2026-07-12T12:00:00.000Z"),
  last_error_at: null,
  last_error: null,
  last_duration_ms: "60000",
  last_processed_units: 4,
  last_processed_rows: "120",
  processed_units_total: "40",
  processed_rows_total: "1200",
  throughput_units_per_minute: 3.5,
  adaptive_limit: 16,
  load_state: "normal",
};

test("shadow worker는 미설정이면 켜지고 명시적 false면 hard disable된다", () => {
  assert.equal(shadowWorkerEnabled({}, "CLICKHOUSE_15M_V2_COMPACTOR"), true);
  assert.equal(shadowWorkerEnabled({ CLICKHOUSE_15M_V2_COMPACTOR: "" }, "CLICKHOUSE_15M_V2_COMPACTOR"), true);
  for (const value of ["0", "false", "off", "FALSE"]) {
    assert.equal(shadowWorkerEnabled({ CLICKHOUSE_15M_V2_COMPACTOR: value }, "CLICKHOUSE_15M_V2_COMPACTOR"), false);
  }
});

test("pause와 최근 진행 시각으로 운영 상태를 파생한다", () => {
  const now = new Date("2026-07-12T12:00:00.000Z");
  const activatedAt = new Date("2026-07-12T11:50:00.000Z");
  assert.equal(deriveWorkerState({ hardDisabled: false, paused: true, remaining: 4, activatedAt, now }), "paused");
  assert.equal(deriveWorkerState({ hardDisabled: false, paused: false, remaining: 0, activatedAt, now }), "ready");
  assert.equal(deriveWorkerState({
    hardDisabled: false,
    paused: false,
    remaining: 4,
    activatedAt,
    lastProgressAt: new Date("2026-07-12T11:55:00.000Z"),
    now,
  }), "stalled");
});

test("disabled와 최신 오류가 진행 상태보다 우선하고 성공 뒤에는 복구한다", () => {
  const now = new Date("2026-07-12T12:00:00.000Z");
  const activatedAt = new Date("2026-07-12T11:50:00.000Z");
  assert.equal(deriveWorkerState({ hardDisabled: true, paused: true, remaining: 2, activatedAt, now }), "disabled");
  assert.equal(deriveWorkerState({
    hardDisabled: false,
    paused: false,
    remaining: 2,
    activatedAt,
    lastSuccessAt: new Date("2026-07-12T11:50:00.000Z"),
    lastErrorAt: new Date("2026-07-12T11:55:00.000Z"),
    now,
  }), "error");
  assert.equal(deriveWorkerState({
    hardDisabled: false,
    paused: false,
    remaining: 2,
    activatedAt,
    lastSuccessAt: new Date("2026-07-12T11:59:00.000Z"),
    lastErrorAt: new Date("2026-07-12T11:55:00.000Z"),
    lastProgressAt: new Date("2026-07-12T11:59:00.000Z"),
    now,
  }), "catching_up");
});

test("성공 전 worker는 시작 유예 뒤 stalled로 바뀐다", () => {
  const now = new Date("2026-07-12T12:00:00.000Z");
  assert.equal(deriveWorkerState({
    hardDisabled: false,
    paused: false,
    remaining: 2,
    activatedAt: new Date("2026-07-12T11:50:00.000Z"),
    lastStartedAt: new Date("2026-07-12T11:59:00.000Z"),
    now,
  }), "starting");
  assert.equal(deriveWorkerState({
    hardDisabled: false,
    paused: false,
    remaining: 2,
    activatedAt: new Date("2026-07-12T11:50:00.000Z"),
    lastStartedAt: new Date("2026-07-12T11:55:00.000Z"),
    now,
  }), "stalled");
});

test("시작 기록이 없는 활성 worker는 정확히 3분까지 starting이고 이후 stalled다", () => {
  const activatedAt = new Date("2026-07-12T11:57:00.000Z");

  assert.equal(deriveWorkerState({
    hardDisabled: false,
    paused: false,
    remaining: 2,
    activatedAt,
    lastStartedAt: null,
    now: new Date("2026-07-12T12:00:00.000Z"),
  }), "starting");
  assert.equal(deriveWorkerState({
    hardDisabled: false,
    paused: false,
    remaining: 2,
    activatedAt,
    lastStartedAt: null,
    now: new Date("2026-07-12T12:00:00.001Z"),
  }), "stalled");
});

test("rollup 오류에서 URL 자격증명과 민감 query 값을 제거하고 길이를 제한한다", () => {
  const sanitized = sanitizeRollupError(
    `connect postgres://admin:top-secret@db/toard?password=hunter2&token=abc secret=xyz ${"x".repeat(600)}`,
  );
  assert.doesNotMatch(sanitized, /top-secret|hunter2|abc|xyz/);
  assert.match(sanitized, /postgres:\/\/\[redacted\]@/);
  assert.match(sanitized, /password=\[redacted\]/);
  assert.equal(sanitized.length, 500);
});

test("migration은 worker 상태와 누적 관측 필드를 만들고 두 worker를 seed한다", async () => {
  const migration = await readFile(
    new URL("../../../migrations/1700000024_clickhouse_rollup_worker_status.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /CREATE TABLE clickhouse_rollup_worker_status/);
  assert.match(migration, /worker IN \('usage_15m_v2', 'timezone'\)/);
  assert.match(migration, /activated_at TIMESTAMPTZ NOT NULL DEFAULT now\(\)/);
  assert.match(migration, /processed_units_total BIGINT NOT NULL DEFAULT 0/);
  assert.match(migration, /throughput_units_per_minute DOUBLE PRECISION/);
  assert.match(migration, /VALUES \('usage_15m_v2'\), \('timezone'\)/);
  assert.match(migration, /-- Down Migration[\s\S]*DROP TABLE clickhouse_rollup_worker_status/);
});

test("repository get은 PostgreSQL snake case와 bigint를 domain record로 매핑한다", async () => {
  const fixture = createPool([{ rows: [workerRow], rowCount: 1 }]);
  const repository = new PgRollupWorkerRepository(fixture.pool);

  const record = await repository.get("usage_15m_v2");

  assert.deepEqual(record, {
    worker: "usage_15m_v2",
    paused: false,
    activatedAt: workerRow.activated_at,
    lastStartedAt: workerRow.last_started_at,
    lastFinishedAt: workerRow.last_finished_at,
    lastSuccessAt: workerRow.last_success_at,
    lastProgressAt: workerRow.last_progress_at,
    lastErrorAt: null,
    lastError: null,
    lastDurationMs: 60000,
    lastProcessedUnits: 4,
    lastProcessedRows: 120,
    processedUnitsTotal: 40,
    processedRowsTotal: 1200,
    throughputUnitsPerMinute: 3.5,
    adaptiveLimit: 16,
    loadState: "normal",
  });
  assert.deepEqual(fixture.queries[0]?.params, ["usage_15m_v2"]);
});

test("repository pause는 영구 상태를 갱신하고 갱신된 record를 반환한다", async () => {
  const fixture = createPool([{ rows: [{ ...workerRow, paused: true }], rowCount: 1 }]);
  const repository = new PgRollupWorkerRepository(fixture.pool);

  const record = await repository.setPaused("usage_15m_v2", true);

  assert.equal(record.paused, true);
  assert.match(fixture.queries[0]!.sql, /UPDATE clickhouse_rollup_worker_status/);
  assert.match(fixture.queries[0]!.sql, /RETURNING/);
  assert.deepEqual(fixture.queries[0]!.params, ["usage_15m_v2", true]);
});

test("repository 성공 기록은 누적값을 원자 증가시키고 최소 1분 sample로 EMA를 갱신한다", async () => {
  const fixture = createPool();
  const repository = new PgRollupWorkerRepository(fixture.pool);
  const startedAt = new Date("2026-07-12T12:00:00.000Z");
  const finishedAt = new Date("2026-07-12T12:00:10.000Z");

  await repository.markSucceeded("timezone", startedAt, finishedAt, { units: 8, rows: 120 });

  const query = fixture.queries[0]!;
  assert.match(query.sql, /processed_units_total \+ \$4/);
  assert.match(query.sql, /processed_rows_total \+ \$5/);
  assert.match(query.sql, /throughput_units_per_minute \* 0\.7/);
  assert.match(query.sql, /WHEN throughput_units_per_minute IS NULL THEN \$6::double precision/);
  assert.match(query.sql, /\$6::double precision \* 0\.3/);
  assert.deepEqual(query.params, ["timezone", startedAt, finishedAt, 8, 120, 8, 10000]);
});

test("처리 단위가 없는 idle 성공은 기존 처리량 EMA를 낮추지 않는다", async () => {
  const fixture = createPool();
  const repository = new PgRollupWorkerRepository(fixture.pool);

  await repository.markSucceeded(
    "timezone",
    new Date("2026-07-12T12:00:00.000Z"),
    new Date("2026-07-12T12:01:00.000Z"),
    { units: 0, rows: 0 },
  );

  assert.match(
    fixture.queries[0]!.sql,
    /WHEN \$4 <= 0 THEN throughput_units_per_minute/,
  );
});

test("repository 실패 기록도 오류를 다시 sanitize한다", async () => {
  const fixture = createPool();
  const repository = new PgRollupWorkerRepository(fixture.pool);
  const startedAt = new Date("2026-07-12T12:00:00.000Z");
  const finishedAt = new Date("2026-07-12T12:00:05.000Z");

  await repository.markFailed(
    "usage_15m_v2",
    startedAt,
    finishedAt,
    "postgres://admin:secret@db/toard?token=value",
  );

  assert.match(fixture.queries[0]!.sql, /last_error_at/);
  assert.deepEqual(fixture.queries[0]!.params, [
    "usage_15m_v2",
    startedAt,
    finishedAt,
    "postgres://[redacted]@db/toard?token=[redacted]",
    5000,
  ]);
});

test("repository는 adaptive 한도와 부하 상태를 함께 저장한다", async () => {
  const fixture = createPool();
  const repository = new PgRollupWorkerRepository(fixture.pool);

  await repository.setAdaptiveState("timezone", 4, "throttled");

  assert.match(fixture.queries[0]!.sql, /adaptive_limit = \$2, load_state = \$3/);
  assert.deepEqual(fixture.queries[0]!.params, ["timezone", 4, "throttled"]);
});

test("repository shared load slot은 lock을 얻은 실행만 허용하고 반드시 해제한다", async () => {
  const queries: Query[] = [];
  let released = 0;
  const client = {
    async query(sql: string, params?: unknown[]) {
      queries.push({ sql, params });
      return { rows: sql.includes("pg_try_advisory_lock") ? [{ locked: true }] : [] };
    },
    release() {
      released++;
    },
  };
  const pool = {
    async connect() {
      return client;
    },
  } as unknown as Pool;
  const repository = new PgRollupWorkerRepository(pool);

  const result = await repository.withLoadSlot(async () => "completed");

  assert.deepEqual(result, { acquired: true, value: "completed" });
  assert.match(queries[0]!.sql, /pg_try_advisory_lock/);
  assert.match(queries[1]!.sql, /pg_advisory_unlock/);
  assert.equal(released, 1);
});
