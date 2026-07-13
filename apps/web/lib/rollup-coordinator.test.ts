import assert from "node:assert/strict";
import test from "node:test";
import {
  coordinatorEligible,
  runRollupCoordinatorTickWith,
  selectRollupTask,
  type RollupCoordinatorCandidate,
  type RollupCoordinatorDependencies,
} from "./rollup-coordinator";
import type { RollupSchedulerTask } from "./rollup-coordinator-state";
import type { RollupWorkerName, RollupWorkerRecord } from "./rollup-worker-state";

const START = new Date("2026-07-13T03:00:00.000Z");

test("coordinator는 가격 자동 복구 또는 ClickHouse worker가 필요한 환경에서만 시작한다", () => {
  assert.equal(coordinatorEligible({ NODE_ENV: "production", STORAGE_BACKEND: "postgres" }), true);
  assert.equal(coordinatorEligible({ NODE_ENV: "development", STORAGE_BACKEND: "postgres" }), false);
  assert.equal(coordinatorEligible({ NODE_ENV: "development", STORAGE_BACKEND: "clickhouse" }), true);
  assert.equal(coordinatorEligible({
    NODE_ENV: "development",
    STORAGE_BACKEND: "clickhouse",
    CLICKHOUSE_15M_V2_COMPACTOR: "off",
    CLICKHOUSE_TIMEZONE_ROLLUP_COMPACTOR: "off",
  }), false);
  assert.equal(coordinatorEligible({
    NODE_ENV: "development",
    STORAGE_BACKEND: "clickhouse",
    CLICKHOUSE_15M_V2_COMPACTOR: "off",
    CLICKHOUSE_TIMEZONE_ROLLUP_COMPACTOR: "on",
  }), true);
});

function candidate(
  task: RollupCoordinatorCandidate["task"],
  overrides: Partial<RollupCoordinatorCandidate> = {},
): RollupCoordinatorCandidate {
  return {
    task,
    due: true,
    eligibleSince: START,
    lastStartedAt: null,
    nextAttemptAt: null,
    ...overrides,
  };
}

function worker(worker: RollupWorkerName): RollupWorkerRecord {
  return {
    worker,
    paused: false,
    activatedAt: START,
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
    eligibleSince: START,
    nextAttemptAt: null,
    consecutiveFailures: 0,
  };
}

test("15분 worker가 먼저 등록돼도 timezone을 굶기지 않는다", () => {
  const lastStarted = new Map<RollupSchedulerTask, Date | null>([
    ["usage_15m_v2", null],
    ["timezone", null],
  ]);
  const selected: Array<{ task: RollupSchedulerTask; at: Date }> = [];

  for (let seconds = 0; seconds <= 30 * 60; seconds += 10) {
    const now = new Date(START.getTime() + seconds * 1_000);
    const task = selectRollupTask([
      candidate("usage_15m_v2", { lastStartedAt: lastStarted.get("usage_15m_v2") ?? null }),
      candidate("timezone", { lastStartedAt: lastStarted.get("timezone") ?? null }),
    ], now);
    if (!task) continue;
    selected.push({ task, at: now });
    lastStarted.set(task, now);
  }

  for (const task of ["usage_15m_v2", "timezone"] as const) {
    const times = selected.filter((entry) => entry.task === task).map((entry) => entry.at.getTime());
    assert.ok(times.length > 2, `${task}가 반복 선택되어야 함`);
    for (let index = 1; index < times.length; index++) {
      assert.ok(times[index]! - times[index - 1]! <= 120_000, `${task} 선택 간격`);
    }
  }
});

test("가격 복구를 포함한 세 heavy worker는 모두 120초 안에 반복 선택된다", () => {
  const tasks = ["pricing_repair", "usage_15m_v2", "timezone"] as const;
  const lastStarted = new Map<RollupSchedulerTask, Date | null>(tasks.map((task) => [task, null]));
  const selected = new Map<RollupSchedulerTask, number[]>(tasks.map((task) => [task, []]));

  for (let seconds = 0; seconds <= 30 * 60; seconds += 10) {
    const now = new Date(START.getTime() + seconds * 1_000);
    const task = selectRollupTask(tasks.map((name) => candidate(name, {
      lastStartedAt: lastStarted.get(name) ?? null,
    })), now);
    if (!task) continue;
    selected.get(task)!.push(now.getTime());
    lastStarted.set(task, now);
  }

  for (const task of tasks) {
    const times = selected.get(task)!;
    assert.ok(times.length > 2, `${task}가 반복 선택되어야 함`);
    assert.ok(times.slice(1).every((at, index) => at - times[index]! <= 120_000), `${task} 선택 간격`);
  }
});

