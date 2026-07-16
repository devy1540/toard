import assert from "node:assert/strict";
import test from "node:test";
import type { PricingSchedule } from "@toard/pricing";
import type { PricingRepairResolver, StorageBackend } from "@toard/core";
import {
  nextPricingRepairBatchLimit,
  PgPricingRepairRepository,
  pricingRepairCandidateFromStatus,
  runPricingRepairTaskWith,
  type PricingRepairRepository,
  type PricingRepairStatusRecord,
} from "./pricing-repair";
import type { Pool } from "pg";

const NOW = new Date("2026-07-14T00:00:00.000Z");
const GENERATION = "2026-07-14T00:00:00.000Z";

function pendingStatus(overrides: Partial<PricingRepairStatusRecord> = {}): PricingRepairStatusRecord {
  return {
    generation: GENERATION,
    state: "pending",
    targetTo: NOW,
    processedEvents: 0,
    recoveredEvents: 0,
    reconciledEvents: 0,
    repricedLegacyEvents: 0,
    remainingUnpricedEvents: 3,
    remainingLegacyEvents: 0,
    unresolvedModels: [],
    lastStartedAt: null,
    lastSucceededAt: null,
    lastError: null,
    adaptiveLimit: 100,
    loadState: "normal",
    eligibleSince: NOW,
    nextAttemptAt: NOW,
    consecutiveFailures: 0,
    updatedAt: NOW,
    ...overrides,
  };
}

test("가격 복구 worker는 지원 모델의 unpriced를 확정하고 idle로 마친다", async () => {
  let status = pendingStatus();
  let remaining = 3;
  const repository: PricingRepairRepository = {
    get: async () => status,
    claim: async () => ({ ...status, state: "running", lastStartedAt: NOW }),
    async markProgress(input) {
      status = {
        ...status,
        state: input.state,
        processedEvents: status.processedEvents + input.processed,
        recoveredEvents: status.recoveredEvents + input.recovered,
        reconciledEvents: status.reconciledEvents + input.reconciled,
        remainingUnpricedEvents: input.remaining,
        unresolvedModels: input.unresolvedModels,
        adaptiveLimit: input.adaptiveLimit,
        lastSucceededAt: input.at,
        nextAttemptAt: input.nextAttemptAt,
      };
      return true;
    },
    async markFailed() {
      throw new Error("unexpected failure");
    },
  };
  const storage = {
    async reconcileCodexReplayUsage() {
      return { scanned: 0, reconciled: 0, affectedBuckets: [], hasMore: false };
    },
    async getPricingRecoveryModels() {
      return remaining > 0
        ? [{ model: "model-a", events: remaining, unpricedEvents: remaining, legacyEvents: 0, firstAt: NOW, lastAt: NOW }]
        : [];
    },
    async repairPricingUsage(request: { replaceRevisionIds: string[] }, resolver: PricingRepairResolver) {
      assert.deepEqual(request.replaceRevisionIds, []);
      const resolved = resolver({
        dedupKey: "event-1", providerKey: "openai", userId: "user-1", sessionId: "session-1",
        model: "model-a", ts: NOW, inputTokens: 100, outputTokens: 20,
        cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0,
      });
      assert.equal(resolved?.pricingRevisionId, "revision-1");
      remaining = 0;
      return { scanned: 3, recovered: 3, repricedLegacy: 0, affectedBuckets: [], hasMore: false };
    },
  } as unknown as StorageBackend;
  const schedule: PricingSchedule = new Map([["model-a", [{
    id: "revision-1",
    modelId: "model-a",
    effectiveAt: new Date("2026-04-15T00:00:00.000Z"),
    pricing: { inputPerM: 1, outputPerM: 2 },
  }]]]);

  const outcome = await runPricingRepairTaskWith({
    repository,
    storage,
    getSchedule: async () => schedule,
    now: () => NOW,
  });

  assert.equal(outcome, "success");
  assert.equal(status.state, "idle");
  assert.equal(status.recoveredEvents, 3);
  assert.equal(status.remainingUnpricedEvents, 0);
  assert.equal(status.remainingLegacyEvents, 0);
  assert.equal(status.nextAttemptAt, null);
});

