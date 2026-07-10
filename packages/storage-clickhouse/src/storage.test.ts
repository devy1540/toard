import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import type { ClickHouseClient } from "@clickhouse/client";
import {
  addLocalCalendarDays,
  canonicalTimezoneId,
  firstInstantOfLocalDate,
  type FinalizedUsageEvent,
} from "@toard/core";
import type { Pool, PoolClient } from "pg";
import { ClickHouseStorage } from "./storage";

type InsertedRows = { table: string; values: Array<Record<string, unknown>> };

function finalizedEvent(
  overrides: Partial<FinalizedUsageEvent> = {},
): FinalizedUsageEvent {
  return {
    dedupKey: "event-1",
    providerKey: "anthropic",
    userId: null,
    sessionId: "session-1",
    model: "claude-sonnet-4",
    ts: new Date("2026-07-10T10:05:00.000Z"),
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 5,
    cacheCreationTokens: 3,
    costUsd: 0.0123,
    pricingRevisionId: "rev-1",
    costStatus: "priced",
    logAdapter: "claude",
    host: "macbook",
    ...overrides,
  };
}

function storageWithInsertedRows(
  inserts: InsertedRows[],
  pgQueries: Array<{ sql: string; params: unknown[] }> = [],
): ClickHouseStorage {
  const outboxRows: Array<Record<string, unknown>> = [];
  let pendingBatch = true;
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      pgQueries.push({ sql, params });
      const normalized = sql.replace(/\s+/g, " ").trim();
      if (normalized.startsWith("INSERT INTO clickhouse_usage_batches")) {
        return { rows: [{ id: "batch-1" }], rowCount: 1 };
      }
      if (normalized.startsWith("INSERT INTO clickhouse_usage_outbox")) {
        outboxRows.push({
          dedup_key: params[0],
          provider_key: params[2],
          user_id: params[3],
          team_id: params[4],
          session_id: params[5],
          model: params[6],
          ts: params[7],
          input_tokens: String(params[8]),
          output_tokens: String(params[9]),
          cache_read_tokens: String(params[10]),
          cache_creation_tokens: String(params[11]),
          cost_usd: String(params[12]),
          log_adapter: params[13],
          host: params[14],
          pricing_revision_id: params[15],
          cost_status: params[16],
        });
        return { rows: [], rowCount: 1 };
      }
      if (normalized.includes("UPDATE clickhouse_usage_batches b")) {
        if (!pendingBatch) return { rows: [], rowCount: 0 };
        pendingBatch = false;
        return {
          rows: [{ id: "batch-1", insertToken: "insert-token-1" }],
          rowCount: 1,
        };
      }
      if (normalized.startsWith("SELECT dedup_key")) {
        return { rows: outboxRows, rowCount: outboxRows.length };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  } as unknown as PoolClient;
  const pg = {
    connect: async () => client,
  } as unknown as Pool;
  const ch = {
    command: async () => undefined,
    insert: async ({ table, values }: { table: string; values: Array<Record<string, unknown>> }) => {
      inserts.push({ table, values });
    },
  } as unknown as ClickHouseClient;
  return new ClickHouseStorage(ch, pg);
}

function v2CompactorFixture(): {
  storage: ClickHouseStorage;
  aggregateQueries: string[];
  inserts: InsertedRows[];
  pgQueries: string[];
} {
  const aggregateQueries: string[] = [];
  const inserts: InsertedRows[] = [];
  const pgQueries: string[] = [];
  const bucket = new Date(Math.floor((Date.now() - 2 * 60 * 60 * 1000) / (15 * 60 * 1000)) * (15 * 60 * 1000));
  let watermark = bucket;
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      pgQueries.push(sql);
      const normalized = sql.replace(/\s+/g, " ").trim();
      if (normalized.startsWith("SELECT watermark")) {
        return { rows: [{ watermark }], rowCount: 1 };
      }
      if (normalized.startsWith("SELECT bucket")) {
        return { rows: [], rowCount: 0 };
      }
      if (normalized.startsWith("UPDATE clickhouse_rollup_watermarks")) {
        watermark = params[1] as Date;
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  } as unknown as PoolClient;
  const pg = {
    connect: async () => client,
  } as unknown as Pool;
  const ch = {
    command: async () => undefined,
    query: async ({ query }: { query: string }) => {
      aggregateQueries.push(query);
      return {
        json: async () => [{
          bucket_15m: bucket.toISOString().replace("T", " ").replace("Z", ""),
          provider_key: "anthropic",
          user_id: "user-1",
          team_id: "team-1",
          session_id: "session-1",
          model: "claude-sonnet-4",
          host: "macbook",
          pricing_revision_id: "rev-1",
          cost_status: "priced",
          event_count: "1",
          input_tokens: "100",
          output_tokens: "20",
          cache_read_tokens: "5",
          cache_creation_tokens: "3",
          cost_usd: "0.01230000",
        }],
      };
    },
    insert: async ({ table, values }: { table: string; values: Array<Record<string, unknown>> }) => {
      inserts.push({ table, values });
    },
  } as unknown as ClickHouseClient;
  return { storage: new ClickHouseStorage(ch, pg), aggregateQueries, inserts, pgQueries };
}

type RouterJobStatus = "pending" | "inflight" | "done";

