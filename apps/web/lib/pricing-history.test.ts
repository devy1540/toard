import assert from "node:assert/strict";
import test from "node:test";
import type { PricingMap } from "@toard/pricing";
import {
  historicalPricingStatusFromJob,
  PgPricingHistoryRepository,
  runHistoricalPricingStepWith,
  type HistoricalPricingJob,
  type HistoricalPricingRepository,
} from "./pricing-history";
import {
  PricingSnapshotInvalidError,
  PricingSourceRateLimitError,
  type PricingHistoryCommitRef,
} from "./pricing-history-source";

const rangeFrom = new Date("2026-06-01T00:00:00.000Z");
const rangeTo = new Date("2026-07-01T00:00:00.000Z");

function commit(index: number): PricingHistoryCommitRef {
  return {
    sha: index.toString(16).padStart(40, "0"),
    committedAt: new Date(rangeFrom.getTime() + index * 60_000).toISOString(),
  };
}

function job(overrides: Partial<HistoricalPricingJob> = {}): HistoricalPricingJob {
  return {
    id: "job-1",
    algorithmVersion: 2,
    state: "fetching",
    rangeFrom,
    rangeTo,
    models: ["model-a"],
    commitRefs: [commit(0), commit(1), commit(2), commit(3), commit(4), commit(5)],
    listPage: 0,
    nextCommitIndex: 1,
    nextAttemptAt: null,
    rateLimitResetAt: null,
    consecutiveFailures: 0,
    lastError: null,
    ...overrides,
  };
}

function pricing(inputPerM = 1): PricingMap {
  return new Map([["model-a", { inputPerM, outputPerM: inputPerM * 2 }]]);
}

class FakeRepository implements HistoricalPricingRepository {
  events: string[] = [];
  canonicalInserts = 0;
  repairPendingCalls = 0;
  completed: HistoricalPricingJob | null = null;

  constructor(public active: HistoricalPricingJob | null) {}

  async getActive(): Promise<HistoricalPricingJob | null> {
    return this.active;
  }

  async findCompleted(): Promise<HistoricalPricingJob | null> {
    this.events.push("find-completed");
    return this.completed;
  }

  async create(input: {
    rangeFrom: Date;
    rangeTo: Date;
    models: string[];
    at: Date;
  }): Promise<HistoricalPricingJob> {
    this.events.push("create-job");
    this.active = job({
      state: "pending",
      rangeFrom: input.rangeFrom,
      rangeTo: input.rangeTo,
      models: input.models,
      commitRefs: [],
      nextCommitIndex: 0,
    });
    return this.active;
  }

  async saveBaseline(id: string, refs: PricingHistoryCommitRef[], at: Date): Promise<HistoricalPricingJob> {
    assert.equal(id, "job-1");
    this.events.push("save-baseline");
    this.active = { ...this.active!, state: "listing", commitRefs: refs, listPage: 1 };
    return this.active;
  }

  async saveCommitPage(
    id: string,
    refs: PricingHistoryCommitRef[],
    nextPage: number | null,
    at: Date,
  ): Promise<HistoricalPricingJob> {
    assert.equal(id, "job-1");
    this.events.push("save-commit-page");
    this.active = {
      ...this.active!,
      state: nextPage == null ? "fetching" : "listing",
      commitRefs: refs,
      listPage: nextPage ?? 0,
      nextCommitIndex: 0,
    };
    return this.active;
  }

  async saveSnapshots(
    id: string,
    snapshots: Array<{ ref: PricingHistoryCommitRef; pricing: PricingMap }>,
    at: Date,
  ): Promise<HistoricalPricingJob> {
    assert.equal(id, "job-1");
    this.events.push(`save-snapshots:${snapshots.length}`);
    const nextCommitIndex = this.active!.nextCommitIndex + snapshots.length;
    this.active = {
      ...this.active!,
      state: nextCommitIndex === this.active!.commitRefs.length ? "promoting" : "fetching",
      nextCommitIndex,
    };
    return this.active;
  }