test("가격 복구 worker는 90일 이전 legacy도 전체 보존 범위에서 재가격한다", async () => {
  let status = pendingStatus({ remainingUnpricedEvents: 0, remainingLegacyEvents: 2 });
  let requestedFrom = "";
  let invalidations = 0;
  const repository: PricingRepairRepository = {
    get: async () => status,
    claim: async () => ({ ...status, state: "running", lastStartedAt: NOW }),
    async markProgress(input) {
      status = {
        ...status,
        state: input.state,
        processedEvents: status.processedEvents + input.processed,
        recoveredEvents: status.recoveredEvents + input.recovered,
        repricedLegacyEvents: status.repricedLegacyEvents + input.repricedLegacy,
        remainingUnpricedEvents: input.remaining,
        remainingLegacyEvents: input.remainingLegacy,
        unresolvedModels: input.unresolvedModels,
        nextAttemptAt: input.nextAttemptAt,
      };
      return true;
    },
    async markFailed() {
      throw new Error("unexpected failure");
    },
  };
  const oldAt = new Date("2025-09-15T12:00:00.000Z");
  const storage = {
    reconcileCodexReplayUsage: async (request: { from: Date }) => {
      requestedFrom = request.from.toISOString();
      return { scanned: 0, reconciled: 0, remainingUnpriced: 0, affectedBuckets: [], hasMore: false };
    },
    getPricingRecoveryModels: async () => [{
      model: "model-a",
      events: 2,
      unpricedEvents: 0,
      legacyEvents: 2,
      firstAt: oldAt,
      lastAt: oldAt,
    }],
    repairPricingUsage: async () => ({
      scanned: 2,
      recovered: 0,
      repricedLegacy: 2,
      affectedBuckets: [],
      hasMore: false,
    }),
  } as unknown as StorageBackend;
  const schedule: PricingSchedule = new Map([["model-a", [{
    id: "revision-old",
    modelId: "model-a",
    effectiveAt: new Date("2025-01-01T00:00:00.000Z"),
    pricing: { inputPerM: 1, outputPerM: 2 },
  }]]]);

  assert.equal(await runPricingRepairTaskWith({
    repository,
    storage,
    getSchedule: async () => schedule,
    invalidateInsightCache: () => { invalidations += 1; },
    now: () => NOW,
  }), "success");
  assert.equal(requestedFrom, "1970-01-01T00:00:00.000Z");
  assert.equal(status.state, "idle");
  assert.equal(status.repricedLegacyEvents, 2);
  assert.equal(status.remainingLegacyEvents, 0);
  assert.equal(invalidations, 1);
});

