import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceRollupCutoverWith,
  loadRollupLayerReadinessWith,
  rollupEligibleTargetAt,
  type RollupCutoverDependencies,
  type RollupValidationResult,
} from "./rollup-cutover";
import type {
  RollupCutoverLayer,
  RollupCutoverRecord,
  RollupCutoverRepository,
  RollupCutoverUpdate,
} from "./rollup-cutover-state";

const T0 = new Date("2026-07-13T01:30:00.000Z");
const NOW = new Date("2026-07-13T02:00:00.000Z");

function record(
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

function fixture(options: {
  usage?: Partial<RollupCutoverRecord>;
  timezone?: Partial<RollupCutoverRecord>;
  validation?: RollupValidationResult;
  ready?: boolean;
  validationReady?: boolean;
} = {}) {
  const records = new Map<RollupCutoverLayer, RollupCutoverRecord>([
    ["usage_15m_v2", record("usage_15m_v2", options.usage)],
    ["timezone", record("timezone", options.timezone)],
  ]);
  const readinessTargets: Array<{ layer: RollupCutoverLayer; target: Date }> = [];
  const repository: RollupCutoverRepository = {
    async get(layer) {
      return records.get(layer)!;
    },
    async getAll() {
      return [...records.values()];
    },
    async save(layer, update: RollupCutoverUpdate) {
      const next = { ...records.get(layer)!, ...update, updatedAt: NOW };
      records.set(layer, next);
      return next;
    },
  };
  const dependencies: RollupCutoverDependencies = {
    repository,
    eligibleTarget: () => new Date("2026-07-13T01:45:00.000Z"),
    async readiness(layer, target) {
      readinessTargets.push({ layer, target });
      return {
        ready: options.ready ?? true,
        kind: options.ready === false ? "lag" : null,
        detail: options.ready === false ? "worker lag" : null,
        activeTimezones: ["Asia/Seoul"],
        validationReady: options.validationReady,
      };
    },
    async validate() {
      return options.validation ?? { ok: true, kind: null, detail: null };
    },
    logTransition: () => undefined,
  };
  return { records, readinessTargets, dependencies };
}

test("observing은 신규 eligible target이 이동해도 고정 T0와 누적 시간을 유지한다", async () => {
  const f = fixture({
    usage: {
      state: "observing",
      targetWatermark: T0,
      healthySeconds: 600,
      lastCheckedAt: new Date(NOW.getTime() - 60_000),
      lastValidationAt: T0,
    },
  });

  await advanceRollupCutoverWith(f.dependencies, NOW);

  const saved = f.records.get("usage_15m_v2")!;
  assert.equal(saved.targetWatermark?.toISOString(), T0.toISOString());
  assert.equal(saved.healthySeconds, 660);
  assert.equal(f.readinessTargets[0]?.target.toISOString(), T0.toISOString());
});

test("observing 중 재계산 필요 상태는 시간을 늘리지 않고 복구 후 이어갈 수 있게 한다", async () => {
  const f = fixture({
    usage: {
      state: "observing",
      targetWatermark: T0,
      healthySeconds: 600,
      lastCheckedAt: new Date(NOW.getTime() - 60_000),
      lastValidationAt: T0,
    },
    ready: false,
  });

  await advanceRollupCutoverWith(f.dependencies, NOW);

  const saved = f.records.get("usage_15m_v2")!;
  assert.equal(saved.state, "observing");
  assert.equal(saved.healthySeconds, 600);
  assert.equal(saved.lastFailureKind, "lag");
});

test("정상 관찰 3600초와 마지막 검증을 통과하면 active로 전환한다", async () => {
  const f = fixture({
    usage: {
      state: "observing",
      targetWatermark: T0,
      healthySeconds: 3_540,
      lastCheckedAt: new Date(NOW.getTime() - 60_000),
      lastValidationAt: T0,
    },
  });

  await advanceRollupCutoverWith(f.dependencies, NOW);

  const saved = f.records.get("usage_15m_v2")!;
  assert.equal(saved.state, "active");
  assert.equal(saved.healthySeconds, 3_600);
  assert.equal(saved.activatedAt?.toISOString(), NOW.toISOString());
});

test("active 데이터 mismatch는 한 번에 fallback으로 전환한다", async () => {
  const f = fixture({
    usage: {
      state: "active",
      targetWatermark: T0,
      healthySeconds: 3_600,
      lastCheckedAt: new Date(NOW.getTime() - 60_000),
      lastValidationAt: new Date(NOW.getTime() - 7 * 60 * 60 * 1_000),
      activatedAt: T0,
    },
    validation: { ok: false, kind: "mismatch", detail: "fingerprint mismatch" },
  });

  await advanceRollupCutoverWith(f.dependencies, NOW);

  const saved = f.records.get("usage_15m_v2")!;
  assert.equal(saved.state, "fallback");
  assert.equal(saved.lastFailureKind, "mismatch");
  assert.equal(saved.consecutiveFailures, 1);
});

test("active 일시 장애는 세 번째 연속 실패에서만 fallback한다", async () => {
  const f = fixture({
    usage: {
      state: "active",
      targetWatermark: T0,
      healthySeconds: 3_600,
      lastCheckedAt: new Date(NOW.getTime() - 60_000),
      lastValidationAt: new Date(NOW.getTime() - 7 * 60 * 60 * 1_000),
      consecutiveFailures: 2,
      activatedAt: T0,
    },
    validation: { ok: false, kind: "unavailable", detail: "ClickHouse unavailable" },
  });

  await advanceRollupCutoverWith(f.dependencies, NOW);

  const saved = f.records.get("usage_15m_v2")!;
  assert.equal(saved.state, "fallback");
  assert.equal(saved.consecutiveFailures, 3);
});

test("active 시간대 worker가 정상 backlog를 처리 중이면 recurring 검증을 미룬다", async () => {
  let validations = 0;
  const f = fixture({
    usage: {
      state: "active",
      targetWatermark: T0,
      healthySeconds: 3_600,
      lastCheckedAt: new Date(NOW.getTime() - 60_000),
      lastValidationAt: NOW,
      activatedAt: T0,
    },
    timezone: {
      state: "active",
      targetWatermark: T0,
      healthySeconds: 3_600,
      lastCheckedAt: new Date(NOW.getTime() - 60_000),
      lastValidationAt: new Date(NOW.getTime() - 7 * 60 * 60 * 1_000),
      activatedAt: T0,
    },
    validationReady: false,
    validation: { ok: false, kind: "mismatch", detail: "latest bucket pending" },
  });
  const originalValidate = f.dependencies.validate;
  f.dependencies.validate = async (...args) => {
    validations++;
    return originalValidate(...args);
  };

  await advanceRollupCutoverWith(f.dependencies, NOW);

  assert.equal(f.records.get("timezone")!.state, "active");
  assert.equal(validations, 0);
});

test("eligible target은 finalize 지연을 제외한 15분 경계로 고정한다", () => {
  assert.equal(
    rollupEligibleTargetAt(
      new Date("2026-07-13T02:08:00.000Z"),
      {},
    ).toISOString(),
    "2026-07-13T01:30:00.000Z",
  );
});

test("runtime readiness는 고정 T0 watermark와 재계산 필요 bucket을 확인한다", async () => {
  const pool = {
    async query(sql: string) {
      if (sql.includes("clickhouse_rollup_watermarks")) return { rows: [{ watermark: T0 }] };
      if (sql.includes("clickhouse_rollup_dirty_buckets")) return { rows: [{ count: 0 }] };
      if (sql.includes("clickhouse_rollup_timezones")) return { rows: [{ timezone: "Asia/Seoul" }] };
      return { rows: [] };
    },
  };

  const readiness = await loadRollupLayerReadinessWith(
    pool,
    "usage_15m_v2",
    T0,
    "observing",
  );

  assert.equal(readiness.ready, true);
  assert.deepEqual(readiness.activeTimezones, ["Asia/Seoul"]);
});

test("active 시간대의 정상 backlog는 읽기를 유지하되 검증만 미룬다", async () => {
  const pool = {
    async query(sql: string) {
      if (sql.includes("clickhouse_timezone_rollup_jobs")) {
        return { rows: [{ pending: 6, inflight: 0 }] };
      }
      if (sql.includes("clickhouse_rollup_timezones")) return { rows: [{ timezone: "Asia/Seoul" }] };
      return { rows: [] };
    },
  };

  const active = await loadRollupLayerReadinessWith(pool, "timezone", T0, "active");
  const observing = await loadRollupLayerReadinessWith(pool, "timezone", T0, "observing");

  assert.equal(active.ready, true);
  assert.equal(active.validationReady, false);
  assert.equal(observing.ready, false);
});