  async skipSnapshot(
    id: string,
    ref: PricingHistoryCommitRef,
    at: Date,
  ): Promise<HistoricalPricingJob> {
    assert.equal(id, "job-1");
    assert.equal(this.active?.commitRefs[this.active.nextCommitIndex]?.sha, ref.sha);
    this.events.push(`skip-snapshot:${ref.sha}`);
    const nextCommitIndex = this.active!.nextCommitIndex + 1;
    this.active = {
      ...this.active!,
      state: nextCommitIndex === this.active!.commitRefs.length ? "promoting" : "fetching",
      nextCommitIndex,
    };
    return this.active;
  }

  async promote(id: string, at: Date): Promise<{ insertedRevisions: number; evidenceFound: boolean }> {
    assert.equal(id, "job-1");
    this.events.push("begin");
    this.events.push("insert-revisions");
    this.canonicalInserts += 2;
    this.events.push("update-cache-version");
    this.events.push("repair-pending");
    this.repairPendingCalls += 1;
    this.events.push("complete-job");
    this.events.push("commit");
    this.active = null;
    return { insertedRevisions: 2, evidenceFound: true };
  }

  async waitForSource(
    id: string,
    nextAttemptAt: Date,
    rateLimitResetAt: Date | null,
    error: string,
    at: Date,
  ): Promise<HistoricalPricingJob> {
    assert.equal(id, "job-1");
    this.events.push("wait-source");
    this.active = {
      ...this.active!,
      state: "waiting_source",
      nextAttemptAt,
      rateLimitResetAt,
      consecutiveFailures: this.active!.consecutiveFailures + 1,
      lastError: error,
    };
    return this.active;
  }

  async resume(id: string, state: "pending" | "listing" | "fetching", at: Date): Promise<HistoricalPricingJob> {
    assert.equal(id, "job-1");
    this.events.push(`resume:${state}`);
    this.active = {
      ...this.active!,
      state,
      nextAttemptAt: null,
      rateLimitResetAt: null,
    };
    return this.active;
  }
}

function dependencies(repository: FakeRepository, options: {
  fetchSnapshot?: (sha: string) => Promise<PricingMap>;
  now?: Date;
} = {}) {
  const sourceCalls: string[] = [];
  return {
    sourceCalls,
    value: {
      repository,
      source: {
        async listBaseline(): Promise<PricingHistoryCommitRef[]> {
          sourceCalls.push("baseline");
          return [commit(0)];
        },
        async listChanges(): Promise<PricingHistoryCommitRef[]> {
          sourceCalls.push("changes");
          return [];
        },
        async fetchSnapshot(sha: string): Promise<PricingMap> {
          sourceCalls.push(sha);
          return options.fetchSnapshot?.(sha) ?? pricing();
        },
      },
      now: () => options.now ?? new Date("2026-07-14T00:00:00.000Z"),
      timezone: "UTC",
      invalidateCache: () => repository.events.push("invalidate-cache"),
    },
  };
}

test("전체 snapshot 전에는 canonical revision과 repair generation을 변경하지 않는다", async () => {
  const repository = new FakeRepository(job());
  const fixture = dependencies(repository);

  const result = await runHistoricalPricingStepWith(fixture.value, []);

  assert.equal(result.state, "fetching");
  assert.equal(repository.active?.nextCommitIndex, 5);
  assert.equal(repository.canonicalInserts, 0);
  assert.equal(repository.repairPendingCalls, 0);
  assert.deepEqual(repository.events, ["save-snapshots:4"]);
});

test("90일보다 오래된 보존 이벤트도 실제 최초 시각부터 가격 이력 job을 만든다", async () => {
  const repository = new FakeRepository(null);
  const fixture = dependencies(repository);

  const result = await runHistoricalPricingStepWith(fixture.value, [{
    model: "model-a",
    events: 3,
    firstAt: "2025-09-15T12:34:56.000Z",
    lastAt: "2026-07-10T01:02:03.000Z",
  }]);

  assert.deepEqual(result, {
    state: "listing",
    nextAttemptAt: new Date("2026-07-14T00:00:00.000Z"),
  });
  assert.equal(repository.active?.rangeFrom.toISOString(), "2025-09-15T00:00:00.000Z");
  assert.equal(repository.active?.rangeTo.toISOString(), "2026-07-11T00:00:00.000Z");
});