test("가격 복구 worker는 Codex 별칭과 모델 없는 과거 Codex 로그를 함께 보정한다", async () => {
  let status = pendingStatus({ remainingUnpricedEvents: 0, remainingLegacyEvents: 2 });
  let repairRequest: {
    models: string[];
    includeCodexModelFallback?: boolean;
  } | undefined;
  const repository: PricingRepairRepository = {
    get: async () => status,
    claim: async () => ({ ...status, state: "running", lastStartedAt: NOW }),
    async markProgress(input) {
      status = {
        ...status,
        state: input.state,
        repricedLegacyEvents: status.repricedLegacyEvents + input.repricedLegacy,
        remainingLegacyEvents: input.remainingLegacy,
        unresolvedModels: input.unresolvedModels,
        nextAttemptAt: input.nextAttemptAt,
      };
      return true;
    },
    async markFailed() {
      throw new Error("unexpected failure");
    },
  };
  const autoReviewAt = new Date("2026-07-10T00:00:00.000Z");
  const missingModelAt = new Date("2025-09-10T00:00:00.000Z");
  const storage = {
    reconcileCodexReplayUsage: async () => ({
      scanned: 0, reconciled: 0, remainingUnpriced: 0, affectedBuckets: [], hasMore: false,
    }),
    getPricingRecoveryModels: async () => [{
      providerKey: "codex",
      logAdapter: "codex",
      model: "codex-auto-review",
      events: 1,
      unpricedEvents: 0,
      legacyEvents: 1,
      firstAt: autoReviewAt,
      lastAt: autoReviewAt,
    }, {
      providerKey: "codex",
      logAdapter: "codex",
      model: null,
      events: 1,
      unpricedEvents: 0,
      legacyEvents: 1,
      firstAt: missingModelAt,
      lastAt: missingModelAt,
    }],
    repairPricingUsage: async (
      request: { models: string[]; includeCodexModelFallback?: boolean },
      resolver: PricingRepairResolver,
    ) => {
      repairRequest = request;
      const autoReview = resolver({
        dedupKey: "auto-review", providerKey: "codex", userId: "user-1", sessionId: "session-1",
        model: "codex-auto-review", ts: autoReviewAt, inputTokens: 1_000_000, outputTokens: 0,
        cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0, logAdapter: "codex",
      });
      const missingModel = resolver({
        dedupKey: "missing-model", providerKey: "codex", userId: "user-1", sessionId: "session-2",
        model: null, ts: missingModelAt, inputTokens: 1_000_000, outputTokens: 0,
        cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0, logAdapter: "codex",
      });
      assert.equal(autoReview?.pricingRevisionId, "gpt-5.5-revision");
      assert.equal(missingModel?.pricingRevisionId, "gpt-5-revision");
      return {
        scanned: 2, recovered: 0, repricedLegacy: 2, affectedBuckets: [], hasMore: false,
      };
    },
  } as unknown as StorageBackend;
  const schedule: PricingSchedule = new Map([
    ["gpt-5", [{
      id: "gpt-5-revision",
      modelId: "gpt-5",
      effectiveAt: new Date("2025-08-07T00:00:00.000Z"),
      pricing: { inputPerM: 2, outputPerM: 10 },
    }]],
    ["gpt-5.5", [{
      id: "gpt-5.5-revision",
      modelId: "gpt-5.5",
      effectiveAt: new Date("2026-04-23T00:00:00.000Z"),
      pricing: { inputPerM: 5, outputPerM: 25 },
    }]],
  ]);

  assert.equal(await runPricingRepairTaskWith({
    repository,
    storage,
    getSchedule: async () => schedule,
    now: () => NOW,
  }), "success");
  assert.deepEqual(repairRequest?.models, ["codex-auto-review"]);
  assert.equal(repairRequest?.includeCodexModelFallback, true);
  assert.equal(status.state, "idle");
  assert.equal(status.repricedLegacyEvents, 2);
  assert.equal(status.remainingLegacyEvents, 0);
  assert.deepEqual(status.unresolvedModels, []);
});

test("저장 revision으로 처리할 수 없는 과거 모델은 가격 이력 복구를 이어간다", async () => {
  let status = pendingStatus({ remainingUnpricedEvents: 2 });
  const repository: PricingRepairRepository = {
    get: async () => status,
    claim: async () => ({ ...status, state: "running", lastStartedAt: NOW }),
    async markProgress(input) {
      status = {
        ...status,
        state: input.state,
        remainingUnpricedEvents: input.remaining,
        unresolvedModels: input.unresolvedModels,
        nextAttemptAt: input.nextAttemptAt,
      };
      return true;
    },
    async markFailed() {
      throw new Error("unexpected failure");
    },
  };
  const storage = {
    reconcileCodexReplayUsage: async () => ({ scanned: 0, reconciled: 0, affectedBuckets: [], hasMore: false }),
    getPricingRecoveryModels: async (_from: Date, _to: Date, replaceRevisionIds: string[]) => {
      assert.deepEqual(replaceRevisionIds, ["bootstrap-revision"]);
      return [{
        model: "unknown-model",
        events: 2,
        unpricedEvents: 2,
        legacyEvents: 0,
        firstAt: new Date("2026-07-07T00:00:00.000Z"),
        lastAt: new Date("2026-07-07T23:59:00.000Z"),
      }];
    },
  } as unknown as StorageBackend;
  const historyCalls: unknown[][] = [];

  assert.equal(await runPricingRepairTaskWith({
    repository,
    storage,
    getSchedule: async () => new Map(),
    now: () => NOW,
    getNonAuthoritativeRevisionIds: async () => ["bootstrap-revision"],
    runHistoricalPricingStep: async (diagnostics) => {
      historyCalls.push(diagnostics);
      return { state: "fetching", nextAttemptAt: new Date("2026-07-14T00:01:00.000Z") };
    },
  }), "success");
  assert.equal(status.state, "pending");
  assert.equal(status.remainingUnpricedEvents, 2);
  assert.equal(historyCalls.length, 1);
  assert.equal(status.nextAttemptAt?.toISOString(), "2026-07-14T00:01:00.000Z");
});

