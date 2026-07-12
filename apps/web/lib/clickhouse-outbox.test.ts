import assert from "node:assert/strict";
import test from "node:test";
import type {
  RollupWorkerName,
  RollupWorkerRecord,
  RollupWorkerRepository,
} from "./rollup-worker-state";
import {
  getTimezoneRollupReadinessAt,
  runObservedWorkerTick,
  toTimezoneRollupReadyPayload,
} from "./clickhouse-outbox";

function fakeWorkerRepository(seed: { paused: boolean }): RollupWorkerRepository {
  const record = (worker: RollupWorkerName, paused = seed.paused): RollupWorkerRecord => ({
    worker,
    paused,
    activatedAt: new Date("2026-07-12T11:50:00.000Z"),
    lastStartedAt: null,
    lastFinishedAt: null,
    lastSuccessAt: null,
    lastProgressAt: null,
    lastErrorAt: null,
    lastError: null,
    lastDurationMs: null,
    lastProcessedUnits: 0,
    lastProcessedRows: 0,
    processedUnitsTotal: 0,
    processedRowsTotal: 0,
    throughputUnitsPerMinute: null,
  });
  return {
    get: async (worker) => record(worker),
    setPaused: async (worker, paused) => record(worker, paused),
    markStarted: async () => undefined,
    markSucceeded: async () => undefined,
    markFailed: async () => undefined,
  };
}

test("paused 15분 worker는 compactor를 호출하지 않는다", async () => {
  let calls = 0;
  const result = await runObservedWorkerTick({
    worker: "usage_15m_v2",
    hardEnabled: true,
    repository: fakeWorkerRepository({ paused: true }),
    run: async () => {
      calls++;
      return { units: 1, rows: 10 };
    },
    now: () => new Date("2026-07-12T12:00:00.000Z"),
  });

  assert.equal(result, "paused");
  assert.equal(calls, 0);
});

test("pause 조회 실패는 fail-closed로 compactor를 실행하지 않는다", async () => {
  let calls = 0;
  const repository = fakeWorkerRepository({ paused: false });
  repository.get = async () => {
    throw new Error("pause storage unavailable");
  };

  await assert.rejects(
    runObservedWorkerTick({
      worker: "timezone",
      hardEnabled: true,
      repository,
      run: async () => {
        calls++;
        return { units: 1, rows: 10 };
      },
      now: () => new Date("2026-07-12T12:00:00.000Z"),
    }),
    /pause storage unavailable/,
  );
  assert.equal(calls, 0);
});

test("관측 write 실패는 성공한 compactor 결과를 덮어쓰지 않는다", async () => {
  const repository = fakeWorkerRepository({ paused: false });
  repository.markStarted = async () => {
    throw new Error("start observation unavailable");
  };
  repository.markSucceeded = async () => {
    throw new Error("success observation unavailable");
  };
  const originalWarn = console.warn;
  const warnings: unknown[] = [];
  console.warn = (...args: unknown[]) => warnings.push(args);
  try {
    const result = await runObservedWorkerTick({
      worker: "usage_15m_v2",
      hardEnabled: true,
      repository,
      run: async () => ({ units: 1, rows: 10 }),
      now: () => new Date("2026-07-12T12:00:00.000Z"),
    });
    assert.equal(result, "completed");
    assert.equal(warnings.length, 2);
  } finally {
    console.warn = originalWarn;
  }
});

test("compactor 실패는 정제된 오류를 기록하고 failed로 반환한다", async () => {
  const repository = fakeWorkerRepository({ paused: false });
  let recordedError = "";
  repository.markFailed = async (_worker, _startedAt, _finishedAt, error) => {
    recordedError = error;
  };

  const result = await runObservedWorkerTick({
    worker: "timezone",
    hardEnabled: true,
    repository,
    run: async () => {
      throw new Error("https://admin:pw@example.test?token=abc");
    },
    now: () => new Date("2026-07-12T12:00:00.000Z"),
  });

  assert.equal(result, "failed");
  assert.doesNotMatch(recordedError, /admin:pw|token=abc/);
  assert.match(recordedError, /\[redacted\]/);
});

function readyPool(watermark: Date, pendingJobs = 0) {
  return {
    query: async (sql: string) => {
      if (sql.includes("clickhouse_rollup_watermarks")) {
        return { rows: [{ watermark }] };
      }
      if (sql.includes("clickhouse_timezone_rollup_jobs")) {
        return { rows: [{ pending_jobs: pendingJobs }] };
      }
      return { rows: [] };
    },
  };
}

test("legacy flag가 남아 있으면 ready는 HTTP 차단 대신 fallback migration 상태를 노출한다", async () => {
  const originalWarn = console.warn;
  console.warn = () => undefined;
  const now = new Date("2026-07-11T00:00:00.000Z");
  const readiness = await getTimezoneRollupReadinessAt(
    readyPool(new Date("2026-07-10T23:30:00.000Z")),
    { CLICKHOUSE_READ_ROLLUP: "1" },
    now,
  ).finally(() => {
    console.warn = originalWarn;
  });

  assert.deepEqual(readiness, {
    status: "fallback",
    watermark: "2026-07-10T23:30:00.000Z",
    lagSeconds: 0,
    pendingJobs: 0,
    legacyFlagMigration: "deprecated_alias",
  });
  assert.deepEqual(toTimezoneRollupReadyPayload(readiness), {
    timezone: "fallback",
    timezoneWatermark: "2026-07-10T23:30:00.000Z",
    timezoneLagSeconds: 0,
    timezonePendingJobs: 0,
    legacyFlagMigration: "deprecated_alias",
  });
});

test("새 flag가 명시되면 legacy alias보다 우선하되 남은 legacy 값은 migration 상태로 보인다", async () => {
  const readiness = await getTimezoneRollupReadinessAt(
    readyPool(new Date("2026-07-10T23:30:00.000Z")),
    {
      CLICKHOUSE_READ_ROLLUP: "1",
      CLICKHOUSE_READ_TIMEZONE_ROLLUP: "0",
    },
    new Date("2026-07-11T00:00:00.000Z"),
  );

  assert.equal(readiness.status, "fallback");
  assert.equal(readiness.watermark, null);
  assert.equal(readiness.legacyFlagMigration, "deprecated_alias");
});