function sourceRouterFixture({
  active = true,
  dirtyBucket = null,
  jobs = [],
  watermark,
  read15mV2Rollup = true,
}: {
  active?: boolean;
  dirtyBucket?: Date | null;
  jobs?: Array<{ bucket: Date; status: RouterJobStatus }>;
  watermark: Date;
  read15mV2Rollup?: boolean;
}) {
  const queries: Array<{ query: string; params: Record<string, unknown> }> = [];
  const pgQueries: Array<{ sql: string; params: unknown[] }> = [];
  const pg = {
    query: async (sql: string, params: unknown[] = []) => {
      pgQueries.push({ sql, params });
      if (sql.includes("FROM clickhouse_rollup_timezones")) {
        return { rows: active ? [{ timezone: params[0] }] : [], rowCount: active ? 1 : 0 };
      }
      if (sql.includes("FROM clickhouse_rollup_watermarks")) {
        return { rows: [{ watermark }], rowCount: 1 };
      }
      if (sql.includes("FROM clickhouse_rollup_dirty_buckets")) {
        const from = (params[1] as Date).getTime();
        const to = (params[2] as Date).getTime();
        const selected = dirtyBucket && dirtyBucket.getTime() >= from && dirtyBucket.getTime() < to
          ? [{ bucket: dirtyBucket }]
          : [];
        return { rows: selected, rowCount: selected.length };
      }
      if (sql.includes("FROM clickhouse_timezone_rollup_jobs")) {
        const from = (params[2] as Date).getTime();
        const to = (params[3] as Date).getTime();
        const selected = jobs.filter(({ bucket }) => bucket.getTime() >= from && bucket.getTime() < to);
        return { rows: selected, rowCount: selected.length };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  const ch = {
    command: async () => undefined,
    query: async (args: { query: string; query_params: Record<string, unknown> }) => {
      queries.push({ query: args.query, params: args.query_params });
      return { json: async () => [] };
    },
  } as unknown as ClickHouseClient;
  return {
    storage: new ClickHouseStorage(ch, pg, {
      readRollup: true,
      read15mV2Rollup,
    }),
    queries,
    pgQueries,
  };
}

function localDayRange(timezone: string, date: string, days: number) {
  const canonical = canonicalTimezoneId(timezone);
  assert.ok(canonical);
  const from = firstInstantOfLocalDate(date, canonical);
  const jobs = Array.from({ length: days }, (_, index) => ({
    bucket: firstInstantOfLocalDate(addLocalCalendarDays(date, index), canonical),
    status: "done" as const,
  }));
  const to = firstInstantOfLocalDate(addLocalCalendarDays(date, days), canonical);
  return { from, to, jobs };
}

function hourlyJobs(from: Date, to: Date) {
  const jobs: Array<{ bucket: Date; status: "done" }> = [];
  for (let at = from.getTime(); at < to.getTime(); at += 60 * 60 * 1000) {
    jobs.push({ bucket: new Date(at), status: "done" });
  }
  return jobs;
}

async function schemaCommands(
  opts: ConstructorParameters<typeof ClickHouseStorage>[2] = {},
): Promise<string[]> {
  const commands: string[] = [];
  const ch = {
    command: async ({ query }: { query: string }) => {
      commands.push(query);
    },
    query: async () => ({ json: async () => [] }),
  } as unknown as ClickHouseClient;
  const storage = new ClickHouseStorage(ch, {} as Pool, opts);
  await storage.getTeamMemberTimeseries({
    from: new Date("2026-07-10T00:00:00.000Z"),
    to: new Date("2026-07-11T00:00:00.000Z"),
    bucket: "15m",
    timezone: "UTC",
    teamId: "team-1",
    userIds: ["user-1"],
  });
  return commands;
}

test("인사이트 query log 표식은 SQL 주석 제거 후에도 남는 문자열 리터럴이다", async () => {
  const queries: string[] = [];
  const ch = {
    command: async () => ({}),
    query: async ({ query }: { query: string }) => {
      queries.push(query);
      return { json: async () => [] };
    },
  } as unknown as ClickHouseClient;
  const storage = new ClickHouseStorage(ch, {} as Pool, { timezone: "UTC" });

  await storage.getUserInsightComparison("user-1", {
    previous: { from: new Date("2026-01-01T00:00:00.000Z"), to: new Date("2026-01-08T00:00:00.000Z") },
    current: { from: new Date("2026-01-08T00:00:00.000Z"), to: new Date("2026-01-15T00:00:00.000Z") },
    timezone: "UTC",
  });

  assert.equal(queries.length, 2);
  for (const query of queries) {
    assert.match(query, /WITH\s+'\/\* user-insights \*\/'\s+AS\s+query_tag/);
  }
});

test("ClickHouseStorage groups team member usage by bucket and user", async () => {
  let query = "";
  let queryParams: Record<string, unknown> = {};
  const ch = {
    command: async () => undefined,
    query: async (args: { query: string; query_params: Record<string, unknown> }) => {
      query = args.query;
      queryParams = args.query_params;
      return {
        json: async () => [
          {
            day: "2026-07-06",
            user_id: "u1",
            sessions: "2",
            active_users: "1",
            cost: "0.42",
            input: "30",
            output: "10",
            cache_read: "5",
            cache_creation: "0",
          },
        ],
      };
    },
  } as unknown as ClickHouseClient;

  const result = await new ClickHouseStorage(ch, {} as Pool).getTeamMemberTimeseries({
    from: new Date("2026-07-06T00:00:00.000Z"),
    to: new Date("2026-07-08T00:00:00.000Z"),
    bucket: "day",
    timezone: "UTC",
    teamId: "team-1",
    userIds: ["u1", "u2"],
  });

  assert.match(query, /team_id = \{did:String\}/);
  assert.match(query, /user_id IN \{userIds:Array\(String\)\}/);
  assert.match(query, /GROUP BY day, user_id ORDER BY day, user_id/);
  assert.deepEqual(queryParams.userIds, ["u1", "u2"]);
  assert.deepEqual(result, [
    {
      userId: "u1",
      day: "2026-07-06",
      sessions: 2,
      activeUsers: 1,
      costUsd: 0.42,
      inputTokens: 30,
      outputTokens: 10,
      cacheReadTokens: 5,
      cacheCreationTokens: 0,
    },
  ]);
});

test("ClickHouse outbox raw insert는 pricing revision과 status를 보존한다", async () => {
  const inserts: InsertedRows[] = [];
  const pgQueries: Array<{ sql: string; params: unknown[] }> = [];
  const storage = storageWithInsertedRows(inserts, pgQueries);

  await storage.saveUsageEvents([
    finalizedEvent(),
    finalizedEvent({
      dedupKey: "event-2",
      pricingRevisionId: null,
      costStatus: "unpriced",
      costUsd: 0,
    }),
    finalizedEvent({
      dedupKey: "event-3",
      pricingRevisionId: null,
      costStatus: "legacy",
    }),
  ]);
  await storage.flushUsageOutbox();

  const rawRows = inserts.find((x) => x.table === "usage_events")?.values;
  assert.deepEqual(
    rawRows?.map((row) => [row.pricing_revision_id, row.cost_status]),
    [
      ["rev-1", "priced"],
      ["", "unpriced"],
      ["", "legacy"],
    ],
  );
  assert.deepEqual(
    pgQueries
      .filter(({ sql }) => sql.includes("INSERT INTO clickhouse_rollup_dirty_buckets"))
      .map(({ params }) => params[0]),
    ["usage_15m", "usage_15m_v2"],
  );
});

test("finalizer가 90일 초과 이벤트를 제외해 빈 배열을 넘기면 v2 dirty와 watermark를 건드리지 않는다", async () => {
  const pgQueries: Array<{ sql: string; params: unknown[] }> = [];
  const storage = storageWithInsertedRows([], pgQueries);

  assert.deepEqual(await storage.saveUsageEvents([]), { inserted: 0, deduped: 0 });
  assert.equal(
    pgQueries.some(({ sql }) => /clickhouse_rollup_(dirty_buckets|watermarks)/.test(sql)),
    false,
  );
});

test("v2 compactor는 가격 차원을 보존하고 unpriced 비용을 제외한다", async () => {
  const { storage, aggregateQueries, inserts, pgQueries } = v2CompactorFixture();
  const compact = (storage as unknown as {
    compactUsage15mV2?: (limitBuckets?: number) => Promise<{ buckets: number; rows: number; watermark: string }>;
  }).compactUsage15mV2;

  assert.equal(typeof compact, "function");
  if (!compact) return;
  await compact.call(storage, 1);

  const aggregate = aggregateQueries.find((query) => query.includes("GROUP BY bucket_15m"));
  assert.ok(aggregate);
  assert.match(aggregate, /FROM usage_events FINAL/);
  assert.match(aggregate, /pricing_revision_id/);
  assert.match(aggregate, /cost_status/);
  assert.match(aggregate, /sumIf\(cost_usd, cost_status != 'unpriced'\) AS cost_usd/);
  assert.match(
    aggregate,
    /GROUP BY bucket_15m, provider_key, user_id, team_id, session_id, model, host, pricing_revision_id, cost_status/,
  );
  const inserted = inserts.find(({ table }) => table === "usage_15m_rollup_v2");
  assert.ok(inserted);
  assert.equal(inserted.values[0]?.pricing_revision_id, "rev-1");
  assert.equal(inserted.values[0]?.cost_status, "priced");

  const timezoneJobs = pgQueries.find((query) => query.includes("INSERT INTO clickhouse_timezone_rollup_jobs"));
  assert.ok(timezoneJobs);
  assert.match(timezoneJobs, /date_trunc\(resolution, bucket, timezone\)/);
  assert.match(timezoneJobs, /ON CONFLICT \(resolution, timezone, bucket\) DO UPDATE/);
  assert.match(timezoneJobs, /status = 'pending'/);
});

test("v1 compactor는 기존 dashboard raw source 정책을 보존한다", async () => {
  const { storage, aggregateQueries, pgQueries } = v2CompactorFixture();

  await storage.compactUsage15mRollup(1);

  const aggregate = aggregateQueries.find((query) => query.includes("GROUP BY bucket_15m"));
  assert.ok(aggregate);
  assert.match(aggregate, /FROM usage_events\s+WHERE/);
  assert.doesNotMatch(aggregate, /FROM usage_events FINAL/);
  assert.equal(pgQueries.some((query) => query.includes("INSERT INTO clickhouse_timezone_rollup_jobs")), false);
});

test("v2 15분 조회는 dirty bucket부터 raw tail로 fallback한다", async () => {
  const queries: Array<{ query: string; params: Record<string, unknown> }> = [];
  const pg = {
    query: async (sql: string) => {
      if (sql.includes("SELECT watermark")) {
        return { rows: [{ watermark: new Date("2026-04-15T11:00:00.000Z") }] };
      }
      if (sql.includes("SELECT min(bucket)")) {
        return { rows: [{ bucket: new Date("2026-04-15T10:15:00.000Z") }] };
      }
      return { rows: [] };
    },
  } as unknown as Pool;
  const ch = {
    command: async () => undefined,
    query: async (args: { query: string; query_params: Record<string, unknown> }) => {
      queries.push({ query: args.query, params: args.query_params });
      return { json: async () => [] };
    },
  } as unknown as ClickHouseClient;
  const storage = new ClickHouseStorage(ch, pg, { read15mV2Rollup: true } as never);

  await storage.getDailyTimeseries({
    from: new Date("2026-04-15T09:00:00.000Z"),
    to: new Date("2026-04-15T11:00:00.000Z"),
    bucket: "15m",
    timezone: "UTC",
  });

  assert.equal(queries.length, 1);
  assert.match(queries[0]!.query, /FROM usage_15m_rollup_v2/);
  assert.match(queries[0]!.query, /ts >= \{rollupTo:DateTime64\(3\)\}/);
  assert.equal(queries[0]!.params.rollupTo, "2026-04-15 10:15:00.000");
});

test("활성 Seoul 시간대의 12개월 일별 요청은 ready timezone-day source를 사용한다", async () => {
  const range = localDayRange("Asia/Seoul", "2025-07-02", 365);
  const { storage, queries } = sourceRouterFixture({
    watermark: range.to,
    jobs: range.jobs,
  });

  await storage.getDailyTimeseries({
    from: range.from,
    to: range.to,
    bucket: "day",
    timezone: "Asia/Seoul",
  });

  assert.equal(queries.length, 1);
  assert.match(queries[0]!.query, /FROM usage_daily_timezone_rollup FINAL/);
  assert.match(queries[0]!.query, /bucket_start >= \{from:DateTime64\(3\)\}/);
  assert.match(queries[0]!.query, /bucket_start < \{to:DateTime64\(3\)\}/);
  assert.match(queries[0]!.query, /formatDateTime\(bucket_start, '%Y-%m-%d', 'Asia\/Seoul'\)/);
  assert.doesNotMatch(queries[0]!.query, /usage_15m_rollup_v2|usage_events|usage_hourly_rollup/);
  assert.equal(queries[0]!.params.timezone, "Asia/Seoul");
});

test("다섯 IANA 시간대의 ready day cache는 canonical source와 DST local label을 보존한다", async () => {
  const cases = [
    ["UTC", "2026-07-01"],
    ["Asia/Seoul", "2026-07-01"],
    ["Asia/Kathmandu", "2026-07-01"],
    ["America/Los_Angeles", "2026-03-08"],
    ["America/Santiago", "2025-09-07"],
  ] as const;

  for (const [timezone, date] of cases) {
    const range = localDayRange(timezone, date, 1);
    const { storage, queries } = sourceRouterFixture({ watermark: range.to, jobs: range.jobs });
    await storage.getDailyTimeseries({ ...range, bucket: "day", timezone });

    const canonical = canonicalTimezoneId(timezone);
    assert.ok(canonical);
    assert.match(queries[0]!.query, /FROM usage_daily_timezone_rollup FINAL/);
    assert.match(queries[0]!.query, new RegExp(`formatDateTime\\(bucket_start, '%Y-%m-%d', '${canonical.replace("/", "\\/")}'\\)`));
    assert.equal(queries[0]!.params.timezone, canonical);
    assert.equal(queries[0]!.params.from, range.from.toISOString().replace("T", " ").replace("Z", ""));
    assert.equal(queries[0]!.params.to, range.to.toISOString().replace("T", " ").replace("Z", ""));
  }
});

test("DST 전환일의 ready hour cache는 bucket_start를 반열린 범위로 직접 조회한다", async () => {
  const range = localDayRange("America/Los_Angeles", "2026-03-08", 1);
  const { storage, queries } = sourceRouterFixture({
    watermark: range.to,
    jobs: hourlyJobs(range.from, range.to),
  });

  await storage.getDailyTimeseries({
    from: range.from,
    to: range.to,
    bucket: "hour",
    timezone: "America/Los_Angeles",
  });

  assert.match(queries[0]!.query, /FROM usage_hourly_timezone_rollup FINAL/);
  assert.match(queries[0]!.query, /bucket_start >= \{from:DateTime64\(3\)\}/);
  assert.match(queries[0]!.query, /bucket_start < \{to:DateTime64\(3\)\}/);
  assert.match(queries[0]!.query, /formatDateTime\(bucket_start, '%Y-%m-%d %H:00', 'America\/Los_Angeles'\)/);
  assert.doesNotMatch(queries[0]!.query, /toStartOfInterval\(bucket_start/);
  assert.equal(hourlyJobs(range.from, range.to).length, 23);
});

test("inactive Kathmandu는 exact 15분 v2 source를 요청 IANA 시간대로 그룹화한다", async () => {
  const range = localDayRange("Asia/Kathmandu", "2026-07-01", 1);
  const { storage, queries } = sourceRouterFixture({
    active: false,
    watermark: range.to,
  });

  await storage.getDailyTimeseries({
    from: range.from,
    to: range.to,
    bucket: "day",
    timezone: "Asia/Kathmandu",
  });

  assert.match(queries[0]!.query, /FROM usage_15m_rollup_v2/);
  assert.match(queries[0]!.query, /formatDateTime\(ts, '%Y-%m-%d', 'Asia\/Kathmandu'\)/);
  assert.doesNotMatch(queries[0]!.query, /usage_daily_timezone_rollup|usage_hourly_rollup/);
});

test("active all 요청은 완성 과거 day cache와 오늘의 exact 15분·raw tail을 합친다", async () => {
  const cached = localDayRange("America/Los_Angeles", "2025-07-10", 365);
  const to = new Date(cached.to.getTime() + 12 * 60 * 60 * 1000 + 34 * 60 * 1000);
  const watermark = new Date(to.getTime() - 4 * 60 * 1000);
  const { storage, queries } = sourceRouterFixture({ watermark, jobs: cached.jobs });

  await storage.getDailyTimeseries({
    from: cached.from,
    to,
    bucket: "day",
    timezone: "America/Los_Angeles",
  });

  const query = queries[0]!;
  assert.match(query.query, /usage_daily_timezone_rollup FINAL/);
  assert.match(query.query, /usage_15m_rollup_v2/);
  assert.match(query.query, /UNION ALL/);
  assert.equal(query.params.cache_from, cached.from.toISOString().replace("T", " ").replace("Z", ""));
  assert.equal(query.params.cache_to, cached.to.toISOString().replace("T", " ").replace("Z", ""));
  assert.equal(query.params.tail_from, query.params.cache_to);
  assert.equal(query.params.tail_to, to.toISOString().replace("T", " ").replace("Z", ""));
  assert.equal(query.params.from, undefined);
});

test("unaligned 요청은 exact head·ready day cache·exact tail을 겹침 없이 같은 schema로 합친다", async () => {
  const range = localDayRange("Asia/Seoul", "2026-07-01", 4);
  const from = new Date(range.from.getTime() + 12 * 60 * 60 * 1000);
  const cacheFrom = range.jobs[1]!.bucket;
  const cacheTo = range.jobs[3]!.bucket;
  const to = new Date(cacheTo.getTime() + 12 * 60 * 60 * 1000);
  const { storage, queries } = sourceRouterFixture({ watermark: to, jobs: range.jobs });

  await storage.getDailyTimeseries({ from, to, bucket: "day", timezone: "Asia/Seoul" });

  const query = queries[0]!;
  assert.match(query.query, /usage_daily_timezone_rollup FINAL/);
  assert.ok((query.query.match(/usage_15m_rollup_v2/g) ?? []).length >= 2);
  assert.equal(query.params.head_from, from.toISOString().replace("T", " ").replace("Z", ""));
  assert.equal(query.params.head_to, cacheFrom.toISOString().replace("T", " ").replace("Z", ""));
  assert.equal(query.params.cache_from, query.params.head_to);
  assert.equal(query.params.cache_to, cacheTo.toISOString().replace("T", " ").replace("Z", ""));
  assert.equal(query.params.tail_from, query.params.cache_to);
  assert.equal(query.params.tail_to, to.toISOString().replace("T", " ").replace("Z", ""));
  assert.match(
    query.query,
    /SELECT ts, provider_key, user_id, team_id, session_id, model, host,[\s\S]*cost_usd[\s\S]*UNION ALL/,
  );
});

test("현재 partial hour도 ready hour cache와 exact tail로 분할한다", async () => {
  const day = localDayRange("America/Los_Angeles", "2026-03-08", 1);
  const cacheTo = new Date(day.from.getTime() + 12 * 60 * 60 * 1000);
  const to = new Date(cacheTo.getTime() + 34 * 60 * 1000);
  const watermark = new Date(to.getTime() - 4 * 60 * 1000);
  const { storage, queries } = sourceRouterFixture({
    watermark,
    jobs: hourlyJobs(day.from, cacheTo),
  });

  await storage.getDailyTimeseries({
    from: day.from,
    to,
    bucket: "hour",
    timezone: "America/Los_Angeles",
  });

  const query = queries[0]!;
  assert.match(query.query, /usage_hourly_timezone_rollup FINAL/);
  assert.match(query.query, /usage_15m_rollup_v2/);
  assert.equal(query.params.cache_to, cacheTo.toISOString().replace("T", " ").replace("Z", ""));
  assert.equal(query.params.tail_from, query.params.cache_to);
  assert.equal(query.params.tail_to, to.toISOString().replace("T", " ").replace("Z", ""));
});

test("pending·inflight·누락·dirty·watermark 미완료 cache는 절대 선택하지 않는다", async () => {
  const range = localDayRange("Asia/Seoul", "2026-07-01", 2);
  const incomplete = [
    { name: "pending", jobs: [{ ...range.jobs[0]!, status: "pending" as const }, range.jobs[1]!] },
    { name: "inflight", jobs: [{ ...range.jobs[0]!, status: "inflight" as const }, range.jobs[1]!] },
    { name: "missing", jobs: [range.jobs[1]!] },
    { name: "dirty", jobs: range.jobs, dirtyBucket: new Date(range.from.getTime() + 15 * 60 * 1000) },
    { name: "watermark", jobs: range.jobs, watermark: new Date(range.jobs[1]!.bucket.getTime() - 15 * 60 * 1000) },
  ];

  for (const state of incomplete) {
    const { storage, queries, pgQueries } = sourceRouterFixture({
      watermark: state.watermark ?? range.to,
      dirtyBucket: state.dirtyBucket,
      jobs: state.jobs,
    });
    await storage.getDailyTimeseries({
      from: range.from,
      to: range.to,
      bucket: "day",
      timezone: "Asia/Seoul",
    });
    assert.match(queries[0]!.query, /usage_15m_rollup_v2|usage_events/, state.name);
    assert.doesNotMatch(queries[0]!.query, /usage_daily_timezone_rollup/, state.name);
    assert.equal(
      pgQueries.some(({ sql }) => sql.includes("FROM clickhouse_rollup_timezones")),
      true,
      `${state.name}: canonical registry 확인`,
    );
    if (state.name === "pending" || state.name === "inflight" || state.name === "missing") {
      assert.equal(
        pgQueries.some(({ sql }) => sql.includes("FROM clickhouse_timezone_rollup_jobs")),
        true,
        `${state.name}: 완료 job 범위 확인`,
      );
    }
  }
});

test("두 번째 cache bucket이 inflight면 첫 bucket만 cache하고 나머지는 exact tail로 읽는다", async () => {
  const range = localDayRange("Asia/Seoul", "2026-07-01", 2);
  const jobs = [range.jobs[0]!, { ...range.jobs[1]!, status: "inflight" as const }];
  const { storage, queries } = sourceRouterFixture({ watermark: range.to, jobs });

  await storage.getDailyTimeseries({
    from: range.from,
    to: range.to,
    bucket: "day",
    timezone: "Asia/Seoul",
  });

  const query = queries[0]!;
  assert.match(query.query, /usage_daily_timezone_rollup FINAL/);
  assert.match(query.query, /usage_15m_rollup_v2/);
  assert.equal(query.params.cache_from, range.from.toISOString().replace("T", " ").replace("Z", ""));
  assert.equal(query.params.cache_to, range.jobs[1]!.bucket.toISOString().replace("T", " ").replace("Z", ""));
  assert.equal(query.params.tail_from, query.params.cache_to);
  assert.equal(query.params.tail_to, range.to.toISOString().replace("T", " ").replace("Z", ""));
});

test("모든 dashboard 집계는 공통 router의 15분 v2 fallback을 사용한다", async () => {
  const range = localDayRange("Asia/Kathmandu", "2026-07-01", 1);
  const { storage, queries } = sourceRouterFixture({ active: false, watermark: range.to });
  const period = { from: range.from, to: range.to, bucket: "day" as const, timezone: "Asia/Kathmandu" };

  await storage.getOverview(period);
  await storage.getDailyTimeseries(period);
  await storage.getUserModelTimeseries("user-1", period);
  await storage.getTeamMemberTimeseries({ ...period, teamId: "team-1", userIds: ["user-1"] });
  await storage.getUserUsage("user-1", period);
  await storage.getLeaderboard({ ...period, scope: "user" });
  await storage.getProviderBreakdown(period);

  assert.equal(queries.length, 10);
  for (const { query } of queries) {
    assert.match(query, /FROM[\s\S]*usage_15m_rollup_v2/);
    assert.doesNotMatch(query, /usage_hourly_rollup/);
  }
});

test("인사이트의 current·previous 집계도 공통 router의 ready timezone-day source를 사용한다", async () => {
  const range = localDayRange("Asia/Seoul", "2026-07-01", 2);
  const { storage, queries } = sourceRouterFixture({ watermark: range.to, jobs: range.jobs });

  await storage.getUserInsightComparison("user-1", {
    previous: { from: range.jobs[0]!.bucket, to: range.jobs[1]!.bucket },
    current: { from: range.jobs[1]!.bucket, to: range.to },
    timezone: "Asia/Seoul",
  });

  assert.equal(queries.length, 2);
  for (const { query } of queries) {
    assert.equal((query.match(/usage_daily_timezone_rollup FINAL/g) ?? []).length, 2);
    assert.doesNotMatch(query, /usage_15m_rollup(?:_v2)?|usage_hourly_rollup/);
  }
});

test("v2 read가 꺼진 dashboard router는 hourly가 아니라 raw source로 fallback한다", async () => {
  const range = localDayRange("UTC", "2026-07-01", 1);
  const { storage, queries } = sourceRouterFixture({
    active: false,
    watermark: range.to,
    read15mV2Rollup: false,
  });
  const period = { ...range, bucket: "day" as const, timezone: "UTC" };

  await storage.getOverview(period);

  assert.match(queries[0]!.query, /FROM[\s\S]*usage_events/);
  assert.doesNotMatch(queries[0]!.query, /usage_hourly_rollup|usage_15m_rollup_v2/);
});

test("v2 read와 compactor worker는 서로 독립된 opt-in flag와 실행 guard를 사용한다", () => {
  const storageSource = readFileSync(new URL("./storage.ts", import.meta.url), "utf8");
  const workerSource = readFileSync(new URL("../../../apps/web/lib/clickhouse-outbox.ts", import.meta.url), "utf8");
  const instrumentationSource = readFileSync(new URL("../../../apps/web/instrumentation.ts", import.meta.url), "utf8");

  assert.match(storageSource, /CLICKHOUSE_READ_15M_V2_ROLLUP/);
  assert.match(workerSource, /CLICKHOUSE_15M_V2_COMPACTOR/);
  assert.match(workerSource, /__toardClickHouse15mV2RollupRunning/);
  assert.match(workerSource, /COMPACTOR_TICK_MS\s*=\s*60_000/);
  assert.match(instrumentationSource, /startClickHouse15mV2Compaction/);
});

test("ClickHouse ensure schema는 가격 상태를 가진 400일 15분 v2 테이블을 만든다", async () => {
  const commands = await schemaCommands();
  const rawPricingRevisionDdl = commands.find((query) => /usage_events ADD COLUMN.*pricing_revision_id/.test(query));
  const rawCostStatusDdl = commands.find((query) => /usage_events ADD COLUMN.*cost_status/.test(query));
  const ddl = commands.find((query) => query.includes("usage_15m_rollup_v2"));

  assert.ok(rawPricingRevisionDdl);
  assert.ok(rawCostStatusDdl);
  assert.ok(ddl);
  assert.match(ddl, /pricing_revision_id\s+String/);
  assert.match(ddl, /cost_status\s+LowCardinality\(String\)/);
  assert.match(ddl, /ENGINE\s*=\s*ReplacingMergeTree\(version\)/);
  assert.match(ddl, /TTL\s+toDateTime\(bucket_15m\)\s*\+\s*INTERVAL\s+400\s+DAY\s+DELETE/);
  assert.match(
    ddl,
    /ORDER BY\s*\(bucket_15m, provider_key, user_id, team_id, session_id, model, host, pricing_revision_id, cost_status\)/,
  );
});

test("ClickHouse 기본 schema ensure는 raw 90일 TTL을 변경하지 않는다", async () => {
  const commands = await schemaCommands();

  assert.equal(commands.some((query) => /usage_events\s+MODIFY TTL/i.test(query)), false);
});

test("ClickHouse retention TTL을 명시하면 raw 원본에만 90일 TTL을 적용한다", async () => {
  const commands = await schemaCommands({ enforceRetentionTtl: true });

  assert.equal(
    commands.filter((query) => /usage_events\s+MODIFY TTL\s+ts\s*\+\s*INTERVAL\s+90\s+DAY\s+DELETE/i.test(query)).length,
    1,
  );
});

test("ClickHouse init schema는 가격 상태 원본과 400일 15분 v2 테이블을 선언한다", () => {
  const rawSchema = readFileSync(new URL("../../../clickhouse/init/001-schema.sql", import.meta.url), "utf8");
  const rollupSchema = readFileSync(new URL("../../../clickhouse/init/004-rollup.sql", import.meta.url), "utf8");

  assert.match(rawSchema, /pricing_revision_id\s+String/);
  assert.match(rawSchema, /cost_status\s+LowCardinality\(String\)/);
  assert.match(rollupSchema, /CREATE TABLE IF NOT EXISTS toard\.usage_15m_rollup_v2/);
  assert.match(rollupSchema, /TTL\s+toDateTime\(bucket_15m\)\s*\+\s*INTERVAL\s+400\s+DAY\s+DELETE/);
  assert.match(
    rollupSchema,
    /ORDER BY\s*\(bucket_15m, provider_key, user_id, team_id, session_id, model, host, pricing_revision_id, cost_status\)/,
  );
  assert.doesNotMatch(`${rawSchema}\n${rollupSchema}`, /usage_events[\s\S]*MODIFY TTL/);
});

test("0021 migration은 ClickHouse outbox에 가격 상태 컬럼만 추가한다", () => {
  const migration = new URL("../../../migrations/1700000021_clickhouse_multiresolution.sql", import.meta.url);
  assert.equal(existsSync(migration), true);
  const sql = readFileSync(migration, "utf8");

  assert.match(sql, /ALTER TABLE clickhouse_usage_outbox ADD COLUMN pricing_revision_id UUID/);
  assert.match(sql, /ALTER TABLE clickhouse_usage_outbox ADD COLUMN cost_status TEXT NOT NULL DEFAULT 'legacy'/);
  assert.match(sql, /CHECK \(cost_status IN \('priced', 'unpriced', 'legacy'\)\)/);
});

test("시간대 cache compactor는 v2 15분 canonical source만 소비한다", async () => {
  const queries: Array<{ query: string; params: Record<string, unknown> }> = [];
  const inserts: InsertedRows[] = [];
  const ch = {
    command: async () => undefined,
    query: async (args: { query: string; query_params: Record<string, unknown> }) => {
      queries.push({ query: args.query, params: args.query_params });
      return {
        json: async () => [{
          provider_key: "anthropic",
          user_id: "user-1",
          team_id: "team-1",
          session_id: "session-1",
          model: "claude-sonnet-4",
          host: "macbook",
          pricing_revision_id: "revision-1",
          cost_status: "priced",
          event_count: "4",
          input_tokens: "100",
          output_tokens: "20",
          cache_read_tokens: "5",
          cache_creation_tokens: "3",
          cost_usd: "0.01230000",
        }],
      };
    },
    insert: async ({ table, values }: { table: string; values: Array<Record<string, unknown>> }) => {
      inserts.push({ table, values });
    },
  } as unknown as ClickHouseClient;
  const storage = new ClickHouseStorage(ch, {} as Pool);
  const bucket = new Date("2026-03-08T08:00:00.000Z");

  const rows = await storage.compactTimezoneRollup("day", "America/Los_Angeles", bucket);

  assert.equal(rows, 1);
  const aggregate = queries.find(({ query }) => query.includes("toStartOfDay"));
  assert.ok(aggregate);
  assert.match(aggregate.query, /FROM usage_15m_rollup_v2 FINAL/);
  assert.doesNotMatch(aggregate.query, /usage_events|usage_hourly_rollup/);
  assert.match(aggregate.query, /toStartOfDay\(bucket_15m, 'America\/Los_Angeles'\)/);
  assert.equal(aggregate.params.bucket, "2026-03-08 08:00:00.000");
  assert.equal(aggregate.params.to, "2026-03-09 07:00:00.000");
  assert.equal(inserts[0]?.table, "usage_daily_timezone_rollup");
  assert.equal(inserts[0]?.values[0]?.bucket_start, "2026-03-08 08:00:00.000");
});

test("비정수 offset 시간대의 시간 cache도 timezone 식으로 v2를 집계한다", async () => {
  const queries: string[] = [];
  const ch = {
    command: async () => undefined,
    query: async ({ query }: { query: string }) => {
      queries.push(query);
      return { json: async () => [] };
    },
  } as unknown as ClickHouseClient;
  const storage = new ClickHouseStorage(ch, {} as Pool);

  await storage.compactTimezoneRollup(
    "hour",
    "Asia/Kathmandu",
    new Date("2026-07-01T00:15:00.000Z"),
  );

  const aggregate = queries.find((query) => query.includes("toStartOfInterval"));
  assert.ok(aggregate);
  assert.match(
    aggregate,
    /toStartOfInterval\(bucket_15m, INTERVAL 1 HOUR, 'Asia\/Katmandu'\)/,
  );
  assert.match(aggregate, /FROM usage_15m_rollup_v2 FINAL/);
});

test("timezone capability는 canonical ID로 system.time_zones를 조회한다", async () => {
  const queries: Array<{ query: string; params: Record<string, unknown> }> = [];
  const ch = {
    command: async () => undefined,
    query: async (args: { query: string; query_params: Record<string, unknown> }) => {
      queries.push({ query: args.query, params: args.query_params });
      return { json: async () => [{ supported: "1" }] };
    },
  } as unknown as ClickHouseClient;
  const storage = new ClickHouseStorage(ch, {} as Pool);

  assert.equal(await storage.supportsTimezone("US/Pacific"), true);
  assert.match(queries.at(-1)!.query, /FROM system\.time_zones/);
  assert.equal(queries.at(-1)!.params.timezone, "America/Los_Angeles");
  assert.equal(await storage.supportsTimezone("PST"), false);
});

test("timezone cache row에는 alias가 아닌 canonical timezone ID를 저장한다", async () => {
  const inserts: InsertedRows[] = [];
  const ch = {
    command: async () => undefined,
    query: async () => ({
      json: async () => [{
        provider_key: "anthropic", user_id: "user-1", team_id: "team-1",
        session_id: "session-1", model: "model", host: "host",
        pricing_revision_id: "revision-1", cost_status: "priced",
        event_count: "1", input_tokens: "1", output_tokens: "1",
        cache_read_tokens: "0", cache_creation_tokens: "0", cost_usd: "0.01000000",
      }],
    }),
    insert: async ({ table, values }: { table: string; values: Array<Record<string, unknown>> }) => {
      inserts.push({ table, values });
    },
  } as unknown as ClickHouseClient;
  const storage = new ClickHouseStorage(ch, {} as Pool);

  await storage.compactTimezoneRollup("day", "US/Pacific", new Date("2026-03-08T08:00:00.000Z"));

  assert.equal(inserts.at(-1)?.values[0]?.timezone, "America/Los_Angeles");
});

test("Santiago 자정 gap daily cache는 다음 local date 첫 instant까지 조회한다", async () => {
  const queries: Array<{ query: string; params: Record<string, unknown> }> = [];
  const ch = {
    command: async () => undefined,
    query: async (args: { query: string; query_params: Record<string, unknown> }) => {
      queries.push({ query: args.query, params: args.query_params });
      return { json: async () => [] };
    },
  } as unknown as ClickHouseClient;
  const storage = new ClickHouseStorage(ch, {} as Pool);

  await storage.compactTimezoneRollup(
    "day",
    "America/Santiago",
    new Date("2025-09-07T04:00:00.000Z"),
  );

  const aggregate = queries.find(({ query }) => query.includes("toStartOfDay"));
  assert.ok(aggregate);
  assert.equal(aggregate.params.bucket, "2025-09-07 04:00:00.000");
  assert.equal(aggregate.params.to, "2025-09-08 03:00:00.000");
});

test("ClickHouse runtime/init schema는 timezone cache 2종에 400일 TTL과 exact key를 둔다", async () => {
  const commands = await schemaCommands();
  const init = readFileSync(new URL("../../../clickhouse/init/004-rollup.sql", import.meta.url), "utf8");
  const order = /ORDER BY\s*\(timezone, bucket_start, user_id, team_id, provider_key, model, host, session_id, pricing_revision_id, cost_status\)/;
  const ttl = /TTL\s+toDateTime\(bucket_start\)\s*\+\s*INTERVAL\s+400\s+DAY\s+DELETE/;

  for (const table of ["usage_hourly_timezone_rollup", "usage_daily_timezone_rollup"]) {
    const ddl = commands.find((query) => query.includes(`CREATE TABLE IF NOT EXISTS ${table}`));
    assert.ok(ddl);
    assert.match(ddl, /ENGINE\s*=\s*ReplacingMergeTree\(version\)/);
    assert.match(ddl, order);
    assert.match(ddl, ttl);
    assert.match(init, new RegExp(`CREATE TABLE IF NOT EXISTS toard\\.${table}`));
  }
  assert.equal((init.match(new RegExp(ttl.source, "g")) ?? []).length, 2);
  assert.equal((init.match(new RegExp(order.source, "g")) ?? []).length, 2);
});

test("0022 migration은 최대 활성 registry와 dedup timezone job queue를 선언한다", () => {
  const migration = new URL("../../../migrations/1700000022_clickhouse_timezone_rollup.sql", import.meta.url);
  assert.equal(existsSync(migration), true);
  const sql = readFileSync(migration, "utf8");

  assert.match(sql, /CREATE TABLE clickhouse_rollup_timezones/);
  assert.match(sql, /timezone TEXT PRIMARY KEY/);
  assert.match(sql, /CREATE TABLE clickhouse_timezone_rollup_jobs/);
  assert.match(sql, /CHECK \(resolution IN \('hour', 'day'\)\)/);
  assert.match(sql, /CHECK \(status IN \('pending', 'inflight', 'done'\)\)/);
  assert.match(sql, /UNIQUE \(resolution, timezone, bucket\)/);
});