test("같은 모델의 오늘 데이터가 섞여도 완료된 과거 날짜만 가격 이력 복구에 넘긴다", async () => {
  let status = pendingStatus({ remainingUnpricedEvents: 3 });
  const repository: PricingRepairRepository = {
    get: async () => status,
    claim: async () => ({ ...status, state: "running", lastStartedAt: NOW }),
    async markProgress(input) {
      status = {
        ...status,
        state: input.state,
        remainingUnpricedEvents: input.remaining,
        unresolvedModels: input.unresolvedModels,
        nextAttemptAt: input.nextAttemptAt,
      };
      return true;
    },
    async markFailed() {
      throw new Error("unexpected failure");
    },
  };
  const storage = {
    reconcileCodexReplayUsage: async () => ({ scanned: 0, reconciled: 0, affectedBuckets: [], hasMore: false }),
    getPricingRecoveryModels: async () => [{
      model: "mixed-date-model",
      events: 3,
      unpricedEvents: 3,
      legacyEvents: 0,
      firstAt: new Date("2026-06-10T12:00:00.000Z"),
      lastAt: new Date("2026-07-14T00:00:00.000Z"),
    }],
  } as unknown as StorageBackend;
  let historical: Array<{ firstAt: string; lastAt: string }> = [];

  assert.equal(await runPricingRepairTaskWith({
    repository,
    storage,
    getSchedule: async () => new Map(),
    now: () => NOW,
    runHistoricalPricingStep: async (diagnostics) => {
      historical = diagnostics;
      return { state: "fetching", nextAttemptAt: NOW };
    },
  }), "success");
  assert.deepEqual(historical, [{
    model: "mixed-date-model",
    events: 3,
    firstAt: "2026-06-10T12:00:00.000Z",
    lastAt: "2026-07-13T23:59:59.999Z",
  }]);
});

test("Codex 재생 중복이 남아 있으면 가격표 대상이 없어도 다음 보정 batch를 즉시 이어간다", async () => {
  let status = pendingStatus({ remainingUnpricedEvents: 100 });
  const repository: PricingRepairRepository = {
    get: async () => status,
    claim: async () => ({ ...status, state: "running", lastStartedAt: NOW }),
    async markProgress(input) {
      status = {
        ...status,
        state: input.state,
        processedEvents: status.processedEvents + input.processed,
        reconciledEvents: status.reconciledEvents + input.reconciled,
        remainingUnpricedEvents: input.remaining,
        nextAttemptAt: input.nextAttemptAt,
      };
      return true;
    },
    async markFailed() {
      throw new Error("unexpected failure");
    },
  };
  let reconcileCalls = 0;
  const storage = {
    async reconcileCodexReplayUsage() {
      reconcileCalls += 1;
      return {
        scanned: 100,
        reconciled: 100,
        remainingUnpriced: 12_433,
        affectedBuckets: [],
        hasMore: true,
      };
    },
    getPricingRecoveryModels: async () => {
      throw new Error("재생 중복이 남은 batch에서는 전체 미확정 진단을 실행하면 안 됩니다");
    },
  } as unknown as StorageBackend;

  assert.equal(await runPricingRepairTaskWith({
    repository,
    storage,
    getSchedule: async () => {
      throw new Error("재생 중복이 남은 batch에서는 가격표를 읽으면 안 됩니다");
    },
    now: () => NOW,
  }), "success");
  assert.equal(reconcileCalls, 1);
  assert.equal(status.state, "pending");
  assert.equal(status.processedEvents, 100);
  assert.equal(status.reconciledEvents, 100);
  assert.equal(status.remainingUnpricedEvents, 12_433);
  assert.equal(status.nextAttemptAt?.toISOString(), NOW.toISOString());
});

