import assert from "node:assert/strict";
import test from "node:test";
import type { RollupWorkerName, RollupWorkerRecord } from "./rollup-worker-state";
import type { RollupCutoverLayer, RollupCutoverRecord } from "./rollup-cutover-state";
import {
  deriveRollupProgress,
  getRollupAdminStatusWith,
  loadPostgresProgressWith,
  type RollupStatusDependencies,
  type RollupStorageStats,
} from "./rollup-status";

const NOW = new Date("2026-07-12T12:00:00.000Z");

function cutoverRecord(
  layer: RollupCutoverLayer,
  overrides: Partial<RollupCutoverRecord> = {},
): RollupCutoverRecord {
  return {
    layer,
    state: "backfilling",
    targetWatermark: null,
    healthySeconds: 0,
    lastCheckedAt: null,
    lastValidationAt: null,
    consecutiveFailures: 0,
    lastFailureKind: null,
    lastFailure: null,
    activatedAt: null,
    updatedAt: NOW,
    ...overrides,
  };
}

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
    adaptiveLimit: worker === "usage_15m_v2" ? 16 : 8,
    loadState: "normal",
    eligibleSince: null,
    nextAttemptAt: null,
    consecutiveFailures: 0,
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
    loadCutoverRecords: async () => [
      cutoverRecord("usage_15m_v2"),
      cutoverRecord("timezone"),
    ],
    loadSchedulerStatus: async () => ({
      singleton: true,
      lastHeartbeatAt: NOW,
      lastSelectedTask: "usage_15m_v2",
      lastTaskStartedAt: new Date(NOW.getTime() - 1_000),
      lastTaskFinishedAt: NOW,
      lastTaskOutcome: "success",
      lastError: null,
      updatedAt: NOW,
    }),
    loadTimezoneBacklog: async () => ({ eligible: 0, waitingForBase: 0 }),
    loadPostgresProgress: async () => ({
      watermark: new Date("2026-07-12T11:30:00.000Z"),
      dirtyBuckets: [],
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
    dirtyBuckets: [
      new Date("2026-07-01T00:00:00.000Z"),
      new Date("2026-07-01T00:15:00.000Z"),
      new Date("2026-07-01T00:30:00.000Z"),
      new Date("2026-07-01T00:45:00.000Z"),
    ],
    throughputPerMinute: 16,
    bucketMs: 15 * 60 * 1000,
  });

  assert.equal(view.progressPercent, 50);
  assert.equal(view.remainingUnits, 52);
  assert.equal(view.etaMinutes, 4);
  assert.equal(view.etaBasis, "recent");
});

test("4개 contiguous target 안의 dirty는 remaining에 중복 가산하지 않는다", () => {
  const view = deriveRollupProgress({
    targetFrom: new Date("2026-07-01T10:00:00.000Z"),
    targetTo: new Date("2026-07-01T11:00:00.000Z"),
    watermark: new Date("2026-07-01T10:00:00.000Z"),
    dirtyBuckets: [new Date("2026-07-01T10:15:00.000Z")],
    throughputPerMinute: 1,
    bucketMs: 15 * 60 * 1000,
  });

  assert.equal(view.totalUnits, 4);
  assert.equal(view.remainingUnits, 4);
  assert.equal(view.etaMinutes, 4);
});

test("watermark 이전 dirty는 고유 bucket만 remaining에 더한다", () => {
  const dirty = new Date("2026-07-01T10:00:00.000Z");
  const view = deriveRollupProgress({
    targetFrom: new Date("2026-07-01T10:00:00.000Z"),
    targetTo: new Date("2026-07-01T11:00:00.000Z"),
    watermark: new Date("2026-07-01T10:30:00.000Z"),
    dirtyBuckets: [
      dirty,
      new Date(dirty),
      new Date("2026-07-01T10:15:00.000Z"),
      new Date("2026-07-01T10:45:00.000Z"),
    ],
    throughputPerMinute: 1,
    bucketMs: 15 * 60 * 1000,
  });

  assert.equal(view.remainingUnits, 4);
});

