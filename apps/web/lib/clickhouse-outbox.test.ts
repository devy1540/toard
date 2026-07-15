import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type {
  RollupWorkerName,
  RollupWorkerRecord,
  RollupWorkerRepository,
} from "./rollup-worker-state";
import {
  getTimezoneRollupReadinessAt,
  nextAdaptiveLimit,
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
    adaptiveLimit: worker === "usage_15m_v2" ? 16 : 8,
    loadState: "normal",
    eligibleSince: null,
    nextAttemptAt: null,
    consecutiveFailures: 0,
  });
  return {
    get: async (worker) => record(worker),
    setPaused: async (worker, paused) => record(worker, paused),
    setEligibility: async () => undefined,
    markStarted: async () => undefined,
    markSucceeded: async () => undefined,
    markFailed: async () => undefined,
    setAdaptiveState: async () => undefined,
    withLoadSlot: async (operation) => ({ acquired: true, value: await operation() }),
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

test("adaptive batch는 빠른 full batch만 늘리고 느리거나 실패하면 절반으로 줄인다", () => {
  assert.equal(nextAdaptiveLimit({
    limit: 16,
    processed: 16,
    durationMs: 1_000,
    failed: false,
    minimum: 1,
    maximum: 64,
  }), 20);
  assert.equal(nextAdaptiveLimit({
    limit: 20,
    processed: 20,
    durationMs: 12_000,
    failed: false,
    minimum: 1,
    maximum: 64,
  }), 10);
  assert.equal(nextAdaptiveLimit({
    limit: 8,
    processed: 0,
    durationMs: 100,
    failed: false,
    minimum: 1,
    maximum: 32,
  }), 8);
  assert.equal(nextAdaptiveLimit({
    limit: 1,
    processed: 0,
    durationMs: 100,
    failed: true,
    minimum: 1,
    maximum: 32,
  }), 1);
});

test("shared load slot을 얻지 못하면 compactor를 실행하지 않는다", async () => {
  const repository = fakeWorkerRepository({ paused: false });
  repository.withLoadSlot = async () => ({ acquired: false });
  let calls = 0;

  const result = await runObservedWorkerTick({
    worker: "usage_15m_v2",
    hardEnabled: true,
    repository,
    run: async () => {
      calls++;
      return { units: 1, rows: 1 };
    },
    now: () => new Date("2026-07-12T12:00:00.000Z"),
  });

  assert.equal(result, "busy");
  assert.equal(calls, 0);
});

test("observed worker는 저장된 adaptive 한도를 compactor에 전달하고 다음 한도를 저장한다", async () => {
  const repository = fakeWorkerRepository({ paused: false });
  let requestedLimit = 0;
  let saved: { limit: number; loadState: string } | null = null;
  repository.setAdaptiveState = async (_worker, limit, loadState) => {
    saved = { limit, loadState };
  };
  let tick = 0;
  const times = [
    new Date("2026-07-12T12:00:00.000Z"),
    new Date("2026-07-12T12:00:01.000Z"),
  ];

  const result = await runObservedWorkerTick({
    worker: "usage_15m_v2",
    hardEnabled: true,
    repository,
    run: async (limit) => {
      requestedLimit = limit;
      return { units: limit, rows: 10 };
    },
    now: () => times[Math.min(tick++, times.length - 1)]!,
  });

  assert.equal(result, "completed");
  assert.equal(requestedLimit, 16);
  assert.deepEqual(saved, { limit: 20, loadState: "normal" });
});

test("운영자가 설정한 최대 batch는 저장된 adaptive 한도보다 우선한다", async () => {
  const repository = fakeWorkerRepository({ paused: false });
  let requestedLimit = 0;
  let savedLimit = 0;
  repository.setAdaptiveState = async (_worker, limit) => {
    savedLimit = limit;
  };

  await runObservedWorkerTick({
    worker: "usage_15m_v2",
    hardEnabled: true,
    repository,
    maximumLimit: 12,
    run: async (limit) => {
      requestedLimit = limit;
      return { units: limit, rows: 10 };
    },
    now: () => new Date("2026-07-12T12:00:00.000Z"),
  });

  assert.equal(requestedLimit, 12);
  assert.equal(savedLimit, 12);
});

function readyPool(watermark: Date, pendingJobs = 0, runtimeState: "active" | "fallback" = "fallback") {
  return {
    query: async (sql: string) => {
      if (sql.includes("clickhouse_rollup_cutover_status")) {
        return { rows: [{ state: runtimeState }] };
      }
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

test("readiness는 미설정 환경변수에서 active runtime 자동 전환을 반영한다", async () => {
  const readiness = await getTimezoneRollupReadinessAt(
    readyPool(new Date("2026-07-10T23:30:00.000Z"), 0, "active"),
    {},
    new Date("2026-07-11T00:00:00.000Z"),
  );

  assert.equal(readiness.status, "healthy");
  assert.equal(readiness.watermark, "2026-07-10T23:30:00.000Z");
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

test("서버 instrumentation은 rollup coordinator 하나만 시작한다", () => {
  const instrumentation = readFileSync(
    new URL("../instrumentation.ts", import.meta.url),
    "utf8",
  );
  const outbox = readFileSync(new URL("./clickhouse-outbox.ts", import.meta.url), "utf8");

  assert.match(instrumentation, /startRollupCoordinator/);
  assert.equal(instrumentation.match(/startRollupCoordinator\(\)/g)?.length, 1);
  assert.doesNotMatch(instrumentation, /startClickHouse15mV2Compaction\(\)/);
  assert.doesNotMatch(instrumentation, /startClickHouseTimezoneRollupCompaction\(\)/);
  assert.doesNotMatch(instrumentation, /startClickHouseRollupCutover\(\)/);
  assert.match(outbox, /export function startClickHouseRollupCutover/);
  assert.match(outbox, /advanceRollupCutover/);
});