test("Codex 재생 중복의 마지막 삭제 batch도 가격 진단 전에 진행률을 확정한다", async () => {
  let progress: Parameters<PricingRepairRepository["markProgress"]>[0] | undefined;
  const repository: PricingRepairRepository = {
    get: async () => pendingStatus(),
    claim: async () => ({ ...pendingStatus(), state: "running", lastStartedAt: NOW }),
    async markProgress(input) {
      progress = input;
      return true;
    },
    async markFailed() {
      throw new Error("unexpected failure");
    },
  };
  const storage = {
    reconcileCodexReplayUsage: async () => ({
      scanned: 33,
      reconciled: 33,
      remainingUnpriced: 40,
      affectedBuckets: [],
      hasMore: false,
    }),
    getPricingRecoveryModels: async () => {
      throw new Error("삭제 진행률을 저장하기 전에 가격 진단을 실행하면 안 됩니다");
    },
  } as unknown as StorageBackend;

  assert.equal(await runPricingRepairTaskWith({
    repository,
    storage,
    getSchedule: async () => {
      throw new Error("삭제 진행률을 저장하기 전에 가격표를 읽으면 안 됩니다");
    },
    now: () => NOW,
  }), "success");
  assert.equal(progress?.state, "pending");
  assert.equal(progress?.processed, 33);
  assert.equal(progress?.reconciled, 33);
  assert.equal(progress?.remaining, 40);
});

test("pending과 오래 멈춘 running만 coordinator 후보가 된다", () => {
  assert.equal(pricingRepairCandidateFromStatus(pendingStatus(), NOW)?.due, true);
  assert.equal(pricingRepairCandidateFromStatus(pendingStatus({ state: "idle" }), NOW), null);
  assert.equal(pricingRepairCandidateFromStatus(pendingStatus({
    state: "running",
    lastStartedAt: new Date(NOW.getTime() - 4 * 60 * 1_000),
  }), NOW), null);
  assert.equal(pricingRepairCandidateFromStatus(pendingStatus({
    state: "running",
    lastStartedAt: new Date(NOW.getTime() - 6 * 60 * 1_000),
  }), NOW)?.due, true);
});

test("가격 복구 batch는 가득 찬 빠른 처리만 25% 늘리고 10초 이상이면 절반으로 줄인다", () => {
  assert.deepEqual(nextPricingRepairBatchLimit(100, 500, false), { limit: 100, loadState: "normal" });
  assert.deepEqual(nextPricingRepairBatchLimit(100, 2_000, true), { limit: 125, loadState: "normal" });
  assert.deepEqual(nextPricingRepairBatchLimit(100, 5_000, true), { limit: 100, loadState: "normal" });
  assert.deepEqual(nextPricingRepairBatchLimit(100, 10_000, true), { limit: 50, loadState: "throttled" });
  assert.deepEqual(nextPricingRepairBatchLimit(25, 10_000, true), { limit: 25, loadState: "throttled" });
  assert.deepEqual(nextPricingRepairBatchLimit(500, 100, true), { limit: 500, loadState: "normal" });
});