test("target 범위 밖 최신·과거 dirty와 중복 dirty는 제외한다", () => {
  const inRange = new Date("2026-07-01T10:00:00.000Z");
  const view = deriveRollupProgress({
    targetFrom: new Date("2026-07-01T10:00:00.000Z"),
    targetTo: new Date("2026-07-01T11:00:00.000Z"),
    watermark: new Date("2026-07-01T11:00:00.000Z"),
    dirtyBuckets: [
      new Date("2026-07-01T09:45:00.000Z"),
      inRange,
      new Date(inRange),
      new Date("2026-07-01T11:00:00.000Z"),
      new Date("2026-07-01T11:15:00.000Z"),
    ],
    throughputPerMinute: 1,
    bucketMs: 15 * 60 * 1000,
  });

  assert.equal(view.remainingUnits, 1);
});

test("비정렬 watermark의 contiguous remaining은 compactor와 같은 floor 산식을 쓴다", () => {
  const targetFrom = new Date("2026-07-01T10:00:00.000Z");
  const targetTo = new Date("2026-07-01T11:00:00.000Z");
  const cases = [
    {
      name: "targetFrom 15분 이전",
      watermark: new Date("2026-07-01T09:45:00.000Z"),
      completedUnits: 0,
      remainingUnits: 4,
      progressPercent: 0,
      etaMinutes: 4,
    },
    {
      name: "target보다 훨씬 이전",
      watermark: new Date("2024-01-01T00:00:00.000Z"),
      completedUnits: 0,
      remainingUnits: 4,
      progressPercent: 0,
      etaMinutes: 4,
    },
    {
      name: "target 내부",
      watermark: new Date("2026-07-01T10:31:00.000Z"),
      completedUnits: 3,
      remainingUnits: 1,
      progressPercent: 75,
      etaMinutes: 1,
    },
    {
      name: "targetTo 직전",
      watermark: new Date("2026-07-01T10:59:00.000Z"),
      completedUnits: 4,
      remainingUnits: 0,
      progressPercent: 100,
      etaMinutes: 0,
    },
    {
      name: "target 범위 이후",
      watermark: new Date("2026-07-01T11:01:00.000Z"),
      completedUnits: 4,
      remainingUnits: 0,
      progressPercent: 100,
      etaMinutes: 0,
    },
  ];

  for (const expected of cases) {
    const view = deriveRollupProgress({
      targetFrom,
      targetTo,
      watermark: expected.watermark,
      dirtyBuckets: [],
      throughputPerMinute: 1,
      bucketMs: 15 * 60 * 1000,
    });

    assert.equal(view.totalUnits, 4, expected.name);
    const effectiveWatermarkMs = Math.min(
      targetTo.getTime(),
      Math.max(targetFrom.getTime(), expected.watermark.getTime()),
    );
    const compactorStyleRemaining = Math.max(
      0,
      Math.floor((targetTo.getTime() - effectiveWatermarkMs) / (15 * 60 * 1000)),
    );
    assert.equal(view.completedUnits, expected.completedUnits, expected.name);
    assert.equal(view.remainingUnits, expected.remainingUnits, expected.name);
    assert.equal(view.remainingUnits, compactorStyleRemaining, `${expected.name} compactor-style`);
    assert.equal(view.completedUnits + view.remainingUnits, view.totalUnits, expected.name);
    assert.equal(view.progressPercent, expected.progressPercent, expected.name);
    assert.equal(view.etaMinutes, expected.etaMinutes, expected.name);
  }
});

test("비정렬 watermark 뒤의 정렬 dirty는 exact 합집합 remaining과 ETA에 포함한다", () => {
  const view = deriveRollupProgress({
    targetFrom: new Date("2026-07-01T10:00:00.000Z"),
    targetTo: new Date("2026-07-01T11:00:00.000Z"),
    watermark: new Date("2026-07-01T10:31:00.000Z"),
    dirtyBuckets: [new Date("2026-07-01T10:45:00.000Z")],
    throughputPerMinute: 1,
    bucketMs: 15 * 60 * 1000,
  });

  assert.equal(view.remainingUnits, 2);
  assert.equal(view.etaMinutes, 2);
});