test("같은 범위와 모델을 이미 확인한 완료 job은 다시 생성하지 않는다", async () => {
  const repository = new FakeRepository(null);
  repository.completed = job({ state: "completed", commitRefs: [], nextCommitIndex: 0 });
  const fixture = dependencies(repository);

  const result = await runHistoricalPricingStepWith(fixture.value, [{
    model: "model-a",
    events: 3,
    firstAt: "2026-06-01T12:34:56.000Z",
    lastAt: "2026-06-30T01:02:03.000Z",
  }]);

  assert.deepEqual(result, {
    state: "no_evidence",
    nextAttemptAt: new Date("2026-07-14T01:00:00.000Z"),
  });
  assert.deepEqual(repository.events, ["find-completed"]);
  assert.deepEqual(fixture.sourceCalls, []);
});

test("범위 중간에 처음 발견된 모델 가격은 해당 복구 범위 시작부터 적용한다", async () => {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const firstPriceCommit = {
    sha: "a".repeat(40),
    committedAt: "2026-06-15T00:00:00.000Z",
  };
  const fetching = job({
    commitRefs: [firstPriceCommit],
    nextCommitIndex: 0,
  });
  const client = {
    async query(sql: string, params: unknown[] = []) {
      queries.push({ sql, params });
      if (sql.includes("FROM pricing_history_jobs") && sql.includes("FOR UPDATE")) {
        return { rows: [{
          id: fetching.id,
          algorithm_version: fetching.algorithmVersion,
          state: fetching.state,
          range_from: fetching.rangeFrom,
          range_to: fetching.rangeTo,
          models: fetching.models,
          commit_refs: fetching.commitRefs,
          list_page: fetching.listPage,
          next_commit_index: fetching.nextCommitIndex,
          next_attempt_at: null,
          rate_limit_reset_at: null,
          consecutive_failures: 0,
          last_error: null,
        }] };
      }
      if (sql.includes("FROM pricing_history_candidates")) return { rows: [] };
      if (sql.includes("UPDATE pricing_history_jobs") && sql.includes("RETURNING")) {
        return { rows: [{
          id: fetching.id,
          algorithm_version: fetching.algorithmVersion,
          state: "promoting",
          range_from: fetching.rangeFrom,
          range_to: fetching.rangeTo,
          models: fetching.models,
          commit_refs: fetching.commitRefs,
          list_page: 0,
          next_commit_index: 1,
          next_attempt_at: null,
          rate_limit_reset_at: null,
          consecutive_failures: 0,
          last_error: null,
        }] };
      }
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  const pool = { connect: async () => client };

  await new PgPricingHistoryRepository(pool as never).saveSnapshots(fetching.id, [{
    ref: firstPriceCommit,
    pricing: pricing(),
  }], new Date("2026-07-14T00:00:00.000Z"));

  const candidateInsert = queries.find(({ sql }) => sql.includes("INSERT INTO pricing_history_candidates"));
  assert.equal((candidateInsert?.params[3] as Date).toISOString(), rangeFrom.toISOString());
});

test("promotion은 revision·cache version·repair pending을 한 transaction으로 확정한다", async () => {
  const repository = new FakeRepository(job({ state: "promoting", nextCommitIndex: 6 }));
  const fixture = dependencies(repository);

  const result = await runHistoricalPricingStepWith(fixture.value, []);

  assert.deepEqual(result, { state: "promoted", insertedRevisions: 2 });
  assert.deepEqual(repository.events, [
    "begin",
    "insert-revisions",
    "update-cache-version",
    "repair-pending",
    "complete-job",
    "commit",
    "invalidate-cache",
  ]);
});

test("rate limit reset 전에는 source를 호출하지 않는다", async () => {
  const repository = new FakeRepository(job({
    state: "waiting_source",
    nextAttemptAt: new Date("2026-07-14T00:05:00.000Z"),
    rateLimitResetAt: new Date("2026-07-14T00:05:00.000Z"),
  }));
  const fixture = dependencies(repository, { now: new Date("2026-07-14T00:04:59.000Z") });

  const result = await runHistoricalPricingStepWith(fixture.value, []);

  assert.deepEqual(result, {
    state: "waiting_source",
    nextAttemptAt: new Date("2026-07-14T00:05:00.000Z"),
  });
  assert.deepEqual(fixture.sourceCalls, []);
  assert.deepEqual(repository.events, []);
});

test("중단 후에는 저장된 cursor부터 최대 4개 snapshot만 재개한다", async () => {
  const repository = new FakeRepository(job({ nextCommitIndex: 3 }));
  const fixture = dependencies(repository);

  await runHistoricalPricingStepWith(fixture.value, []);

  assert.deepEqual(fixture.sourceCalls, [commit(3).sha, commit(4).sha, commit(5).sha]);
  assert.equal(repository.active?.state, "promoting");
  assert.equal(repository.active?.nextCommitIndex, 6);
});

test("복구 불가능한 immutable snapshot은 직전 가격을 유지하며 다음 cursor로 진행한다", async () => {
  const repository = new FakeRepository(job({ consecutiveFailures: 2 }));
  const broken = commit(2);
  const fixture = dependencies(repository, {
    fetchSnapshot: async (sha) => {
      if (sha === broken.sha) throw new PricingSnapshotInvalidError(sha);
      return pricing();
    },
  });

  const result = await runHistoricalPricingStepWith(fixture.value, []);

  assert.deepEqual(result, {
    state: "fetching",
    nextAttemptAt: new Date("2026-07-14T00:00:00.000Z"),
  });
  assert.equal(repository.active?.state, "fetching");
  assert.equal(repository.active?.nextCommitIndex, 3);
  assert.deepEqual(repository.events, [
    "save-snapshots:1",
    `skip-snapshot:${broken.sha}`,
  ]);
  assert.deepEqual(fixture.sourceCalls, [commit(1).sha, broken.sha]);
});

test("첫 snapshot 파싱 실패는 일시적인 응답 손상을 고려해 재시도한다", async () => {
  const repository = new FakeRepository(job());
  const broken = commit(1);
  const fixture = dependencies(repository, {
    fetchSnapshot: async (sha) => {
      throw new PricingSnapshotInvalidError(sha);
    },
  });

  const result = await runHistoricalPricingStepWith(fixture.value, []);

  assert.deepEqual(result, {
    state: "waiting_source",
    nextAttemptAt: new Date("2026-07-14T00:01:00.000Z"),
  });
  assert.equal(repository.active?.nextCommitIndex, 1);
  assert.equal(repository.active?.consecutiveFailures, 1);
  assert.deepEqual(repository.events, ["wait-source"]);
  assert.deepEqual(fixture.sourceCalls, [broken.sha]);
});

test("429는 durable reset 시각을 저장하고 다음 tick으로 넘긴다", async () => {
  const resetAt = new Date("2026-07-14T00:10:00.000Z");
  const repository = new FakeRepository(job({ state: "pending", commitRefs: [], nextCommitIndex: 0 }));
  const fixture = dependencies(repository);
  fixture.value.source.listBaseline = async () => {
    fixture.sourceCalls.push("baseline");
    throw new PricingSourceRateLimitError(resetAt);
  };

  const result = await runHistoricalPricingStepWith(fixture.value, []);

  assert.deepEqual(result, { state: "waiting_source", nextAttemptAt: resetAt });
  assert.equal(repository.active?.rateLimitResetAt?.toISOString(), resetAt.toISOString());
  assert.equal(repository.active?.lastError, "pricing source rate limited");
});

test("관리자 상태는 snapshot 진행률과 재시도 시각만 안전하게 노출한다", () => {
  assert.deepEqual(historicalPricingStatusFromJob(job({
    state: "fetching",
    nextCommitIndex: 2,
    nextAttemptAt: new Date("2026-07-14T00:01:00.000Z"),
    lastError: "pricing history source unavailable",
  })), {
    state: "fetching",
    rangeFrom: "2026-06-01T00:00:00.000Z",
    rangeTo: "2026-07-01T00:00:00.000Z",
    models: 1,
    processedSnapshots: 2,
    totalSnapshots: 6,
    nextAttemptAt: "2026-07-14T00:01:00.000Z",
    lastError: "pricing history source unavailable",
  });
});
