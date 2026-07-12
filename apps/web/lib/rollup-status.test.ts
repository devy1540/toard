import assert from "node:assert/strict";
import test from "node:test";
import type { RollupWorkerName, RollupWorkerRecord } from "./rollup-worker-state";
import {
  deriveRollupProgress,
  getRollupAdminStatusWith,
  type RollupStatusDependencies,
  type RollupStorageStats,
} from "./rollup-status";

const NOW = new Date("2026-07-12T12:00:00.000Z");

function workerRecord(
  worker: RollupWorkerName,
  overrides: Partial<RollupWorkerRecord> = {},
): RollupWorkerRecord {
  return {
    worker,
    paused: false,
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
    ...overrides,
  };
}

function storageStats(collectedAt = NOW.toISOString()): RollupStorageStats {
  return {
    collectedAt,
    rawRange: { from: null, to: null },
    tables: {
      raw_events: { rows: 0, bytes: 0 },
      usage_events: { rows: 0, bytes: 0 },
      usage_hourly_rollup: { rows: 0, bytes: 0 },
      usage_15m_rollup_v2: { rows: 0, bytes: 0 },
      usage_hourly_timezone_rollup: { rows: 0, bytes: 0 },
      usage_daily_timezone_rollup: { rows: 0, bytes: 0 },
    },
  };
}

function dependencies(
  overrides: Partial<RollupStatusDependencies> = {},
): RollupStatusDependencies {
  return {
    env: { STORAGE_BACKEND: "clickhouse" },
    now: () => NOW,
    loadWorkerRecords: async () => [
      workerRecord("usage_15m_v2"),
      workerRecord("timezone"),
    ],
    loadPostgresProgress: async () => ({
      watermark: new Date("2026-07-12T11:30:00.000Z"),
      dirty: 0,
      pending: 0,
      inflight: 0,
      activeTimezones: [],
      coverage: { hour: 0, day: 0 },
      postgresRawEvents: 0,
    }),
    loadStorageStats: async () => storageStats(),
    ...overrides,
  };
}

test("15분 진행률과 ETA는 watermark·dirty·최근 속도로 계산한다", () => {
  const view = deriveRollupProgress({
    targetFrom: new Date("2026-07-01T00:00:00.000Z"),
    targetTo: new Date("2026-07-02T00:00:00.000Z"),
    watermark: new Date("2026-07-01T12:00:00.000Z"),
    dirty: 4,
    throughputPerMinute: 16,
    bucketMs: 15 * 60 * 1000,
  });

  assert.equal(view.progressPercent, 50);
  assert.equal(view.remainingUnits, 52);
  assert.equal(view.etaMinutes, 4);
  assert.equal(view.etaBasis, "recent");
});

test("ETA 표본이 없으면 worker별 configured 처리량을 사용한다", async () => {
  const status = await getRollupAdminStatusWith(dependencies({
    loadPostgresProgress: async () => ({
      watermark: new Date("2026-07-12T11:30:00.000Z"),
      dirty: 0,
      pending: 7,
      inflight: 1,
      activeTimezones: ["Asia/Seoul"],
      coverage: { hour: 10, day: 2 },
      postgresRawEvents: 3,
    }),
  }));

  assert.equal(status.workers.usage15mV2.etaBasis, "configured");
  assert.equal(status.workers.usage15mV2.throughputUnitsPerMinute, 16);
  assert.equal(status.workers.timezone.etaBasis, "configured");
  assert.equal(status.workers.timezone.throughputUnitsPerMinute, 8);
  assert.equal(status.workers.timezone.remainingUnits, 8);
  assert.equal(status.workers.timezone.etaMinutes, 1);
});

test("ClickHouse 규모 조회 실패는 worker 제어 상태를 유지한 degraded 응답이 된다", async () => {
  const status = await getRollupAdminStatusWith(dependencies({
    loadStorageStats: async () => {
      throw new Error("timeout");
    },
  }));

  assert.equal(status.degraded, true);
  assert.equal(status.workers.usage15mV2.paused, false);
  assert.equal(status.workers.usage15mV2.controlAvailable, true);
  assert.equal(status.storage, null);
});