test("30분 가속 soak 동안 heavy 작업은 하나씩 실행되고 outbox는 독립적으로 소진된다", async () => {
  const lastStarted = new Map<RollupSchedulerTask, Date | null>([
    ["usage_15m_v2", null],
    ["timezone", null],
  ]);
  const selected = new Map<RollupSchedulerTask, number[]>([
    ["usage_15m_v2", []],
    ["timezone", []],
  ]);
  let heavyInFlight = 0;
  let maximumHeavyConcurrency = 0;
  let outboxPending = 181;
  let outboxDelivered = 0;
  let lastHeartbeatAt = START;

  for (let seconds = 0; seconds <= 30 * 60; seconds += 10) {
    const now = new Date(START.getTime() + seconds * 1_000);
    lastHeartbeatAt = now;

    if (outboxPending > 0) {
      outboxPending--;
      outboxDelivered++;
    }

    const task = selectRollupTask([
      candidate("usage_15m_v2", { lastStartedAt: lastStarted.get("usage_15m_v2") ?? null }),
      candidate("timezone", { lastStartedAt: lastStarted.get("timezone") ?? null }),
    ], now);
    if (!task) continue;

    heavyInFlight++;
    maximumHeavyConcurrency = Math.max(maximumHeavyConcurrency, heavyInFlight);
    await Promise.resolve();
    selected.get(task)!.push(now.getTime());
    lastStarted.set(task, now);
    heavyInFlight--;
  }

  assert.equal(maximumHeavyConcurrency, 1);
  assert.equal(outboxPending, 0);
  assert.equal(outboxDelivered, 181);
  assert.ok(START.getTime() + 30 * 60 * 1_000 - lastHeartbeatAt.getTime() <= 120_000);
  for (const task of ["usage_15m_v2", "timezone"] as const) {
    const times = selected.get(task)!;
    assert.ok(times.length > 2, `${task}가 반복 선택되어야 함`);
    assert.ok(
      times.slice(1).every((at, index) => at - times[index]! <= 120_000),
      `${task}가 stalled 없이 120초 안에 다시 선택되어야 함`,
    );
  }
});

test("validation, 120초 대기, 가장 오래 미실행 순으로 선택한다", () => {
  const now = new Date(START.getTime() + 130_000);
  assert.equal(selectRollupTask([
    candidate("usage_15m_v2", { eligibleSince: START }),
    candidate("validation", { eligibleSince: now }),
  ], now), "validation");
  assert.equal(selectRollupTask([
    candidate("usage_15m_v2", { eligibleSince: START }),
    candidate("timezone", { eligibleSince: new Date(now.getTime() - 10_000) }),
  ], now), "usage_15m_v2");
  assert.equal(selectRollupTask([
    candidate("usage_15m_v2", { eligibleSince: now, lastStartedAt: new Date(now.getTime() - 70_000) }),
    candidate("timezone", { eligibleSince: now, lastStartedAt: new Date(now.getTime() - 90_000) }),
  ], now), "timezone");
});

function coordinatorDependencies(
  withLoadSlot: RollupCoordinatorDependencies["withLoadSlot"],
  runTask: RollupCoordinatorDependencies["runTask"],
): RollupCoordinatorDependencies {
  const records = new Map<RollupWorkerName, RollupWorkerRecord>([
    ["usage_15m_v2", worker("usage_15m_v2")],
    ["timezone", worker("timezone")],
  ]);
  return {
    withLoadSlot,
    scheduler: {
      recordHeartbeat: async () => undefined,
      recordStarted: async () => undefined,
      recordFinished: async () => undefined,
    },
    getWorker: async (name) => records.get(name)!,
    setEligibility: async () => undefined,
    countUsageBacklog: async () => 1,
    countTimezoneBacklog: async () => ({ eligible: 0, waitingForBase: 0 }),
    pricingRepairCandidate: async () => null,
    validationCandidate: async () => null,
    runTask,
  };
}

test("두 replica 중 잠금을 얻은 하나만 heavy task를 실행한다", async () => {
  let locked = false;
  let heavyCalls = 0;
  const withLoadSlot: RollupCoordinatorDependencies["withLoadSlot"] = async (operation) => {
    if (locked) return { acquired: false };
    locked = true;
    try {
      return { acquired: true, value: await operation() };
    } finally {
      locked = false;
    }
  };
  const runTask: RollupCoordinatorDependencies["runTask"] = async () => {
    heavyCalls++;
    await new Promise((resolve) => setImmediate(resolve));
    return "success";
  };

  const [first, second] = await Promise.all([
    runRollupCoordinatorTickWith(coordinatorDependencies(withLoadSlot, runTask), START),
    runRollupCoordinatorTickWith(coordinatorDependencies(withLoadSlot, runTask), START),
  ]);

  assert.equal(heavyCalls, 1);
  assert.deepEqual(new Set([first.status, second.status]), new Set(["completed", "busy"]));
});

test("validation 후보가 있어도 한 tick에는 heavy task 하나만 실행한다", async () => {
  const tasks: RollupSchedulerTask[] = [];
  const dependencies = coordinatorDependencies(
    async (operation) => ({ acquired: true, value: await operation() }),
    async (task) => {
      tasks.push(task);
      return "success";
    },
  );
  dependencies.validationCandidate = async () => candidate("validation");

  const result = await runRollupCoordinatorTickWith(dependencies, START);

  assert.equal(result.task, "validation");
  assert.deepEqual(tasks, ["validation"]);
});