test("비정렬 contiguous와 dirty는 앞·뒤·중복·범위 밖을 exact timestamp로 합친다", () => {
  const duplicate = new Date("2026-07-01T10:45:00.000Z");
  const view = deriveRollupProgress({
    targetFrom: new Date("2026-07-01T10:00:00.000Z"),
    targetTo: new Date("2026-07-01T11:00:00.000Z"),
    watermark: new Date("2026-07-01T10:31:00.000Z"),
    dirtyBuckets: [
      new Date("2026-07-01T09:45:00.000Z"),
      new Date("2026-07-01T10:15:00.000Z"),
      new Date("2026-07-01T10:31:00.000Z"),
      duplicate,
      new Date(duplicate),
      new Date("2026-07-01T11:00:00.000Z"),
    ],
    throughputPerMinute: 1,
    bucketMs: 15 * 60 * 1000,
  });

  assert.equal(view.remainingUnits, 3);
  assert.equal(view.etaMinutes, 3);
});

test("ETA 표본이 없으면 worker별 configured 처리량을 사용한다", async () => {
  const status = await getRollupAdminStatusWith(dependencies({
    loadPostgresProgress: async () => ({
      watermark: new Date("2026-07-12T11:30:00.000Z"),
      dirtyBuckets: [],
      pending: 7,
      inflight: 1,
      activeTimezones: ["Asia/Seoul"],
      coverage: { hour: 10, day: 2 },
      postgresRawEvents: 3,
    }),
    loadTimezoneBacklog: async () => ({ eligible: 7, waitingForBase: 0 }),
  }));

  assert.equal(status.workers.usage15mV2.etaBasis, "configured");
  assert.equal(status.workers.usage15mV2.throughputUnitsPerMinute, 16);
  assert.equal(status.workers.timezone.etaBasis, "configured");
  assert.equal(status.workers.timezone.throughputUnitsPerMinute, 8);
  assert.equal(status.workers.timezone.remainingUnits, 8);
  assert.equal(status.workers.timezone.etaMinutes, 1);
});

test("status dirty 조회는 compactor와 같은 target 범위를 사용한다", async () => {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const targetFrom = new Date("2025-06-07T11:30:00.000Z");
  const targetTo = new Date("2026-07-12T11:30:00.000Z");
  const dirtyBucket = new Date("2026-07-12T11:15:00.000Z");
  const pool = {
    async query(sql: string, params: unknown[] = []) {
      queries.push({ sql, params });
      if (sql.includes("clickhouse_rollup_watermarks")) {
        return { rows: [{ watermark: targetTo }] };
      }
      if (sql.includes("clickhouse_rollup_dirty_buckets")) {
        return { rows: [{ bucket: dirtyBucket }] };
      }
      if (sql.includes("FROM raw_events")) {
        return { rows: [{ count: 0 }] };
      }
      return { rows: [] };
    },
  };

  const progress = await loadPostgresProgressWith(pool, targetFrom, targetTo);
  const dirtyQuery = queries.find(({ sql }) => sql.includes("clickhouse_rollup_dirty_buckets"));

  assert.ok(dirtyQuery);
  assert.match(dirtyQuery.sql, /bucket >= \$2/);
  assert.match(dirtyQuery.sql, /bucket < \$3/);
  assert.deepEqual(dirtyQuery.params, ["usage_15m_v2", targetFrom, targetTo]);
  assert.deepEqual(progress.dirtyBuckets, [dirtyBucket]);
});