test("Postgres 진행률 조회 실패도 pause 상태를 유지하고 ETA를 추측하지 않는다", async () => {
  const status = await getRollupAdminStatusWith(dependencies({
    loadWorkerRecords: async () => [
      workerRecord("usage_15m_v2", { paused: true }),
      workerRecord("timezone"),
    ],
    loadPostgresProgress: async () => {
      throw new Error("progress unavailable");
    },
  }));

  assert.equal(status.degraded, true);
  assert.equal(status.workers.usage15mV2.state, "paused");
  assert.equal(status.workers.usage15mV2.paused, true);
  assert.equal(status.workers.usage15mV2.etaMinutes, null);
  assert.equal(status.workers.usage15mV2.etaBasis, null);
  assert.equal(status.workers.timezone.remainingUnits, 1);
  assert.equal(status.workers.timezone.etaMinutes, null);
});

test("read flags와 normalized raw TTL은 명시 opt-in이 없으면 OFF다", async () => {
  const status = await getRollupAdminStatusWith(dependencies({ env: {} }));

  assert.deepEqual(status.readSources, {
    usage15mV2: false,
    timezone: false,
  });
  assert.deepEqual(status.normalizedRawTtl, {
    enabled: false,
    days: 97,
  });
  assert.equal(status.workers.usage15mV2.state, "not_applicable");
  assert.equal(status.workers.timezone.state, "not_applicable");
});

test("worker 상태는 disabled와 paused를 오류·ready보다 우선한다", async () => {
  const failedAt = new Date("2026-07-12T11:59:00.000Z");
  const status = await getRollupAdminStatusWith(dependencies({
    env: {
      STORAGE_BACKEND: "clickhouse",
      CLICKHOUSE_15M_V2_COMPACTOR: "off",
    },
    loadWorkerRecords: async () => [
      workerRecord("usage_15m_v2", {
        paused: true,
        lastErrorAt: failedAt,
        lastError: "failure",
      }),
      workerRecord("timezone", {
        paused: true,
        lastErrorAt: failedAt,
        lastError: "failure",
      }),
    ],
  }));

  assert.equal(status.workers.usage15mV2.state, "disabled");
  assert.equal(status.workers.timezone.state, "paused");
});

test("성공한 storage snapshot만 30초 cache하고 실패는 cache하지 않는다", async () => {
  let now = NOW;
  let successCalls = 0;
  const loadSuccess = async () => {
    successCalls++;
    return storageStats(`2026-07-12T12:00:0${successCalls}.000Z`);
  };
  const deps = dependencies({ now: () => now, loadStorageStats: loadSuccess });

  await getRollupAdminStatusWith(deps);
  now = new Date(NOW.getTime() + 29_000);
  await getRollupAdminStatusWith(deps);
  assert.equal(successCalls, 1);

  now = new Date(NOW.getTime() + 31_000);
  await getRollupAdminStatusWith(deps);
  assert.equal(successCalls, 2);

  let retryCalls = 0;
  const loadAfterFailure = async () => {
    retryCalls++;
    if (retryCalls === 1) throw new Error("temporary");
    return storageStats();
  };
  const retryDeps = dependencies({ loadStorageStats: loadAfterFailure });
  const failed = await getRollupAdminStatusWith(retryDeps);
  const retried = await getRollupAdminStatusWith(retryDeps);
  assert.equal(failed.storage, null);
  assert.notEqual(retried.storage, null);
  assert.equal(retryCalls, 2);
});

test("동시 storage snapshot 요청은 한 번의 조회를 공유한다", async () => {
  let calls = 0;
  let resolveSnapshot!: (value: RollupStorageStats) => void;
  const pending = new Promise<RollupStorageStats>((resolve) => {
    resolveSnapshot = resolve;
  });
  const loadStorageStats = () => {
    calls++;
    return pending;
  };
  const deps = dependencies({ loadStorageStats });

  const first = getRollupAdminStatusWith(deps);
  const second = getRollupAdminStatusWith(deps);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);

  resolveSnapshot(storageStats());
  const [firstStatus, secondStatus] = await Promise.all([first, second]);
  assert.deepEqual(firstStatus.storage, secondStatus.storage);
});

test("admin DTO는 worker 원문 오류의 secret·SQL·stack·사용자 payload를 노출하지 않는다", async () => {
  const status = await getRollupAdminStatusWith(dependencies({
    loadWorkerRecords: async () => [
      workerRecord("usage_15m_v2", {
        lastErrorAt: new Date("2026-07-12T11:59:00.000Z"),
        lastError: "password=hunter2 SELECT * FROM users\nError stack\nuser raw email=a@example.com",
      }),
      workerRecord("timezone"),
    ],
  }));
  const dto = JSON.stringify(status);

  assert.doesNotMatch(dto, /hunter2|SELECT \*|Error stack|a@example\.com|user raw/);
  assert.equal(status.workers.usage15mV2.lastError, "Rollup worker execution failed");
});
