import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { StorageBackend } from "@toard/core";
import type { Pool, PoolClient } from "pg";
import {
  PgTeamAttributionRepository,
  runTeamAttributionBatchAt,
  sanitizeTeamAttributionError,
  teamAttributionSchedulerEligible,
  type ClaimedTeamAttributionJob,
  type TeamAttributionRepository,
} from "./team-attribution";

const now = new Date("2026-07-19T10:00:00.000Z");

function job(overrides: Partial<ClaimedTeamAttributionJob> = {}): ClaimedTeamAttributionJob {
  return {
    id: "job-1",
    assignmentId: "assignment-1",
    userId: "user-1",
    teamId: "team-1",
    kind: "initial_backfill",
    from: null,
    to: null,
    matchedEvents: 0,
    processedEvents: 0,
    updatedEvents: 0,
    attempts: 1,
    ...overrides,
  };
}

test("team attribution repository는 SKIP LOCKED로 한 job을 claim하고 running으로 전환한다", async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes("FOR UPDATE OF job SKIP LOCKED")) {
        return {
          rows: [{
            id: "job-1",
            assignment_id: "assignment-1",
            user_id: "user-1",
            team_id: "team-1",
            kind: "initial_backfill",
            from_ts: "-infinity",
            assignment_to: null,
            matched_events: "0",
            processed_events: "0",
            updated_events: "0",
            attempts: 0,
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("UPDATE team_attribution_jobs")) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  } as unknown as PoolClient;
  const repository = new PgTeamAttributionRepository({
    connect: async () => client,
  } as unknown as Pool);

  const claimed = await repository.claim(now);

  const claimSql = calls.find(({ sql }) => sql.includes("FOR UPDATE OF job SKIP LOCKED"))?.sql ?? "";
  assert.match(claimSql, /status IN \('pending', 'failed'\)/);
  assert.match(claimSql, /next_attempt_at <= \$1/);
  assert.match(claimSql, /status = 'running'/);
  const runningSql = calls.find(({ sql }) => sql.includes("UPDATE team_attribution_jobs"))?.sql ?? "";
  assert.match(runningSql, /status = 'running'/);
  assert.match(runningSql, /attempts = attempts \+ 1/);
  assert.equal(calls.some(({ sql }) => sql === "COMMIT"), true);
  assert.deepEqual(claimed, job());
});

test("team attribution worker는 preview를 기록하고 hasMore batch를 pending으로 되돌린다", async () => {
  const actions: Array<{ name: string; value?: unknown }> = [];
  const repository: TeamAttributionRepository = {
    claim: async () => job(),
    recordMatched: async (_jobId, events) => {
      actions.push({ name: "matched", value: events });
    },
    markProgress: async (_jobId, result) => {
      actions.push({ name: "progress", value: result });
    },
    markFailed: async () => {
      actions.push({ name: "failed" });
    },
  };
  const storage = {
    previewUnassignedTeamAttribution: async () => ({
      events: 5,
      from: new Date("2026-07-01T00:00:00.000Z"),
      to: new Date("2026-07-02T00:00:00.000Z"),
      totalTokens: 100,
      costUsd: 1,
    }),
    backfillUnassignedTeamAttribution: async () => ({
      processed: 2,
      updated: 2,
      affectedBuckets: [],
      hasMore: true,
    }),
  } as unknown as StorageBackend;

  const outcome = await runTeamAttributionBatchAt(now, { repository, storage, limit: 100 });

  assert.equal(outcome, "progress");
  assert.deepEqual(actions, [
    { name: "matched", value: 5 },
    {
      name: "progress",
      value: { processed: 2, updated: 2, hasMore: true, at: now },
    },
  ]);
});

test("team attribution worker는 마지막 batch 뒤 succeeded를 기록한다", async () => {
  let progress: unknown;
  const repository: TeamAttributionRepository = {
    claim: async () => job({ matchedEvents: 5, processedEvents: 4, updatedEvents: 4 }),
    recordMatched: async () => undefined,
    markProgress: async (_jobId, result) => {
      progress = result;
    },
    markFailed: async () => undefined,
  };
  const storage = {
    backfillUnassignedTeamAttribution: async () => ({
      processed: 1,
      updated: 1,
      affectedBuckets: [],
      hasMore: false,
    }),
  } as unknown as StorageBackend;

  assert.equal(
    await runTeamAttributionBatchAt(now, { repository, storage, limit: 100 }),
    "complete",
  );
  assert.deepEqual(progress, { processed: 1, updated: 1, hasMore: false, at: now });
});

test("team attribution worker는 원문 오류를 저장하지 않고 고정 코드와 backoff로 실패 처리한다", async () => {
  let failure: { code: string; at: Date } | undefined;
  const repository: TeamAttributionRepository = {
    claim: async () => job(),
    recordMatched: async () => undefined,
    markProgress: async () => undefined,
    markFailed: async (_jobId, code, at) => {
      failure = { code, at };
    },
  };
  const storage = {
    previewUnassignedTeamAttribution: async () => {
      throw new Error("postgres://secret-user:secret-password@db.internal/toard");
    },
  } as unknown as StorageBackend;

  assert.equal(
    await runTeamAttributionBatchAt(now, { repository, storage, limit: 100 }),
    "failed",
  );
  assert.deepEqual(failure, { code: "TEAM_ATTRIBUTION_FAILED", at: now });
  assert.equal(JSON.stringify(failure).includes("secret-password"), false);
  assert.equal(sanitizeTeamAttributionError(new Error("rollup verification failed")), "ROLLUP_VERIFICATION_FAILED");
});

test("team attribution scheduler와 cron route는 self-host 및 CRON_SECRET 정책을 따른다", () => {
  assert.equal(teamAttributionSchedulerEligible({ NODE_ENV: "production" }), true);
  assert.equal(teamAttributionSchedulerEligible({ NODE_ENV: "development" }), false);
  assert.equal(teamAttributionSchedulerEligible({ NODE_ENV: "production", VERCEL: "1" }), false);

  const instrumentation = readFileSync(new URL("../instrumentation.ts", import.meta.url), "utf8");
  const route = readFileSync(
    new URL("../app/api/cron/team-attribution/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(instrumentation, /teamAttributionSchedulerEligible[\s\S]*startTeamAttributionWorker/);
  assert.match(route, /CRON_SECRET/);
  assert.match(route, /Bearer/);
  assert.match(route, /runTeamAttributionBatch/);
});
