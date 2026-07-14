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
    remainingUnpricedEvents: 3,
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
    async getUnpricedUsageModels() {
      return remaining > 0
        ? [{ model: "model-a", events: remaining, firstAt: NOW, lastAt: NOW }]
        : [];
    },
    async repairUnpricedUsage(_request: unknown, resolver: PricingRepairResolver) {
      const resolved = resolver({
        dedupKey: "event-1", providerKey: "openai", userId: "user-1", sessionId: "session-1",
        model: "model-a", ts: NOW, inputTokens: 100, outputTokens: 20,
        cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0,
      });
      assert.equal(resolved?.pricingRevisionId, "revision-1");
      remaining = 0;
      return { scanned: 3, recovered: 3, affectedBuckets: [], hasMore: false };
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
  assert.equal(status.nextAttemptAt, null);
});

test("가격표가 없는 모델은 실패가 아니라 자동 재확인 대기 상태가 된다", async () => {
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
      };
      return true;
    },
    async markFailed() {
      throw new Error("unexpected failure");
    },
  };
  const storage = {
    reconcileCodexReplayUsage: async () => ({ scanned: 0, reconciled: 0, affectedBuckets: [], hasMore: false }),
    getUnpricedUsageModels: async () => [{ model: "unknown-model", events: 2, firstAt: NOW, lastAt: NOW }],
  } as unknown as StorageBackend;

  assert.equal(await runPricingRepairTaskWith({
    repository,
    storage,
    getSchedule: async () => new Map(),
    now: () => NOW,
  }), "success");
  assert.equal(status.state, "waiting_for_catalog");
  assert.equal(status.remainingUnpricedEvents, 2);
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
    getUnpricedUsageModels: async () => {
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
    getUnpricedUsageModels: async () => {
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
            remaining_unpriced_events: 100,
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
    remaining: 9_833,
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