test("worker ready·catching_up 상태는 dirty 합집합 remaining으로 파생한다", async () => {
  const targetTo = new Date("2026-07-12T11:30:00.000Z");
  const targetFrom = new Date(targetTo.getTime() - 400 * 24 * 60 * 60 * 1000);
  const ready = await getRollupAdminStatusWith(dependencies({
    loadWorkerRecords: async () => [
      workerRecord("usage_15m_v2", {
        lastSuccessAt: NOW,
        lastProgressAt: NOW,
      }),
      workerRecord("timezone"),
    ],
    loadPostgresProgress: async (from, to) => {
      assert.deepEqual([from, to], [targetFrom, targetTo]);
      return {
        watermark: targetTo,
        dirtyBuckets: [targetTo, new Date("2025-06-07T11:15:00.000Z")],
        pending: 0,
        inflight: 0,
        activeTimezones: [],
        coverage: { hour: 0, day: 0 },
        postgresRawEvents: 0,
      };
    },
  }));
  assert.equal(ready.workers.usage15mV2.remainingUnits, 0);
  assert.equal(ready.workers.usage15mV2.state, "ready");

  const catchingUp = await getRollupAdminStatusWith(dependencies({
    loadWorkerRecords: async () => [
      workerRecord("usage_15m_v2", {
        lastSuccessAt: NOW,
        lastProgressAt: NOW,
      }),
      workerRecord("timezone"),
    ],
    loadPostgresProgress: async () => ({
      watermark: targetTo,
      dirtyBuckets: [targetFrom],
      pending: 0,
      inflight: 0,
      activeTimezones: [],
      coverage: { hour: 0, day: 0 },
      postgresRawEvents: 0,
    }),
  }));
  assert.equal(catchingUp.workers.usage15mV2.remainingUnits, 1);
  assert.equal(catchingUp.workers.usage15mV2.state, "catching_up");
});

test("비정렬 watermark의 remaining은 ETA와 ready·catching_up·stalled 상태에 전달된다", async () => {
  const targetTo = new Date("2026-07-12T11:30:00.000Z");
  const statusFor = (watermark: Date, lastProgressAt: Date) =>
    getRollupAdminStatusWith(dependencies({
      loadWorkerRecords: async () => [
        workerRecord("usage_15m_v2", {
          lastSuccessAt: lastProgressAt,
          lastProgressAt,
          eligibleSince: lastProgressAt.getTime() < NOW.getTime() - 120_000
            ? lastProgressAt
            : null,
        }),
        workerRecord("timezone"),
      ],
      loadPostgresProgress: async () => ({
        watermark,
        dirtyBuckets: [],
        pending: 0,
        inflight: 0,
        activeTimezones: [],
        coverage: { hour: 0, day: 0 },
        postgresRawEvents: 0,
      }),
    }));

  const ready = await statusFor(
    new Date(targetTo.getTime() - 60 * 1000),
    NOW,
  );
  assert.equal(ready.workers.usage15mV2.remainingUnits, 0);
  assert.equal(ready.workers.usage15mV2.etaMinutes, 0);
  assert.equal(ready.workers.usage15mV2.state, "ready");

  const catchingUp = await statusFor(
    new Date(targetTo.getTime() - 16 * 60 * 1000),
    NOW,
  );
  assert.equal(catchingUp.workers.usage15mV2.remainingUnits, 1);
  assert.equal(catchingUp.workers.usage15mV2.etaMinutes, 1);
  assert.equal(catchingUp.workers.usage15mV2.state, "catching_up");

  const stalled = await statusFor(
    new Date(targetTo.getTime() - 16 * 60 * 1000),
    new Date(NOW.getTime() - 4 * 60 * 1000),
  );
  assert.equal(stalled.workers.usage15mV2.remainingUnits, 1);
  assert.equal(stalled.workers.usage15mV2.etaMinutes, 1);
  assert.equal(stalled.workers.usage15mV2.state, "stalled");
});

