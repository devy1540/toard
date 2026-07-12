import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { addLocalCalendarDays, firstInstantOfLocalDate } from "@toard/core";
import {
  createPostgresRawRetentionDrain,
  prunePostgresRawEventsAt,
  pruneTimezoneCoverageAt,
  retentionSchedulerEligible,
  runUsageRetentionAt,
  timezoneCoverageCutoffs,
  type UsageRetentionDependencies,
} from "./retention-cleanup";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function drainSchedulerFixture() {
  const scheduled: Array<{
    callback: () => void;
    delayMs: number;
    cleared: boolean;
    unrefCalled: boolean;
  }> = [];
  return {
    scheduled,
    schedule(callback: () => void, delayMs: number) {
      const handle = {
        callback,
        delayMs,
        cleared: false,
        unrefCalled: false,
        unref() {
          handle.unrefCalled = true;
        },
      };
      scheduled.push(handle);
      return handle;
    },
    clear(handle: unknown) {
      (handle as { cleared: boolean }).cleared = true;
    },
  };
}

function retentionFixture(options: { failDelete?: boolean } = {}) {
  const sql: string[] = [];
  const params: unknown[][] = [];
  const transactions: string[] = [];
  let released = false;
  const client = {
    async query(statement: string, values: unknown[] = []) {
      sql.push(statement);
      params.push(values);
      if (statement === "BEGIN" || statement === "COMMIT" || statement === "ROLLBACK") {
        transactions.push(statement);
      }
      if (statement.includes("DELETE FROM raw_events")) {
        if (options.failDelete) throw new Error("delete failed");
        return { rowCount: 2, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    },
    release() {
      released = true;
    },
  };
  return {
    sql,
    params,
    transactions,
    get released() {
      return released;
    },
    pool: { connect: async () => client },
  };
}

test("Postgres raw payload cleanup은 참조를 분리한 뒤 같은 bounded transaction에서 삭제한다", async () => {
  const fixture = retentionFixture();
  const now = new Date("2026-07-12T00:00:00.000Z");
  const result = await prunePostgresRawEventsAt(fixture.pool, now, 1000);

  assert.equal(result.rawEvents, 2);
  const cleanup = fixture.sql.find((statement) => statement.includes("DELETE FROM raw_events"));
  assert.ok(cleanup);
  assert.match(cleanup, /SELECT id[\s\S]*FROM raw_events[\s\S]*received_at < \$1/);
  assert.match(cleanup, /ORDER BY id[\s\S]*LIMIT \$2[\s\S]*FOR UPDATE SKIP LOCKED/);
  assert.match(cleanup, /UPDATE usage_events[\s\S]*SET raw_event_id = NULL/);
  assert.match(cleanup, /DELETE FROM raw_events/);
  assert.deepEqual(fixture.transactions, ["BEGIN", "COMMIT"]);
  assert.deepEqual(fixture.params[1], [new Date("2026-07-05T00:00:00.000Z"), 1000]);
  assert.equal(fixture.released, true);
});

test("Postgres raw payload cleanup 실패는 rollback하고 client를 반환한다", async () => {
  const fixture = retentionFixture({ failDelete: true });

  await assert.rejects(
    prunePostgresRawEventsAt(fixture.pool, new Date("2026-07-12T00:00:00.000Z"), 1000),
    /delete failed/,
  );
  assert.deepEqual(fixture.transactions, ["BEGIN", "ROLLBACK"]);
  assert.equal(fixture.released, true);
});

test("raw retention full batch는 1초 뒤 raw-only batch를 이어가고 short batch에서 멈춘다", async () => {
  const scheduler = drainSchedulerFixture();
  const batches = [1000, 37];
  const calls: string[] = [];
  const controller = createPostgresRawRetentionDrain({
    prunePostgresRawEvents: async () => {
      calls.push("raw");
      return { rawEvents: batches.shift()! };
    },
    now: () => new Date("2026-07-12T00:00:01.000Z"),
    schedule: scheduler.schedule,
    clear: scheduler.clear,
    warn: () => undefined,
    batchLimit: 1000,
    followupDelayMs: 1000,
    errorBackoffMs: 60_000,
  });

  await controller.run(new Date("2026-07-12T00:00:00.000Z"));
  assert.deepEqual(calls, ["raw"]);
  assert.equal(scheduler.scheduled.length, 1);
  assert.equal(scheduler.scheduled[0]!.delayMs, 1000);
  assert.equal(scheduler.scheduled[0]!.unrefCalled, true);

  scheduler.scheduled.shift()!.callback();
  await Promise.resolve();
  assert.deepEqual(calls, ["raw", "raw"]);
  assert.equal(scheduler.scheduled.length, 0);
});

test("raw retention 오류는 tight loop 대신 backoff 뒤 재시도한다", async () => {
  const scheduler = drainSchedulerFixture();
  let attempts = 0;
  const warnings: string[] = [];
  const controller = createPostgresRawRetentionDrain({
    prunePostgresRawEvents: async () => {
      attempts++;
      if (attempts === 1) throw new Error("raw unavailable");
      return { rawEvents: 0 };
    },
    now: () => new Date("2026-07-12T00:01:00.000Z"),
    schedule: scheduler.schedule,
    clear: scheduler.clear,
    warn: (message) => warnings.push(message),
    batchLimit: 1000,
    followupDelayMs: 1000,
    errorBackoffMs: 60_000,
  });

  await assert.rejects(controller.run(), /raw unavailable/);
  assert.equal(attempts, 1);
  assert.equal(scheduler.scheduled.length, 1);
  assert.equal(scheduler.scheduled[0]!.delayMs, 60_000);

  scheduler.scheduled.shift()!.callback();
  await Promise.resolve();
  assert.equal(attempts, 2);
  assert.equal(scheduler.scheduled.length, 0);
  assert.deepEqual(warnings, []);
});

test("raw retention drain은 같은 process의 overlap을 건너뛴다", async () => {
  const scheduler = drainSchedulerFixture();
  const batch = deferred<{ rawEvents: number }>();
  let calls = 0;
  const controller = createPostgresRawRetentionDrain({
    prunePostgresRawEvents: async () => {
      calls++;
      return batch.promise;
    },
    now: () => new Date("2026-07-12T00:00:00.000Z"),
    schedule: scheduler.schedule,
    clear: scheduler.clear,
    warn: () => undefined,
    batchLimit: 1000,
    followupDelayMs: 1000,
    errorBackoffMs: 60_000,
  });

  const first = controller.run();
  assert.equal(await controller.run(), "overlap");
  assert.equal(calls, 1);
  batch.resolve({ rawEvents: 1 });
  assert.equal(await first, "completed");
});

test("raw followup은 timer를 unref하고 stop에서 정리할 수 있다", async () => {
  const scheduler = drainSchedulerFixture();
  const controller = createPostgresRawRetentionDrain({
    prunePostgresRawEvents: async () => ({ rawEvents: 1000 }),
    now: () => new Date("2026-07-12T00:00:00.000Z"),
    schedule: scheduler.schedule,
    clear: scheduler.clear,
    warn: () => undefined,
    batchLimit: 1000,
    followupDelayMs: 1000,
    errorBackoffMs: 60_000,
  });

  await controller.run();
  const handle = scheduler.scheduled[0]!;
  assert.equal(handle.unrefCalled, true);
  controller.stop();
  assert.equal(handle.cleared, true);
});

test("raw followup은 raw만 재실행하고 다른 retention cleanup은 daily 1회만 실행한다", async () => {
  const scheduler = drainSchedulerFixture();
  const calls: string[] = [];
  const rawBatches = [1000, 0];
  const controller = createPostgresRawRetentionDrain({
    prunePostgresRawEvents: async () => {
      calls.push("raw");
      return { rawEvents: rawBatches.shift()! };
    },
    now: () => new Date("2026-07-12T00:00:01.000Z"),
    schedule: scheduler.schedule,
    clear: scheduler.clear,
    warn: () => undefined,
    batchLimit: 1000,
    followupDelayMs: 1000,
    errorBackoffMs: 60_000,
  });

  await runUsageRetentionAt(new Date("2026-07-12T00:00:00.000Z"), {
    prunePostgresRawEvents: (now) => controller.run(now),
    pruneTimezoneCoverage: async () => {
      calls.push("coverage");
    },
    pruneClickHouseUsageRetention: async () => {
      calls.push("outbox");
    },
    warn: () => undefined,
  });
  scheduler.scheduled.shift()!.callback();
  await Promise.resolve();

  assert.deepEqual(calls, ["raw", "coverage", "outbox", "raw"]);
});

test("coverage cutoff은 DST를 통과하는 local day 경계를 사용한다", () => {
  const timezone = "America/Los_Angeles";
  const now = new Date("2026-11-02T12:00:00.000Z");
  const cutoffs = timezoneCoverageCutoffs(timezone, now);

  assert.equal(
    cutoffs.day.toISOString(),
    firstInstantOfLocalDate(addLocalCalendarDays("2026-11-02", -399), timezone).toISOString(),
  );
  assert.equal(
    cutoffs.hour.toISOString(),
    firstInstantOfLocalDate(addLocalCalendarDays("2026-11-02", -31), timezone).toISOString(),
  );
  assert.notEqual(now.getTime() - cutoffs.hour.getTime(), 31 * 24 * 60 * 60 * 1000);
});

test("coverage cleanup은 최대 64개 registry timezone의 local window 밖만 unnest로 삭제한다", async () => {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const timezones = Array.from({ length: 65 }, (_, index) => ({
    timezone: index === 0 ? "America/Los_Angeles" : `Etc/GMT+${(index % 12) + 1}`,
  }));
  const pool = {
    async query(sql: string, params: unknown[] = []) {
      queries.push({ sql, params });
      if (sql.includes("FROM clickhouse_rollup_timezones")) {
        return { rows: timezones, rowCount: timezones.length };
      }
      return { rows: [], rowCount: 7 };
    },
  };

  const result = await pruneTimezoneCoverageAt(
    pool,
    new Date("2026-11-02T12:00:00.000Z"),
  );

  assert.equal(result.timezoneCoverage, 7);
  assert.match(queries[0]!.sql, /ORDER BY[\s\S]*LIMIT \$1/);
  assert.deepEqual(queries[0]!.params, [64]);
  assert.match(
    queries[1]!.sql,
    /DELETE FROM clickhouse_timezone_rollup_coverage[\s\S]*unnest\(\$1::text\[\], \$2::text\[\], \$3::timestamptz\[\]\)/,
  );
  const [resolutions, requestedTimezones, cutoffs] = queries[1]!.params as [
    string[],
    string[],
    Date[],
  ];
  assert.equal(resolutions.length, 128);
  assert.equal(requestedTimezones.length, 128);
  assert.equal(cutoffs.length, 128);
  assert.deepEqual(resolutions.slice(0, 2), ["hour", "day"]);
  assert.deepEqual(requestedTimezones.slice(0, 2), [
    "America/Los_Angeles",
    "America/Los_Angeles",
  ]);
  assert.equal(
    cutoffs[1]!.toISOString(),
    firstInstantOfLocalDate("2025-09-29", "America/Los_Angeles").toISOString(),
  );
  assert.doesNotMatch(
    queries.map(({ sql }) => sql).join("\n"),
    /(?:UPDATE|DELETE FROM) clickhouse_timezone_rollup_jobs/,
  );
});

test("일일 retention은 cleanup 실패를 격리해 나머지 cleanup을 계속 실행한다", async () => {
  const calls: string[] = [];
  const dependencies: UsageRetentionDependencies = {
    prunePostgresRawEvents: async () => {
      calls.push("raw");
      throw new Error("raw unavailable");
    },
    pruneTimezoneCoverage: async () => {
      calls.push("coverage");
      return { timezoneCoverage: 3 };
    },
    pruneClickHouseUsageRetention: async () => {
      calls.push("outbox");
      throw new Error("outbox unavailable");
    },
    warn: () => undefined,
  };

  const result = await runUsageRetentionAt(
    new Date("2026-07-12T00:00:00.000Z"),
    dependencies,
  );

  assert.deepEqual(calls, ["raw", "coverage", "outbox"]);
  assert.deepEqual(result, {
    postgresRawEvents: "failed",
    timezoneCoverage: "completed",
    clickhouseUsage: "failed",
  });
});

test("retention scheduler는 Vercel을 제외한 production backend에서만 기동한다", () => {
  assert.equal(retentionSchedulerEligible({ NODE_ENV: "production" }), true);
  assert.equal(
    retentionSchedulerEligible({ NODE_ENV: "production", STORAGE_BACKEND: "postgres" }),
    true,
  );
  assert.equal(
    retentionSchedulerEligible({ NODE_ENV: "production", STORAGE_BACKEND: "clickhouse" }),
    true,
  );
  assert.equal(retentionSchedulerEligible({ NODE_ENV: "development" }), false);
  assert.equal(retentionSchedulerEligible({ NODE_ENV: "production", VERCEL: "1" }), false);
});

test("instrumentation은 공통 retention scheduler를 연결하고 outbox worker는 중복 interval을 두지 않는다", () => {
  const instrumentation = readFileSync(new URL("../instrumentation.ts", import.meta.url), "utf8");
  const outbox = readFileSync(new URL("./clickhouse-outbox.ts", import.meta.url), "utf8");

  assert.match(
    instrumentation,
    /retentionSchedulerEligible[\s\S]*startUsageRetentionCleanup/,
  );
  assert.match(
    instrumentation,
    /retentionSchedulerEligible\(process\.env\)[\s\S]*startUsageRetentionCleanup\(\)/,
  );
  assert.doesNotMatch(outbox, /RETENTION_TICK_MS|guardedRetentionTick|retentionTick/);
});