test("가격 복구 실패 backoff는 최대 5분으로 제한한다", async () => {
  let query = "";
  const pool = {
    async query(sql: string) {
      query = sql;
      return { rowCount: 1, rows: [{ singleton: true }] };
    },
  } as unknown as Pool;

  assert.equal(await new PgPricingRepairRepository(pool).markFailed(
    GENERATION,
    NOW,
    "temporary failure",
  ), true);
  assert.match(query, /LEAST\(300,/);
});

test("가격 복구 repository는 레거시 재가격 처리량과 잔여량을 읽고 저장한다", async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      if (sql.trimStart().startsWith("SELECT")) {
        return {
          rowCount: 1,
          rows: [{
            generation: GENERATION,
            state: "pending",
            target_to: NOW,
            processed_events: 11,
            recovered_events: 2,
            reconciled_events: 3,
            repriced_legacy_events: 5,
            remaining_unpriced_events: 7,
            remaining_legacy_events: 13,
            unresolved_models: [],
            last_started_at: null,
            last_succeeded_at: NOW,
            last_error: null,
            adaptive_limit: 100,
            load_state: "normal",
            eligible_since: NOW,
            next_attempt_at: NOW,
            consecutive_failures: 0,
            updated_at: NOW,
          }],
        };
      }
      return { rowCount: 1, rows: [{ singleton: true }] };
    },
  } as unknown as Pool;
  const repository = new PgPricingRepairRepository(pool);

  const status = await repository.get();
  assert.equal(status.repricedLegacyEvents, 5);
  assert.equal(status.remainingLegacyEvents, 13);

  assert.equal(await repository.markProgress({
    generation: GENERATION,
    state: "pending",
    processed: 10,
    recovered: 2,
    reconciled: 3,
    repricedLegacy: 5,
    remaining: 7,
    remainingLegacy: 13,
    unresolvedModels: [],
    adaptiveLimit: 100,
    loadState: "normal",
    nextAttemptAt: NOW,
    at: NOW,
  }), true);
  assert.match(calls[1]?.sql ?? "", /repriced_legacy_events = repriced_legacy_events \+ \$6/);
  assert.match(calls[1]?.sql ?? "", /remaining_legacy_events = \$8/);
  assert.equal(calls[1]?.params[5], 5);
  assert.equal(calls[1]?.params[7], 13);
});

test("가격 복구 repository는 PostgreSQL generation 마이크로초를 성공·실패 저장까지 보존한다", async () => {
  const exactGeneration = "2026-07-14 01:56:45.690911+00";
  const pool = {
    async query(sql: string, params: unknown[] = []) {
      if (sql.includes("SET state = 'running'")) {
        return {
          rowCount: 1,
          rows: [{
            generation: sql.includes("generation::text AS generation")
              ? exactGeneration
              : new Date(exactGeneration),
            state: "running",
            target_to: NOW,
            processed_events: 0,
            recovered_events: 0,
            reconciled_events: 0,
            repriced_legacy_events: 0,
            remaining_unpriced_events: 100,
            remaining_legacy_events: 0,
            unresolved_models: [],
            last_started_at: NOW,
            last_succeeded_at: null,
            last_error: null,
            adaptive_limit: 100,
            load_state: "normal",
            eligible_since: NOW,
            next_attempt_at: NOW,
            consecutive_failures: 0,
            updated_at: NOW,
          }],
        };
      }
      if (sql.includes("SET state = $2")) {
        return {
          rowCount: params[0] === exactGeneration ? 1 : 0,
          rows: params[0] === exactGeneration ? [{ singleton: true }] : [],
        };
      }
      if (sql.includes("SET state = 'failed'")) {
        return {
          rowCount: params[0] === exactGeneration ? 1 : 0,
          rows: params[0] === exactGeneration ? [{ singleton: true }] : [],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  } as unknown as Pool;
  const repository = new PgPricingRepairRepository(pool);
  const claimed = await repository.claim(NOW);

  assert.equal(claimed?.generation, exactGeneration);
  assert.equal(await repository.markProgress({
    generation: claimed!.generation!,
    state: "pending",
    processed: 100,
    recovered: 0,
    reconciled: 100,
    repricedLegacy: 0,
    remaining: 9_833,
    remainingLegacy: 0,
    unresolvedModels: [],
    adaptiveLimit: 125,
    loadState: "normal",
    nextAttemptAt: NOW,
    at: NOW,
  }), true);
  assert.equal(await repository.markFailed(
    claimed!.generation!,
    NOW,
    "temporary failure",
  ), true);
});
