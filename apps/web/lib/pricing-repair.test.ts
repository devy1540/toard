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