test("비정렬 watermark 뒤 dirty의 corrected remaining은 worker 상태와 ETA에 전달된다", async () => {
  const targetTo = new Date("2026-07-12T11:30:00.000Z");
  const status = await getRollupAdminStatusWith(dependencies({
    loadWorkerRecords: async () => [
      workerRecord("usage_15m_v2", {
        lastSuccessAt: NOW,
        lastProgressAt: NOW,
        throughputUnitsPerMinute: 1,
      }),
      workerRecord("timezone"),
    ],
    loadPostgresProgress: async () => ({
      watermark: new Date(targetTo.getTime() - 29 * 60 * 1000),
      dirtyBuckets: [new Date(targetTo.getTime() - 15 * 60 * 1000)],
      pending: 0,
      inflight: 0,
      activeTimezones: [],
      coverage: { hour: 0, day: 0 },
      postgresRawEvents: 0,
    }),
  }));

  assert.equal(status.workers.usage15mV2.remainingUnits, 2);
  assert.equal(status.workers.usage15mV2.etaMinutes, 2);
  assert.equal(status.workers.usage15mV2.state, "catching_up");
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

test("자동 전환 active 상태는 effective read source와 관찰 정보를 노출한다", async () => {
  const status = await getRollupAdminStatusWith(dependencies({
    loadCutoverRecords: async () => [
      cutoverRecord("usage_15m_v2", {
        state: "active",
        targetWatermark: new Date("2026-07-12T11:30:00.000Z"),
        healthySeconds: 3_600,
        lastValidationAt: NOW,
        activatedAt: NOW,
      }),
      cutoverRecord("timezone", {
        state: "observing",
        targetWatermark: new Date("2026-07-12T11:30:00.000Z"),
        healthySeconds: 1_200,
        lastValidationAt: NOW,
      }),
    ],
  }));

  assert.deepEqual(status.readSources, {
    usage15mV2: true,
    timezone: false,
  });
  assert.equal(status.cutover.mode, "auto");
  assert.equal(status.cutover.usage15mV2.state, "active");
  assert.equal(status.cutover.usage15mV2.healthySeconds, 3_600);
  assert.equal(status.cutover.timezone.state, "observing");
  assert.equal(status.workers.usage15mV2.adaptiveLimit, 16);
  assert.equal(status.workers.usage15mV2.loadState, "normal");
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

test("pending이 있지만 eligible이 없으면 waiting_for_base다", async () => {
  const status = await getRollupAdminStatusWith(dependencies({
    loadPostgresProgress: async () => ({
      watermark: new Date("2026-07-12T11:30:00.000Z"),
      dirtyBuckets: [],
      pending: 10,
      inflight: 0,
      activeTimezones: ["Asia/Seoul"],
      coverage: { hour: 4, day: 2 },
      postgresRawEvents: 0,
    }),
    loadTimezoneBacklog: async () => ({ eligible: 0, waitingForBase: 10 }),
  }));

  assert.equal(status.workers.timezone.state, "waiting_for_base");
  assert.equal(status.workers.timezone.eligiblePendingJobs, 0);
  assert.equal(status.workers.timezone.waitingForBaseJobs, 10);
  assert.equal(status.workers.timezone.etaMinutes, null);
});

test("eligible backlog와 오래된 eligibleSince가 있을 때만 stalled다", async () => {
  const eligibleSince = new Date(NOW.getTime() - 121_000);
  const status = await getRollupAdminStatusWith(dependencies({
    loadWorkerRecords: async () => [
      workerRecord("usage_15m_v2"),
      workerRecord("timezone", { eligibleSince }),
    ],
    loadPostgresProgress: async () => ({
      watermark: new Date("2026-07-12T11:30:00.000Z"),
      dirtyBuckets: [],
      pending: 3,
      inflight: 0,
      activeTimezones: ["Asia/Seoul"],
      coverage: { hour: 4, day: 2 },
      postgresRawEvents: 0,
    }),
    loadTimezoneBacklog: async () => ({ eligible: 3, waitingForBase: 0 }),
  }));

  assert.equal(status.workers.timezone.state, "stalled");
  assert.equal(status.workers.timezone.eligibleSince, eligibleSince.toISOString());
  assert.equal(status.workers.timezone.eligiblePendingJobs, 3);
  assert.equal(status.scheduler.lastSelectedTask, "usage_15m_v2");
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
