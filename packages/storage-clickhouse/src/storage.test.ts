import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import type { ClickHouseClient } from "@clickhouse/client";
import {
  addLocalCalendarDays,
  canonicalTimezoneId,
  firstInstantOfLocalDate,
  type FinalizedUsageEvent,
  type OrganizationDashboardQuery,
  type PricingRepairResolver,
} from "@toard/core";
import type { Pool, PoolClient } from "pg";
import {
  ClickHouseStorage,
  clampV2RollupStart,
  resolveClickHouseRollupReadFlag,
} from "./storage";
import { ClickHouseOperationController } from "./operation-controller";

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
  options: { failEnqueue?: boolean; failInsert?: boolean } = {},
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
      if (normalized.includes("enqueue_pricing_repair")) {
        if (options.failEnqueue) throw new Error("enqueue unavailable");
        return { rows: [], rowCount: 1 };
      }
      if (
        normalized.startsWith("UPDATE clickhouse_usage_batches")
        && normalized.includes("SET status = 'pending'")
      ) {
        pendingBatch = true;
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
      if (options.failInsert && table === "usage_events") throw new Error("clickhouse unavailable");
      inserts.push({ table, values });
    },
  } as unknown as ClickHouseClient;
  return new ClickHouseStorage(ch, pg);
}

function v2CompactorFixture(options: {
  watermark?: Date;
  failAggregate?: boolean;
  dirty?: boolean;
} = {}): {
  storage: ClickHouseStorage;
  aggregateQueries: string[];
  aggregateParams: Array<Record<string, unknown>>;
  inserts: InsertedRows[];
  pgQueries: string[];
  pgCalls: Array<{ sql: string; params: unknown[] }>;
  commands: Array<Record<string, unknown>>;
} {
  const aggregateQueries: string[] = [];
  const aggregateParams: Array<Record<string, unknown>> = [];
  const inserts: InsertedRows[] = [];
  const pgQueries: string[] = [];
  const pgCalls: Array<{ sql: string; params: unknown[] }> = [];
  const commands: Array<Record<string, unknown>> = [];
  const bucket = new Date(Math.floor((Date.now() - 2 * 60 * 60 * 1000) / (15 * 60 * 1000)) * (15 * 60 * 1000));
  let watermark = options.watermark ?? bucket;
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      pgQueries.push(sql);
      pgCalls.push({ sql, params });
      const normalized = sql.replace(/\s+/g, " ").trim();
      if (normalized.startsWith("SELECT watermark")) {
        return { rows: [{ watermark }], rowCount: 1 };
      }
      if (normalized.startsWith("SELECT bucket")) {
        return options.dirty
          ? { rows: [{ bucket }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
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
    command: async (args: Record<string, unknown>) => {
      commands.push(args);
    },
    query: async ({ query, query_params }: { query: string; query_params: Record<string, unknown> }) => {
      aggregateQueries.push(query);
      aggregateParams.push(query_params);
      if (options.failAggregate) throw new Error("aggregate failed");
      const firstBucket = (query_params.buckets as string[] | undefined)?.[0]
        ?? bucket.toISOString().replace("T", " ").replace("Z", "");
      return {
        json: async () => [{
          bucket_15m: firstBucket,
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
  return {
    storage: new ClickHouseStorage(ch, pg),
    aggregateQueries,
    aggregateParams,
    inserts,
    pgQueries,
    pgCalls,
    commands,
  };
}

type RouterJobStatus = "pending" | "inflight" | "done";

function sourceRouterFixture({
  active = true,
  coverageBuckets,
  dirtyBucket = null,
  failRegistryOnce = false,
  jsonRows = [],
  jobs = [],
  watermark,
  readRollup = true,
  read15mV2Rollup = true,
  runtimeStates,
  runtimeStateError = false,
}: {
  active?: boolean;
  coverageBuckets?: Date[];
  dirtyBucket?: Date | null;
  failRegistryOnce?: boolean;
  jsonRows?: Array<Record<string, unknown>> | ((query: string) => Array<Record<string, unknown>>);
  jobs?: Array<{ bucket: Date; status: RouterJobStatus }>;
  watermark: Date;
  readRollup?: boolean | "auto";
  read15mV2Rollup?: boolean | "auto";
  runtimeStates?: Partial<Record<"usage_15m_v2" | "timezone", "active" | "fallback">>;
  runtimeStateError?: boolean;
}) {
  const queries: Array<{ query: string; params: Record<string, unknown> }> = [];
  const pgQueries: Array<{ sql: string; params: unknown[] }> = [];
  let registryFailures = failRegistryOnce ? 1 : 0;
  const pg = {
    query: async (sql: string, params: unknown[] = []) => {
      pgQueries.push({ sql, params });
      if (sql.includes("FROM clickhouse_rollup_cutover_status")) {
        if (runtimeStateError) throw new Error("runtime state unavailable");
        return {
          rows: Object.entries(runtimeStates ?? {}).map(([layer, state]) => ({ layer, state })),
          rowCount: Object.keys(runtimeStates ?? {}).length,
        };
      }
      if (sql.includes("FROM clickhouse_rollup_timezones")) {
        if (registryFailures > 0) {
          registryFailures--;
          throw new Error("transient registry failure");
        }
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
      if (sql.includes("FROM clickhouse_timezone_rollup_coverage")) {
        const from = (params[2] as Date).getTime();
        const to = (params[3] as Date).getTime();
        const available = coverageBuckets ?? jobs
          .filter(({ status }) => status === "done")
          .map(({ bucket }) => bucket);
        const selected = available
          .filter((bucket) => bucket.getTime() >= from && bucket.getTime() < to)
          .map((bucket) => ({ bucket }));
        return { rows: selected, rowCount: selected.length };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  const ch = {
    command: async () => undefined,
    query: async (args: { query: string; query_params: Record<string, unknown> }) => {
      queries.push({ query: args.query, params: args.query_params });
      return { json: async () => typeof jsonRows === "function" ? jsonRows(args.query) : jsonRows };
    },
  } as unknown as ClickHouseClient;
  return {
    storage: new ClickHouseStorage(ch, pg, {
      readRollup,
      read15mV2Rollup,
    }),
    queries,
    pgQueries,
  };
}

type DashboardUsageBundleRow = {
  result_kind: string;
  day: string | null;
  sessions: string;
  active_users: string;
  cost: string;
  input: string;
  output: string;
  cache_read: string;
  cache_creation: string;
  priced_events: string;
  unpriced_events: string;
  legacy_events: string;
};

type DashboardBreakdownBundleRow = {
  result_kind: string;
  key: string;
  cost: string;
  tokens: string;
  sessions: string;
  priced_events: string;
  unpriced_events: string;
  legacy_events: string;
};

function organizationDashboardQuery(
  overrides: Partial<Pick<OrganizationDashboardQuery, "includeTeamLeaderboard" | "leaderboardOrder">> = {},
): OrganizationDashboardQuery {
  return {
    current: {
      from: new Date("2026-07-01T00:00:00.000Z"),
      to: new Date("2026-07-08T00:00:00.000Z"),
      bucket: "day",
      timezone: "UTC",
    },
    previous: {
      from: new Date("2026-06-24T00:00:00.000Z"),
      to: new Date("2026-07-01T00:00:00.000Z"),
    },
    includeTeamLeaderboard: true,
    leaderboardOrder: "tokens",
    ...overrides,
  };
}

function dashboardUsageBundleRows(): DashboardUsageBundleRow[] {
  return [
    {
      result_kind: "daily",
      day: "2026-07-02",
      sessions: "1",
      active_users: "1",
      cost: "0.4",
      input: "4",
      output: "2",
      cache_read: "1",
      cache_creation: "0",
      priced_events: "1",
      unpriced_events: "0",
      legacy_events: "0",
    },
    {
      result_kind: "current_overview",
      day: null,
      sessions: "2",
      active_users: "1",
      cost: "1",
      input: "10",
      output: "5",
      cache_read: "2",
      cache_creation: "1",
      priced_events: "2",
      unpriced_events: "3",
      legacy_events: "4",
    },
    {
      result_kind: "previous_overview",
      day: null,
      sessions: "1",
      active_users: "1",
      cost: "0.5",
      input: "5",
      output: "2",
      cache_read: "0",
      cache_creation: "0",
      priced_events: "1",
      unpriced_events: "0",
      legacy_events: "1",
    },
    {
      result_kind: "daily",
      day: "2026-07-01",
      sessions: "1",
      active_users: "1",
      cost: "0.6",
      input: "6",
      output: "3",
      cache_read: "1",
      cache_creation: "1",
      priced_events: "1",
      unpriced_events: "3",
      legacy_events: "4",
    },
  ];
}

function dashboardBreakdownBundleRows(includeTeam = true): DashboardBreakdownBundleRow[] {
  return [
    {
      result_kind: "user_leader",
      key: "user-1",
      cost: "1",
      tokens: "18",
      sessions: "2",
      priced_events: "2",
      unpriced_events: "0",
      legacy_events: "0",
    },
    {
      result_kind: "user_leader",
      key: "user-without-label",
      cost: "0.25",
      tokens: "9",
      sessions: "1",
      priced_events: "0",
      unpriced_events: "1",
      legacy_events: "1",
    },
    ...(includeTeam ? [{
      result_kind: "team_leader",
      key: "team-1",
      cost: "1",
      tokens: "18",
      sessions: "2",
      priced_events: "2",
      unpriced_events: "0",
      legacy_events: "0",
    }] : []),
    {
      result_kind: "provider",
      key: "codex",
      cost: "1",
      tokens: "18",
      sessions: "2",
      priced_events: "1",
      unpriced_events: "1",
      legacy_events: "0",
    },
  ];
}

function dashboardBundleRows(query: string, includeTeam = true): Array<Record<string, unknown>> {
  if (query.includes("organization-dashboard-usage")) return dashboardUsageBundleRows();
  if (query.includes("organization-dashboard-breakdown")) return dashboardBreakdownBundleRows(includeTeam);
  return [];
}

function dashboardFixture(options: {
  usageRows?: Array<Record<string, unknown>>;
  breakdownRows?: Array<Record<string, unknown>>;
} = {}) {
  const queries: Array<{ query: string; params: Record<string, unknown> }> = [];
  const pgQueries: Array<{ sql: string; params: unknown[] }> = [];
  const operations: string[] = [];
  const usageRows = options.usageRows ?? dashboardUsageBundleRows();
  const breakdownRows = options.breakdownRows ?? dashboardBreakdownBundleRows();
  const ch = {
    command: async () => undefined,
    query: async (args: { query: string; query_params: Record<string, unknown> }) => {
      queries.push({ query: args.query, params: args.query_params });
      const rows = args.query.includes("organization-dashboard-usage") ? usageRows : breakdownRows;
      return { json: async () => rows };
    },
  } as unknown as ClickHouseClient;
  const pg = {
    query: async (sql: string, params: unknown[] = []) => {
      pgQueries.push({ sql, params });
      if (sql.includes("FROM users")) {
        return { rows: [{ id: "user-1", label: "User 1" }], rowCount: 1 };
      }
      if (sql.includes("FROM teams")) {
        return { rows: [{ id: "team-1", label: "Team 1" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  const operationRunner = {
    run: async <T>(operation: string, action: () => Promise<T>): Promise<T> => {
      operations.push(operation);
      return action();
    },
  };
  return {
    storage: new ClickHouseStorage(ch, pg, {
      readRollup: false,
      read15mV2Rollup: false,
      operationRunner,
    }),
    operations,
    pgQueries,
    queries,
  };
}

function dashboardRowWithout<T extends object>(row: T, field: keyof T): Record<string, unknown> {
  const copy = { ...row } as Record<string, unknown>;
  delete copy[String(field)];
  return copy;
}

test("ClickHouse 조직 dashboard는 두 JSON read로 기존 공개 결과를 조립한다", async () => {
  const fixture = dashboardFixture();

  const result = await fixture.storage.getOrganizationDashboard(organizationDashboardQuery());

  assert.equal(fixture.queries.length, 2);
  assert.equal(
    fixture.queries.filter(({ query }) => query.includes("organization-dashboard-usage")).length,
    1,
  );
  assert.equal(
    fixture.queries.filter(({ query }) => query.includes("organization-dashboard-breakdown")).length,
    1,
  );
  assert.deepEqual(
    fixture.operations.filter((operation) => operation.startsWith("organization_dashboard_")),
    ["organization_dashboard_usage", "organization_dashboard_breakdown"],
  );
  assert.deepEqual(result, {
    overview: {
      totalSessions: 2,
      activeUsers: 1,
      totalCostUsd: 1,
      totalInputTokens: 10,
      totalOutputTokens: 5,
      totalCacheReadTokens: 2,
      totalCacheCreationTokens: 1,
      costCoverage: { pricedEvents: 2, unpricedEvents: 3, legacyEvents: 4 },
    },
    previousOverview: {
      totalSessions: 1,
      activeUsers: 1,
      totalCostUsd: 0.5,
      totalInputTokens: 5,
      totalOutputTokens: 2,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      costCoverage: { pricedEvents: 1, unpricedEvents: 0, legacyEvents: 1 },
    },
    daily: [
      {
        day: "2026-07-01",
        sessions: 1,
        activeUsers: 1,
        costUsd: 0.6,
        inputTokens: 6,
        outputTokens: 3,
        cacheReadTokens: 1,
        cacheCreationTokens: 1,
      },
      {
        day: "2026-07-02",
        sessions: 1,
        activeUsers: 1,
        costUsd: 0.4,
        inputTokens: 4,
        outputTokens: 2,
        cacheReadTokens: 1,
        cacheCreationTokens: 0,
      },
    ],
    topUsers: [
      {
        key: "user-1",
        label: "User 1",
        costUsd: 1,
        totalTokens: 18,
        sessions: 2,
        costCoverage: { pricedEvents: 2, unpricedEvents: 0, legacyEvents: 0 },
      },
      {
        key: "user-without-label",
        label: "user-without-label",
        costUsd: 0.25,
        totalTokens: 9,
        sessions: 1,
        costCoverage: { pricedEvents: 0, unpricedEvents: 1, legacyEvents: 1 },
      },
    ],
    topTeams: [{
      key: "team-1",
      label: "Team 1",
      costUsd: 1,
      totalTokens: 18,
      sessions: 2,
      costCoverage: { pricedEvents: 2, unpricedEvents: 0, legacyEvents: 0 },
    }],
    providerBreakdown: [{
      providerKey: "codex",
      costUsd: 1,
      totalTokens: 18,
      sessions: 2,
      costCoverage: { pricedEvents: 1, unpricedEvents: 1, legacyEvents: 0 },
    }],
  });
});

test("팀 순위를 숨기면 breakdown SQL branch와 팀 label query를 모두 생략한다", async () => {
  const fixture = dashboardFixture({ breakdownRows: dashboardBreakdownBundleRows(false) });

  const result = await fixture.storage.getOrganizationDashboard(organizationDashboardQuery({
    includeTeamLeaderboard: false,
  }));

  const breakdown = fixture.queries.find(({ query }) => query.includes("organization-dashboard-breakdown"));
  assert.ok(breakdown);
  assert.doesNotMatch(breakdown.query, /'team_leader' AS result_kind/);
  assert.equal(fixture.pgQueries.some(({ sql }) => sql.includes("FROM teams")), false);
  assert.deepEqual(result.topTeams, []);
});

test("user leaderboard order는 허용된 cost 또는 tokens column만 SQL에 사용한다", async () => {
  for (const order of ["cost", "tokens"] as const) {
    const fixture = dashboardFixture({ breakdownRows: dashboardBreakdownBundleRows(false) });
    await fixture.storage.getOrganizationDashboard(organizationDashboardQuery({
      includeTeamLeaderboard: false,
      leaderboardOrder: order,
    }));

    const breakdown = fixture.queries.find(({ query }) => query.includes("organization-dashboard-breakdown"));
    assert.ok(breakdown);
    assert.match(
      breakdown.query,
      new RegExp(`SELECT user_id AS key,[\\s\\S]*?GROUP BY key ORDER BY ${order} DESC LIMIT 100`),
    );
  }
});

test("unknown usage result kind는 fail closed한다", async () => {
  const fixture = dashboardFixture({
    usageRows: [
      ...dashboardUsageBundleRows(),
      { ...dashboardUsageBundleRows()[0]!, result_kind: "unexpected_usage" },
    ],
  });

  await assert.rejects(
    fixture.storage.getOrganizationDashboard(organizationDashboardQuery()),
    /Unknown organization dashboard usage row kind/,
  );
});

test("unknown breakdown result kind는 fail closed한다", async () => {
  const fixture = dashboardFixture({
    breakdownRows: [
      ...dashboardBreakdownBundleRows(),
      { ...dashboardBreakdownBundleRows()[0]!, result_kind: "unexpected_breakdown" },
    ],
  });

  await assert.rejects(
    fixture.storage.getOrganizationDashboard(organizationDashboardQuery()),
    /Unknown organization dashboard breakdown row kind/,
  );
});

test("필수 current 또는 previous overview row가 없으면 fail closed한다", async () => {
  for (const missing of ["current_overview", "previous_overview"]) {
    const fixture = dashboardFixture({
      usageRows: dashboardUsageBundleRows().filter((row) => row.result_kind !== missing),
    });
    await assert.rejects(
      fixture.storage.getOrganizationDashboard(organizationDashboardQuery()),
      /Organization dashboard overview row is missing/,
      missing,
    );
  }
});

test("daily row의 필수 bucket이 없으면 fail closed한다", async () => {
  const fixture = dashboardFixture({
    usageRows: dashboardUsageBundleRows().map((row) => row.result_kind === "daily"
      ? { ...row, day: null }
      : row),
  });

  await assert.rejects(
    fixture.storage.getOrganizationDashboard(organizationDashboardQuery()),
    /Organization dashboard daily row is missing its bucket/,
  );
});

test("dashboard bundle parser는 overview 필수 numeric field 누락을 거부한다", async () => {
  const rows = dashboardUsageBundleRows();
  const currentIndex = rows.findIndex((row) => row.result_kind === "current_overview");
  rows[currentIndex] = dashboardRowWithout(rows[currentIndex]!, "sessions") as DashboardUsageBundleRow;
  const fixture = dashboardFixture({ usageRows: rows });

  await assert.rejects(
    fixture.storage.getOrganizationDashboard(organizationDashboardQuery()),
    /Organization dashboard usage row parsing error.*current_overview.*sessions/,
  );
});

test("dashboard bundle parser는 daily 필수 numeric field 누락을 거부한다", async () => {
  const rows = dashboardUsageBundleRows();
  const dailyIndex = rows.findIndex((row) => row.result_kind === "daily");
  rows[dailyIndex] = dashboardRowWithout(rows[dailyIndex]!, "cache_creation") as DashboardUsageBundleRow;
  const fixture = dashboardFixture({ usageRows: rows });

  await assert.rejects(
    fixture.storage.getOrganizationDashboard(organizationDashboardQuery()),
    /Organization dashboard usage row parsing error.*daily.*cache_creation/,
  );
});

test("dashboard bundle parser는 breakdown의 key·numeric·coverage field 누락을 거부한다", async () => {
  for (const field of ["key", "tokens", "legacy_events"] as const) {
    const rows = dashboardBreakdownBundleRows();
    rows[0] = dashboardRowWithout(rows[0]!, field) as DashboardBreakdownBundleRow;
    const fixture = dashboardFixture({ breakdownRows: rows });

    await assert.rejects(
      fixture.storage.getOrganizationDashboard(organizationDashboardQuery()),
      new RegExp(`Organization dashboard breakdown row parsing error.*user_leader.*${field}`),
      field,
    );
  }
});

test("dashboard bundle parser는 필수 numeric·coverage field의 잘못된 타입과 값을 거부한다", async () => {
  const cases: Array<{
    name: string;
    usageRows?: Array<Record<string, unknown>>;
    breakdownRows?: Array<Record<string, unknown>>;
    expected: RegExp;
  }> = [
    {
      name: "overview coverage boolean",
      usageRows: dashboardUsageBundleRows().map((row) => row.result_kind === "current_overview"
        ? { ...row, priced_events: false }
        : row),
      expected: /usage row parsing error.*current_overview.*priced_events/,
    },
    {
      name: "daily numeric object",
      usageRows: dashboardUsageBundleRows().map((row) => row.result_kind === "daily"
        ? { ...row, cost: {} }
        : row),
      expected: /usage row parsing error.*daily.*cost/,
    },
    {
      name: "breakdown non-numeric string",
      breakdownRows: dashboardBreakdownBundleRows().map((row) => row.result_kind === "provider"
        ? { ...row, sessions: "not-a-number" }
        : row),
      expected: /breakdown row parsing error.*provider.*sessions/,
    },
  ];

  for (const malformed of cases) {
    const fixture = dashboardFixture({
      ...(malformed.usageRows ? { usageRows: malformed.usageRows } : {}),
      ...(malformed.breakdownRows ? { breakdownRows: malformed.breakdownRows } : {}),
    });
    await assert.rejects(
      fixture.storage.getOrganizationDashboard(organizationDashboardQuery()),
      malformed.expected,
      malformed.name,
    );
  }
});

test("dashboard bundle parser는 finite number와 numeric string을 모두 허용한다", async () => {
  const numericFields = new Set([
    "sessions",
    "active_users",
    "cost",
    "input",
    "output",
    "cache_read",
    "cache_creation",
    "tokens",
    "priced_events",
    "unpriced_events",
    "legacy_events",
  ]);
  const asJsonNumbers = (rows: Array<Record<string, unknown>>) => rows.map((row) => Object.fromEntries(
    Object.entries(row).map(([field, value]) => [
      field,
      numericFields.has(field) ? Number(value) : value,
    ]),
  ));
  const fixture = dashboardFixture({
    usageRows: asJsonNumbers(dashboardUsageBundleRows()),
    breakdownRows: asJsonNumbers(dashboardBreakdownBundleRows()),
  });

  const result = await fixture.storage.getOrganizationDashboard(organizationDashboardQuery());

  assert.equal(result.overview.totalSessions, 2);
  assert.deepEqual(result.overview.costCoverage, {
    pricedEvents: 2,
    unpricedEvents: 3,
    legacyEvents: 4,
  });
  assert.equal(result.daily[0]?.costUsd, 0.6);
  assert.equal(result.topUsers[0]?.totalTokens, 18);
  assert.equal(result.providerBreakdown[0]?.sessions, 2);
});

test("dashboard current와 previous source parameter namespace는 충돌하지 않는다", async () => {
  const fixture = dashboardFixture({ breakdownRows: dashboardBreakdownBundleRows(false) });
  await fixture.storage.getOrganizationDashboard(organizationDashboardQuery({
    includeTeamLeaderboard: false,
  }));

  const usage = fixture.queries.find(({ query }) => query.includes("organization-dashboard-usage"));
  const breakdown = fixture.queries.find(({ query }) => query.includes("organization-dashboard-breakdown"));
  assert.ok(usage);
  assert.ok(breakdown);
  assert.equal(usage.params.dashboard_previous_from, "2026-06-24 00:00:00.000");
  assert.equal(usage.params.dashboard_previous_to, "2026-07-01 00:00:00.000");
  assert.equal(usage.params.dashboard_current_from, "2026-07-01 00:00:00.000");
  assert.equal(usage.params.dashboard_current_to, "2026-07-08 00:00:00.000");
  assert.equal(usage.params.from, undefined);
  assert.equal(usage.params.to, undefined);
  assert.match(usage.query, /\{dashboard_previous_from:DateTime64\(3\)\}/);
  assert.match(usage.query, /\{dashboard_current_from:DateTime64\(3\)\}/);
  assert.deepEqual(breakdown.params, {
    dashboard_current_from: "2026-07-01 00:00:00.000",
    dashboard_current_to: "2026-07-08 00:00:00.000",
  });
});

test("dashboard는 current timezone cache와 previous exact source를 같은 coverage schema로 묶는다", async () => {
  const current = localDayRange("Asia/Seoul", "2026-07-01", 2);
  const fixture = sourceRouterFixture({
    watermark: current.to,
    jobs: current.jobs,
    read15mV2Rollup: false,
    jsonRows: (query) => dashboardBundleRows(query, false),
  });

  await fixture.storage.getOrganizationDashboard({
    current: { ...current, bucket: "day", timezone: "Asia/Seoul" },
    previous: {
      from: new Date("2026-06-01T00:00:00.000Z"),
      to: new Date("2026-06-02T00:00:00.000Z"),
    },
    includeTeamLeaderboard: false,
    leaderboardOrder: "tokens",
  });

  const usage = fixture.queries.find(({ query }) => query.includes("organization-dashboard-usage"));
  const breakdown = fixture.queries.find(({ query }) => query.includes("organization-dashboard-breakdown"));
  assert.ok(usage);
  assert.ok(breakdown);
  assert.match(usage.query, /usage_daily_timezone_rollup FINAL/);
  assert.match(usage.query, /usage_events/);
  assert.match(breakdown.query, /usage_daily_timezone_rollup FINAL/);
  assert.doesNotMatch(breakdown.query, /usage_events/);
  assert.match(usage.query, /sumIf\(cost_usd, cost_status != 'unpriced'\) AS cost/);
  assert.match(usage.query, /sumIf\(event_count, cost_status = 'legacy'\) AS legacy_events/);
  assert.ok("dashboard_current_timezone" in usage.params);
  assert.ok("dashboard_previous_from" in usage.params);
});

test("dashboard raw fallback도 두 source와 기존 coverage 식을 보존한다", async () => {
  const range = localDayRange("UTC", "2026-07-01", 1);
  const fixture = sourceRouterFixture({
    active: false,
    watermark: range.to,
    read15mV2Rollup: false,
    jsonRows: (query) => dashboardBundleRows(query, false),
  });

  await fixture.storage.getOrganizationDashboard({
    current: { ...range, bucket: "day", timezone: "UTC" },
    previous: {
      from: new Date("2026-06-30T00:00:00.000Z"),
      to: new Date("2026-07-01T00:00:00.000Z"),
    },
    includeTeamLeaderboard: false,
    leaderboardOrder: "cost",
  });

  assert.equal(fixture.queries.length, 2);
  for (const { query } of fixture.queries) {
    assert.match(query, /usage_events/);
    assert.doesNotMatch(query, /usage_(?:15m|hourly|daily)_.*rollup/);
    assert.match(query, /sumIf\(cost_usd, cost_status != 'unpriced'\) AS cost/);
    assert.match(query, /sumIf\(event_count, cost_status = 'unpriced'\) AS unpriced_events/);
  }
});

test("dashboard snapshot과 background usage read가 겹쳐도 JSON read 동시성은 4 이하이다", async () => {
  let active = 0;
  let maxActive = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queries: string[] = [];
  const ch = {
    command: async () => undefined,
    query: async ({ query }: { query: string }) => {
      queries.push(query);
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (active > 6) {
        const error = new Error("Too many simultaneous queries") as Error & { code: string };
        error.code = "202";
        throw error;
      }
      if (active === 3) release();
      await gate;
      active -= 1;
      return { json: async () => dashboardBundleRows(query, false) };
    },
  } as unknown as ClickHouseClient;
  const pg = {
    query: async (sql: string) => sql.includes("FROM users")
      ? { rows: [{ id: "user-1", label: "User 1" }], rowCount: 1 }
      : { rows: [], rowCount: 0 },
  } as unknown as Pool;
  const runner = new ClickHouseOperationController({ maxConcurrent: 4, queueTimeoutMs: 1_000 });
  const storage = new ClickHouseStorage(ch, pg, {
    readRollup: false,
    read15mV2Rollup: false,
    operationRunner: runner,
  });

  await Promise.all([
    storage.getOrganizationDashboard(organizationDashboardQuery({ includeTeamLeaderboard: false })),
    storage.getOrganizationUtilizationUsage({
      from: new Date("2026-07-01T00:00:00.000Z"),
      to: new Date("2026-07-08T00:00:00.000Z"),
      timezone: "UTC",
    }),
  ]);

  assert.equal(queries.filter((query) => query.includes("organization-dashboard-")).length, 2);
  assert.ok(maxActive <= 4, `observed max active ${maxActive}`);
});

test("legacy rollup flag는 deprecated alias이며 새 flag의 명시값이 우선하고 경고는 process당 한 번이다", () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message?: unknown) => warnings.push(String(message));
  try {
    const legacy = resolveClickHouseRollupReadFlag({ CLICKHOUSE_READ_ROLLUP: "1" });
    const repeated = resolveClickHouseRollupReadFlag({ CLICKHOUSE_READ_ROLLUP: "1" });
    const explicitNewOff = resolveClickHouseRollupReadFlag({
      CLICKHOUSE_READ_ROLLUP: "1",
      CLICKHOUSE_READ_TIMEZONE_ROLLUP: "0",
    });

    assert.deepEqual(legacy, {
      enabled: true,
      legacyFlagMigration: "deprecated_alias",
    });
    assert.deepEqual(repeated, legacy);
    assert.deepEqual(explicitNewOff, {
      enabled: false,
      legacyFlagMigration: "deprecated_alias",
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warnings.length, 1);
  const warning = JSON.parse(warnings[0]!) as Record<string, unknown>;
  assert.equal(warning.event, "clickhouse_read_rollup_deprecated");
  assert.equal(warning.legacyFlag, "CLICKHOUSE_READ_ROLLUP");
  assert.equal(warning.replacementFlag, "CLICKHOUSE_READ_TIMEZONE_ROLLUP");
  assert.match(String(warning.action), /rollup:activate-timezones/);
  assert.match(String(warning.action), /shadow/);
  assert.match(String(warning.action), /unset/);
  assert.doesNotMatch(warnings[0]!, /CLICKHOUSE_PASSWORD|DATABASE_URL|AUTH_SECRET/);
});

test("15분 기준 rollup validator는 가격 provenance를 포함한 원본과 rollup fingerprint를 비교한다", async () => {
  const queries: string[] = [];
  const settings: Array<Record<string, unknown> | undefined> = [];
  const summary = {
    rows: "1",
    events: "2",
    input_tokens: "100",
    output_tokens: "20",
    cache_read_tokens: "5",
    cache_creation_tokens: "3",
    cost_usd: "0.01230000",
    fingerprint: "1234",
  };
  const ch = {
    command: async () => undefined,
    query: async ({ query, clickhouse_settings }: { query: string; clickhouse_settings?: Record<string, unknown> }) => {
      queries.push(query);
      settings.push(clickhouse_settings);
      if (query.includes("min(ts) AS from")) {
        return { json: async () => [{ from: "2026-07-12 00:00:00.000" }] };
      }
      return { json: async () => [summary] };
    },
  } as unknown as ClickHouseClient;
  const storage = new ClickHouseStorage(ch, {} as Pool);

  const result = await storage.validateUsage15mV2(
    new Date("2026-07-13T00:00:00.000Z"),
    24 * 60 * 60 * 1_000,
  );

  assert.deepEqual(result, { ok: true, detail: null });
  assert.match(queries[1]!, /FROM usage_events FINAL/);
  assert.match(queries[1]!, /pricing_revision_id, cost_status/);
  assert.match(queries[1]!, /cache_read_tokens/);
  assert.match(queries[1]!, /cache_creation_tokens/);
  assert.match(queries[1]!, /groupBitXor\(cityHash64/);
  assert.match(queries[1]!, /sum\(validation_source\.input_tokens\) AS input_tokens/);
  assert.match(queries[1]!, /validation_source\.pricing_revision_id/);
  assert.match(queries[1]!, /CAST\(validation_source\.bucket_15m AS DateTime64\(3, 'UTC'\)\)/);
  assert.match(queries[1]!, /CAST\(validation_source\.cost_usd AS Decimal\(18, 8\)\)/);
  assert.match(queries[2]!, /FROM usage_15m_rollup_v2 AS validation_source FINAL/);
  assert.deepEqual(settings[1], { max_threads: 2, max_execution_time: 30 });
  assert.deepEqual(settings[2], { max_threads: 2, max_execution_time: 30 });
});

test("시간대별 validator는 활성 시간대의 최근 완료 hour와 local day를 15분 기준으로 비교한다", async () => {
  const queries: string[] = [];
  const settings: Array<Record<string, unknown> | undefined> = [];
  const summary = {
    rows: "1",
    events: "2",
    input_tokens: "100",
    output_tokens: "20",
    cache_read_tokens: "5",
    cache_creation_tokens: "3",
    cost_usd: "0.01230000",
    fingerprint: "1234",
  };
  const ch = {
    command: async () => undefined,
    query: async ({ query, clickhouse_settings }: { query: string; clickhouse_settings?: Record<string, unknown> }) => {
      queries.push(query);
      settings.push(clickhouse_settings);
      return { json: async () => [summary] };
    },
  } as unknown as ClickHouseClient;
  const storage = new ClickHouseStorage(ch, {} as Pool);

  const result = await storage.validateTimezoneRollups(
    ["Asia/Seoul"],
    new Date("2026-07-13T02:35:00.000Z"),
  );

  assert.deepEqual(result, { ok: true, detail: null });
  assert.match(queries[0]!, /toStartOfInterval\(bucket_15m, INTERVAL 1 HOUR, 'Asia\/Seoul'\)/);
  assert.match(queries[1]!, /FROM usage_hourly_timezone_rollup AS validation_source FINAL/);
  assert.match(queries[2]!, /toStartOfDay\(bucket_15m, 'Asia\/Seoul'\)/);
  assert.match(queries[3]!, /FROM usage_daily_timezone_rollup AS validation_source FINAL/);
  assert.ok(queries.every((query) => /sum\(validation_source\.input_tokens\) AS input_tokens/.test(query)));
  assert.ok(queries.every((query) => /AS validation_source/.test(query)));
  assert.ok(queries.every((query) => /CAST\(validation_source\.bucket_start AS DateTime64\(3, 'UTC'\)\)/.test(query)));
  assert.ok(queries.every((query) => /CAST\(validation_source\.cost_usd AS Decimal\(18, 8\)\)/.test(query)));
  assert.ok(settings.every((value) => value?.max_threads === 2 && value.max_execution_time === 30));
});

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

test("ClickHouseStorage는 활용 지수 일별 사용량을 provider capability와 함께 집계한다", async () => {
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
            user_id: "u1",
            day: "2026-07-06",
            sessions: "2",
            input: "100",
            cache_read: "80",
            cache_creation: "20",
            cache_signal_events: "3",
            cache_unsupported_events: "1",
          },
        ],
      };
    },
  } as unknown as ClickHouseClient;

  const storage = new ClickHouseStorage(ch, {} as Pool, {
    readRollup: false,
    read15mRollup: false,
    read15mV2Rollup: false,
  });
  const queryInput = {
    from: new Date("2026-07-06T00:00:00.000Z"),
    to: new Date("2026-07-08T00:00:00.000Z"),
    timezone: "UTC",
  };
  const result = await storage.getUserUtilizationUsage("u1", queryInput);

  assert.match(query, /user_id = \{uid:String\}/);
  assert.match(query, /uniqExactIf\(session_id, session_id != ''\)/);
  assert.match(query, /provider_key IN \{cacheProviders:Array\(String\)\}/);
  assert.match(query, /sumIf\(event_count,/);
  assert.deepEqual(queryParams.cacheProviders, ["claude_code", "codex", "gemini", "qwen"]);
  assert.deepEqual(result, [
    {
      userId: "u1",
      day: "2026-07-06",
      sessions: 2,
      inputTokens: 100,
      cacheReadTokens: 80,
      cacheCreationTokens: 20,
      cacheSignalEvents: 3,
      cacheUnsupportedEvents: 1,
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
  const enqueueIndexes = pgQueries.flatMap(({ sql }, index) =>
    sql.includes("enqueue_pricing_repair") ? [index] : []
  );
  assert.equal(enqueueIndexes.length, 1);
  const outboxDeliveredIndex = pgQueries.findIndex(({ sql }) => sql.includes("SET delivered_at = now()"));
  const batchDeliveredIndex = pgQueries.findIndex(({ sql }) => sql.includes("SET status = 'delivered'"));
  const deliveryCommitIndex = pgQueries.map(({ sql }) => sql).lastIndexOf("COMMIT");
  assert.ok(enqueueIndexes[0]! > outboxDeliveredIndex);
  assert.ok(enqueueIndexes[0]! > batchDeliveredIndex);
  assert.ok(deliveryCommitIndex > enqueueIndexes[0]!);
});

test("ClickHouse는 priced·legacy delivery만 있으면 가격 복구를 예약하지 않는다", async () => {
  const pgQueries: Array<{ sql: string; params: unknown[] }> = [];
  const storage = storageWithInsertedRows([], pgQueries);

  await storage.saveUsageEvents([
    finalizedEvent({ dedupKey: "priced" }),
    finalizedEvent({ dedupKey: "legacy", pricingRevisionId: null, costStatus: "legacy" }),
  ]);

  assert.equal(pgQueries.some(({ sql }) => sql.includes("enqueue_pricing_repair")), false);
});

test("ClickHouse delivery의 가격 복구 예약 실패는 outbox batch를 pending으로 되돌린다", async () => {
  const pgQueries: Array<{ sql: string; params: unknown[] }> = [];
  const storage = storageWithInsertedRows([], pgQueries, { failEnqueue: true });
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));

  try {
    await storage.saveUsageEvents([
      finalizedEvent({ pricingRevisionId: null, costStatus: "unpriced", costUsd: 0 }),
    ]);
    await assert.rejects(storage.flushUsageOutbox(), /enqueue unavailable/);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(pgQueries.some(({ sql }) =>
    sql.includes("SET status = 'pending'")
  ), true);
  assert.equal(pgQueries.some(({ sql }) => sql === "ROLLBACK"), true);
  assert.equal(warnings.some((warning) => warning.includes("queued rows retained")), true);
});

test("ClickHouse raw insert 실패 전에는 가격 복구를 예약하지 않는다", async () => {
  const pgQueries: Array<{ sql: string; params: unknown[] }> = [];
  const storage = storageWithInsertedRows([], pgQueries, { failInsert: true });
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));

  try {
    await storage.saveUsageEvents([
      finalizedEvent({ pricingRevisionId: null, costStatus: "unpriced", costUsd: 0 }),
    ]);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(pgQueries.some(({ sql }) => sql.includes("enqueue_pricing_repair")), false);
  assert.equal(pgQueries.some(({ sql }) => sql.includes("SET status = 'pending'")), true);
  assert.equal(warnings.some((warning) => warning.includes("queued rows retained")), true);
});

test("ClickHouse 가격 복구는 unpriced와 legacy를 dirty 먼저 기록하고 priced 버전을 결정적으로 삽입한다", async () => {
  const actions: string[] = [];
  const queries: string[] = [];
  const inserts: Array<{
    values: Array<Record<string, unknown>>;
    token?: string;
  }> = [];
  const ch = {
    command: async () => undefined,
    query: async ({ query }: { query: string }) => {
      queries.push(query);
      return {
        json: async () => [{
          dedup_key: "event-1",
          provider_key: "anthropic",
          user_id: "user-1",
          team_id: "team-1",
          session_id: "session-1",
          model: "claude-sonnet-4",
          ts: "2026-07-10 10:05:00.000",
          input_tokens: "100",
          output_tokens: "20",
          cache_read_tokens: "5",
          cache_creation_tokens: "3",
          cost_usd: "0.00000000",
          pricing_revision_id: "",
          cost_status: "unpriced",
          log_adapter: "claude",
          host: "macbook",
        }, {
          dedup_key: "event-2",
          provider_key: "anthropic",
          user_id: "user-1",
          team_id: "team-1",
          session_id: "session-1",
          model: "claude-sonnet-4",
          ts: "2026-07-10 10:06:00.000",
          input_tokens: "200",
          output_tokens: "40",
          cache_read_tokens: "10",
          cache_creation_tokens: "6",
          cost_usd: "9.99000000",
          pricing_revision_id: "legacy-revision",
          cost_status: "legacy",
          log_adapter: "claude",
          host: "macbook",
        }],
      };
    },
    insert: async (args: {
      values: Array<Record<string, unknown>>;
      clickhouse_settings?: { insert_deduplication_token?: string };
    }) => {
      actions.push("insert-replacement");
      inserts.push({
        values: args.values,
        token: args.clickhouse_settings?.insert_deduplication_token,
      });
    },
  } as unknown as ClickHouseClient;
  const client = {
    async query(sql: string) {
      if (sql.includes("INSERT INTO clickhouse_rollup_dirty_buckets")) actions.push("mark-dirty");
      return { rows: [], rowCount: 0 };
    },
    release() {},
  } as unknown as PoolClient;
  const pg = { connect: async () => client } as unknown as Pool;
  const storage = new ClickHouseStorage(ch, pg);
  const resolver: PricingRepairResolver = () => ({
    costUsd: 0.0042,
    pricingRevisionId: "revision-1",
  });
  const request = {
    from: new Date("2026-04-11T00:00:00.000Z"),
    to: new Date("2026-07-10T12:00:00.000Z"),
    models: ["claude-sonnet-4"],
    includeCodexModelFallback: true,
    replaceRevisionIds: ["bootstrap-revision"],
    limit: 100,
    generation: "2026-07-10T12:00:00.000Z",
  };

  const first = await storage.repairPricingUsage(request, resolver);
  const second = await storage.repairPricingUsage(request, resolver);

  assert.match(queries[0] ?? "", /FROM usage_events FINAL/);
  assert.match(queries[0] ?? "", /cost_status IN \('unpriced', 'legacy'\)[\s\S]*pricing_revision_id IN/);
  assert.match(queries[0] ?? "", /provider_key = 'codex'[\s\S]*log_adapter = 'codex'[\s\S]*model = ''/);
  assert.deepEqual(actions.slice(0, 3), ["mark-dirty", "mark-dirty", "insert-replacement"]);
  assert.equal(inserts[0]?.values[0]?.dedup_key, "event-1");
  assert.equal(inserts[0]?.values[0]?.cost_status, "priced");
  assert.equal(inserts[0]?.values[0]?.pricing_revision_id, "revision-1");
  assert.equal(inserts[0]?.values[1]?.dedup_key, "event-2");
  assert.equal(inserts[0]?.values[1]?.input_tokens, 200);
  assert.equal(inserts[0]?.values[1]?.cost_status, "priced");
  assert.match(inserts[0]?.token ?? "", /^pricing-repair:/);
  assert.equal(inserts[1]?.token, inserts[0]?.token);
  assert.deepEqual(first, {
    scanned: 2,
    recovered: 1,
    repricedLegacy: 1,
    affectedBuckets: [new Date("2026-07-10T10:00:00.000Z")],
    hasMore: false,
  });
  assert.equal(second.repricedLegacy, 1);
});

test("ClickHouse Codex 재생 보정은 exact match만 dirty 처리 후 동기 mutation으로 제거한다", async () => {
  const actions: string[] = [];
  let selectedSql = "";
  let selectedParams: Record<string, unknown> = {};
  const deleteCommands: Array<Record<string, unknown>> = [];
  const ch = {
    query: async (args: { query: string; query_params: Record<string, unknown> }) => {
      selectedSql = args.query;
      selectedParams = args.query_params;
      return {
        json: async () => [{
          dedup_key: "replayed-1",
          ts: "2026-07-13 09:14:50.000",
          total_unpriced: "41",
        }],
      };
    },
    command: async (args: Record<string, unknown>) => {
      if (/ALTER TABLE usage_events\s+DELETE WHERE dedup_key IN/.test(String(args.query ?? ""))) {
        actions.push("delete-replay");
        deleteCommands.push(args);
      }
    },
  } as unknown as ClickHouseClient;
  const client = {
    async query(sql: string) {
      if (sql.includes("INSERT INTO clickhouse_rollup_dirty_buckets")) actions.push("mark-dirty");
      return { rows: [], rowCount: 0 };
    },
    release() {},
  } as unknown as PoolClient;
  const storage = new ClickHouseStorage(ch, { connect: async () => client } as unknown as Pool);

  const result = await storage.reconcileCodexReplayUsage({
    from: new Date("2026-04-15T00:00:00.000Z"),
    to: new Date("2026-07-14T00:00:00.000Z"),
    limit: 100,
  });

  assert.match(selectedSql, /FROM usage_events AS bad FINAL/);
  assert.match(selectedSql, /bad\.provider_key = 'codex'/);
  assert.match(selectedSql, /bad\.model = ''/);
  assert.match(selectedSql, /bad\.cost_status = 'unpriced'/);
  assert.match(selectedSql, /tuple\(\s*bad\.session_id, bad\.user_id, bad\.host, bad\.log_adapter/);
  assert.match(selectedSql, /IN\s*\(\s*SELECT tuple\(\s*session_id, user_id, host, log_adapter/);
  assert.match(selectedSql, /count\(\)\s+FROM usage_events FINAL[\s\S]*cost_status = 'unpriced'/);
  assert.equal(selectedParams.row_limit, 101);
  assert.deepEqual(actions.slice(0, 3), ["mark-dirty", "mark-dirty", "delete-replay"]);
  const deleteArgs = deleteCommands[0];
  assert.ok(deleteArgs);
  assert.match(String(deleteArgs?.query ?? ""), /ALTER TABLE usage_events\s+DELETE WHERE dedup_key IN/);
  assert.deepEqual((deleteArgs?.query_params as { dedup_keys: string[] }).dedup_keys, ["replayed-1"]);
  assert.equal((deleteArgs?.clickhouse_settings as { mutations_sync: string }).mutations_sync, "1");
  assert.deepEqual(result, {
    scanned: 1,
    reconciled: 1,
    remainingUnpriced: 40,
    affectedBuckets: [new Date("2026-07-13T09:00:00.000Z")],
    hasMore: false,
  });
});

test("ClickHouse exact-key 보정은 소유권 범위를 유지하고 dirty-first 동기 삭제한다", async () => {
  const key = "b".repeat(64);
  const actions: string[] = [];
  let selectedSql = "";
  let selectedParams: Record<string, unknown> = {};
  let deleteCommand: Record<string, unknown> | undefined;
  const pgQueries: Array<{ sql: string; params?: unknown[] }> = [];
  const ch = {
    query: async (args: { query: string; query_params: Record<string, unknown> }) => {
      selectedSql = args.query;
      selectedParams = args.query_params;
      return { json: async () => [{ dedup_key: key, ts: "2026-07-15 01:20:21.000" }] };
    },
    command: async (args: Record<string, unknown>) => {
      if (/ALTER TABLE usage_events\s+DELETE WHERE user_id/.test(String(args.query ?? ""))) {
        actions.push("delete");
        deleteCommand = args;
      }
    },
  } as unknown as ClickHouseClient;
  const client = {
    async query(sql: string, params?: unknown[]) {
      pgQueries.push({ sql, params });
      if (sql.includes("FROM clickhouse_usage_outbox") && sql.includes("FOR UPDATE")) {
        return {
          rows: [{ dedup_key: key, ts: new Date("2026-07-15T01:20:21.000Z") }],
          rowCount: 1,
        };
      }
      if (sql.includes("DELETE FROM clickhouse_usage_outbox")) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO clickhouse_rollup_dirty_buckets")) actions.push("dirty");
      return { rows: [], rowCount: 0 };
    },
    release() {},
  } as unknown as PoolClient;
  const storage = new ClickHouseStorage(
    ch,
    { connect: async () => client } as unknown as Pool,
  );

  const result = await storage.reconcileUsageEvents({
    userId: "user-1",
    providerKey: "codex",
    logAdapter: "codex",
    dedupKeys: [key],
  });

  assert.match(selectedSql, /FROM usage_events FINAL/);
  assert.match(selectedSql, /user_id = \{user_id:String\}/);
  assert.match(selectedSql, /provider_key = \{provider_key:String\}/);
  assert.match(selectedSql, /log_adapter = \{log_adapter:String\}/);
  assert.deepEqual(selectedParams.dedup_keys, [key]);
  const outboxDelete = pgQueries.find(({ sql }) => sql.includes("DELETE FROM clickhouse_usage_outbox"));
  assert.ok(outboxDelete);
  assert.match(outboxDelete.sql, /user_id = \$1/);
  assert.match(outboxDelete.sql, /provider_key = \$2/);
  assert.match(outboxDelete.sql, /log_adapter = \$3/);
  assert.deepEqual(outboxDelete.params, ["user-1", "codex", "codex", [key]]);
  assert.deepEqual(actions, ["dirty", "dirty", "delete", "dirty", "dirty"]);
  assert.ok(deleteCommand);
  assert.match(String(deleteCommand?.query), /user_id = \{user_id:String\}/);
  assert.match(String(deleteCommand?.query), /provider_key = \{provider_key:String\}/);
  assert.match(String(deleteCommand?.query), /log_adapter = \{log_adapter:String\}/);
  assert.equal(
    (deleteCommand?.clickhouse_settings as { mutations_sync: string }).mutations_sync,
    "1",
  );
  assert.deepEqual(result, {
    reconciled: 1,
    affectedBuckets: [new Date("2026-07-15T01:15:00.000Z")],
  });
});

test("ClickHouse 가격 복구 모델 진단은 FINAL 원본의 unpriced와 legacy를 상태별 집계한다", async () => {
  let query = "";
  let params: Record<string, unknown> = {};
  const ch = {
    command: async () => undefined,
    query: async (args: { query: string; query_params: Record<string, unknown> }) => {
      query = args.query;
      params = args.query_params;
      return { json: async () => [{
        provider_key: "codex", log_adapter: "codex",
        model: "model-a", events: "5", unpriced_events: "2", legacy_events: "3",
        first_at: "2025-09-01 00:00:00.000", last_at: "2026-07-02 00:00:00.000",
      }] };
    },
  } as unknown as ClickHouseClient;
  const storage = new ClickHouseStorage(ch, {} as Pool);
  const from = new Date("2026-07-01T00:00:00Z");
  const to = new Date("2026-07-03T00:00:00Z");

  const result = await storage.getPricingRecoveryModels(from, to, ["bootstrap-revision"]);

  assert.match(query, /FROM usage_events FINAL/);
  assert.match(query, /cost_status IN \('unpriced', 'legacy'\)[\s\S]*pricing_revision_id IN/);
  assert.equal(params.from, "2026-07-01 00:00:00.000");
  assert.deepEqual(params.replace_revision_ids, ["bootstrap-revision"]);
  assert.deepEqual(result, [{
    providerKey: "codex",
    logAdapter: "codex",
    model: "model-a",
    events: 5,
    unpricedEvents: 2,
    legacyEvents: 3,
    firstAt: new Date("2025-09-01T00:00:00.000Z"),
    lastAt: new Date("2026-07-02T00:00:00.000Z"),
  }]);
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

test("v2 최초 watermark는 최근 400일보다 오래 시작하지 않는다", () => {
  const eligible = new Date("2026-07-12T12:00:00.000Z");
  assert.equal(
    clampV2RollupStart(new Date("2024-01-01T00:00:00.000Z"), eligible).toISOString(),
    "2025-06-07T12:00:00.000Z",
  );
  assert.equal(
    clampV2RollupStart(new Date("2026-07-01T00:00:00.000Z"), eligible).toISOString(),
    "2026-07-01T00:00:00.000Z",
  );
});

test("v2 compactor는 기존 watermark도 최근 400일 시작점으로 clamp한다", async () => {
  const { storage, aggregateParams, pgCalls } = v2CompactorFixture({
    watermark: new Date("2024-01-01T00:00:00.000Z"),
  });

  const result = await storage.compactUsage15mV2(1);
  const dirtyQuery = pgCalls.find(({ sql }) => sql.includes("FROM clickhouse_rollup_dirty_buckets"));
  assert.ok(dirtyQuery);
  const targetFrom = dirtyQuery.params[1] as Date;
  const processedBuckets = aggregateParams[0]?.buckets as string[] | undefined;
  assert.deepEqual(processedBuckets, [targetFrom.toISOString().replace("T", " ").replace("Z", "")]);

  const watermarkUpdate = pgCalls.find(({ sql }) => sql.includes("UPDATE clickhouse_rollup_watermarks"));
  assert.ok(watermarkUpdate);
  assert.equal(
    (watermarkUpdate.params[1] as Date).toISOString(),
    new Date(targetFrom.getTime() + 15 * 60 * 1000).toISOString(),
  );
  assert.equal(result.watermark, (watermarkUpdate.params[1] as Date).toISOString());
});

test("v2 compactor 실패 전에는 clamp 진척을 watermark에 저장하지 않는다", async () => {
  const { storage, pgCalls } = v2CompactorFixture({
    watermark: new Date("2024-01-01T00:00:00.000Z"),
    failAggregate: true,
  });

  await assert.rejects(storage.compactUsage15mV2(1), /aggregate failed/);
  assert.equal(
    pgCalls.some(({ sql }) => sql.includes("UPDATE clickhouse_rollup_watermarks")),
    false,
  );
  assert.equal(pgCalls.some(({ sql }) => sql === "ROLLBACK"), true);
});

test("v1 compactor의 기존 watermark는 retention 시작점으로 clamp하지 않는다", async () => {
  const persistedWatermark = new Date("2024-01-01T00:00:00.000Z");
  const { storage, aggregateParams, pgCalls } = v2CompactorFixture({ watermark: persistedWatermark });

  const result = await storage.compactUsage15mRollup(1);
  const processedBuckets = aggregateParams[0]?.buckets as string[] | undefined;
  assert.deepEqual(
    processedBuckets,
    [persistedWatermark.toISOString().replace("T", " ").replace("Z", "")],
  );

  const watermarkUpdate = pgCalls.find(({ sql }) => sql.includes("UPDATE clickhouse_rollup_watermarks"));
  assert.ok(watermarkUpdate);
  assert.equal(
    (watermarkUpdate.params[1] as Date).toISOString(),
    new Date(persistedWatermark.getTime() + 15 * 60 * 1000).toISOString(),
  );
  assert.equal(result.watermark, (watermarkUpdate.params[1] as Date).toISOString());
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
  assert.match(timezoneJobs, /SELECT DISTINCT[\s\S]*resolution,[\s\S]*timezone,[\s\S]*date_trunc\(resolution, affected\.bucket, timezone\) AS bucket/);
  assert.match(timezoneJobs, /DELETE FROM clickhouse_timezone_rollup_coverage/);
  assert.match(timezoneJobs, /ON CONFLICT \(resolution, timezone, bucket\) DO UPDATE/);
  assert.match(timezoneJobs, /status = 'pending'/);
  assert.match(timezoneJobs, /source_to = EXCLUDED\.source_to/);
  assert.match(timezoneJobs, /generation = clickhouse_timezone_rollup_jobs\.generation \+ 1/);

  const dirtyQuery = pgQueries.find((query) => query.includes("FROM clickhouse_rollup_dirty_buckets"));
  assert.ok(dirtyQuery);
  assert.match(dirtyQuery, /bucket >= \$2 AND bucket < \$3/);
});

test("v2 dirty 재집계는 사라지거나 차원이 바뀐 이전 행을 동기 삭제한 뒤 새 집계를 쓴다", async () => {
  const { storage, commands, inserts } = v2CompactorFixture({ dirty: true });

  await storage.compactUsage15mV2(1);

  const deletion = commands.find((command) =>
    /ALTER TABLE usage_15m_rollup_v2\s+DELETE WHERE bucket_15m IN/.test(String(command.query ?? "")));
  assert.ok(deletion);
  assert.equal((deletion.clickhouse_settings as { mutations_sync: string }).mutations_sync, "1");
  assert.ok(inserts.some(({ table }) => table === "usage_15m_rollup_v2"));
});

test("v1 compactor는 기존 dashboard raw source 정책을 보존한다", async () => {
  const { storage, aggregateQueries, pgQueries } = v2CompactorFixture();

  await storage.compactUsage15mRollup(1);

  const aggregate = aggregateQueries.find((query) => query.includes("GROUP BY bucket_15m"));
  assert.ok(aggregate);
  assert.match(aggregate, /FROM usage_events\s+WHERE/);
  assert.doesNotMatch(aggregate, /FROM usage_events FINAL/);
  assert.equal(pgQueries.some((query) => query.includes("INSERT INTO clickhouse_timezone_rollup_jobs")), false);
  const dirtyQuery = pgQueries.find((query) => query.includes("FROM clickhouse_rollup_dirty_buckets"));
  assert.ok(dirtyQuery);
  assert.doesNotMatch(dirtyQuery, /bucket >=/);
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

test("auto read는 active runtime 15분 계층을 조회하고 상태를 한 번 확인한다", async () => {
  const range = {
    from: new Date("2026-07-01T00:00:00.000Z"),
    to: new Date("2026-07-01T01:00:00.000Z"),
  };
  const { storage, queries, pgQueries } = sourceRouterFixture({
    watermark: range.to,
    readRollup: "auto",
    read15mV2Rollup: "auto",
    runtimeStates: { usage_15m_v2: "active", timezone: "fallback" },
  });

  await storage.getDailyTimeseries({ ...range, bucket: "15m", timezone: "UTC" });

  assert.match(queries[0]!.query, /usage_15m_rollup_v2/);
  assert.equal(
    pgQueries.filter(({ sql }) => sql.includes("clickhouse_rollup_cutover_status")).length,
    1,
  );
});

test("auto read는 fallback 상태나 runtime 조회 실패에서 세밀한 원본으로 fail-closed한다", async () => {
  const range = {
    from: new Date("2026-07-01T00:00:00.000Z"),
    to: new Date("2026-07-01T01:00:00.000Z"),
  };
  for (const runtimeStateError of [false, true]) {
    const { storage, queries } = sourceRouterFixture({
      watermark: range.to,
      readRollup: "auto",
      read15mV2Rollup: "auto",
      runtimeStates: { usage_15m_v2: "fallback", timezone: "fallback" },
      runtimeStateError,
    });

    await storage.getDailyTimeseries({ ...range, bucket: "15m", timezone: "UTC" });

    assert.match(queries[0]!.query, /FROM usage_events/);
    assert.doesNotMatch(queries[0]!.query, /usage_15m_rollup_v2/);
  }
});

test("명시적 read OFF는 active runtime 상태를 조회하지 않고 우선한다", async () => {
  const range = {
    from: new Date("2026-07-01T00:00:00.000Z"),
    to: new Date("2026-07-01T01:00:00.000Z"),
  };
  const { storage, queries, pgQueries } = sourceRouterFixture({
    watermark: range.to,
    readRollup: false,
    read15mV2Rollup: false,
    runtimeStates: { usage_15m_v2: "active", timezone: "active" },
  });

  await storage.getDailyTimeseries({ ...range, bucket: "15m", timezone: "UTC" });

  assert.match(queries[0]!.query, /FROM usage_events/);
  assert.equal(
    pgQueries.some(({ sql }) => sql.includes("clickhouse_rollup_cutover_status")),
    false,
  );
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

test("hybrid cache와 exact tail은 가격 상태 event count를 같은 schema로 보존한다", async () => {
  const cached = localDayRange("Asia/Seoul", "2026-07-01", 2);
  const to = new Date(cached.to.getTime() + 45 * 60 * 1000);
  const { storage, queries } = sourceRouterFixture({
    watermark: to,
    jobs: cached.jobs,
    jsonRows: [{
      sessions: "2",
      active_users: "1",
      cost: "1.25000000",
      input: "10",
      output: "5",
      cache_read: "0",
      cache_creation: "0",
      priced_events: "2",
      unpriced_events: "3",
      legacy_events: "4",
    }],
  });

  const overview = await storage.getOverview({
    from: cached.from,
    to,
    bucket: "day",
    timezone: "Asia/Seoul",
  } as never);

  const query = queries[0]!.query;
  assert.match(query, /usage_daily_timezone_rollup FINAL/);
  assert.match(query, /usage_15m_rollup_v2/);
  assert.ok((query.match(/cost_status/g) ?? []).length >= 3);
  assert.ok((query.match(/event_count/g) ?? []).length >= 3);
  assert.match(query, /sumIf\(event_count, cost_status = 'priced'\) AS priced_events/);
  assert.match(query, /sumIf\(event_count, cost_status = 'unpriced'\) AS unpriced_events/);
  assert.match(query, /sumIf\(event_count, cost_status = 'legacy'\) AS legacy_events/);
  assert.deepEqual(overview.costCoverage, {
    pricedEvents: 2,
    unpricedEvents: 3,
    legacyEvents: 4,
  });
});

test("raw fallback도 event_count=1과 cost_status를 보존하고 unpriced 비용을 제외한다", async () => {
  const range = localDayRange("UTC", "2026-07-01", 1);
  const { storage, queries } = sourceRouterFixture({
    active: false,
    watermark: range.to,
    read15mV2Rollup: false,
    jsonRows: [{
      sessions: "1",
      active_users: "1",
      cost: "0",
      input: "10",
      output: "0",
      cache_read: "0",
      cache_creation: "0",
      priced_events: "0",
      unpriced_events: "1",
      legacy_events: "0",
    }],
  });

  const overview = await storage.getOverview({ ...range, bucket: "day" } as never);

  assert.match(queries[0]!.query, /1 AS event_count/);
  assert.match(queries[0]!.query, /cost_status/);
  assert.match(queries[0]!.query, /sumIf\(cost_usd, cost_status != 'unpriced'\) AS cost/);
  assert.equal(overview.totalCostUsd, 0);
  assert.equal(overview.costCoverage.unpricedEvents, 1);
});

test("모델별 비용은 all-unpriced와 legacy-only provenance를 반환한다", async () => {
  const range = localDayRange("UTC", "2026-07-01", 1);
  const { storage } = sourceRouterFixture({
    active: false,
    watermark: range.to,
    read15mV2Rollup: false,
    jsonRows: [
      {
        model: "unpriced-model",
        cost: "0",
        tokens: "10",
        sessions: "1",
        priced_events: "0",
        unpriced_events: "2",
        legacy_events: "0",
      },
      {
        model: "legacy-model",
        cost: "4.5",
        tokens: "20",
        sessions: "1",
        priced_events: "0",
        unpriced_events: "0",
        legacy_events: "3",
      },
    ],
  });

  const usage = await storage.getUserUsage("user-1", { ...range, bucket: "day" });

  assert.deepEqual(usage.byModel.map(({ model, costUsd, costCoverage }) => ({ model, costUsd, costCoverage })), [
    {
      model: "unpriced-model",
      costUsd: 0,
      costCoverage: { pricedEvents: 0, unpricedEvents: 2, legacyEvents: 0 },
    },
    {
      model: "legacy-model",
      costUsd: 4.5,
      costCoverage: { pricedEvents: 0, unpricedEvents: 0, legacyEvents: 3 },
    },
  ]);
});

test("ClickHouse 인사이트와 session 경로도 가격 coverage를 같은 query에서 보존한다", async () => {
  const queries: string[] = [];
  const ch = {
    command: async () => undefined,
    query: async ({ query }: { query: string }) => {
      queries.push(query);
      if (query.includes("SELECT 'summary' AS kind")) {
        return {
          json: async () => [{
            kind: "summary", period: "current", position: null,
            cost: "1.25", sessions: "2", tokens: "15",
            priced_events: "2", unpriced_events: "1", legacy_events: "0",
          }],
        };
      }
      if (query.includes("SELECT 'model' AS dimension")) {
        return {
          json: async () => [{
            dimension: "model", key: "model-a", period: "current",
            cost: "1.25", tokens: "15",
            priced_events: "2", unpriced_events: "1", legacy_events: "0",
          }],
        };
      }
      if (query.includes("GROUP BY session_id")) {
        return {
          json: async () => [{
            session_id: "session-1", models: ["model-a"], hosts: ["host-a"],
            input: "10", output: "5", cache_read: "0", cache_creation: "0",
            cost: "2.5", events: "4",
            priced_events: "2", unpriced_events: "1", legacy_events: "1",
          }],
        };
      }
      return {
        json: async () => [{
          ts: "2026-07-01 00:00:00.000", model: "model-a",
          input: "10", output: "5", cache_read: "0", cache_creation: "0",
          cost: "0", cost_status: "unpriced",
        }],
      };
    },
  } as unknown as ClickHouseClient;
  const storage = new ClickHouseStorage(ch, {} as Pool);

  const comparison = await storage.getUserInsightComparison("user-1", {
    previous: { from: new Date("2026-06-01T00:00:00Z"), to: new Date("2026-06-08T00:00:00Z") },
    current: { from: new Date("2026-06-08T00:00:00Z"), to: new Date("2026-06-15T00:00:00Z") },
    timezone: "UTC",
  });
  const summaries = await storage.getSessionUsageSummaries("user-1", ["session-1"]);
  const events = await storage.getSessionUsageEvents("user-1", "session-1");

  const insightQueries = queries.filter((query) => query.includes("/* user-insights */"));
  assert.equal(insightQueries.length, 2);
  for (const query of insightQueries) {
    assert.match(query, /sumIf\(cost_usd, cost_status != 'unpriced'\)/);
    assert.match(query, /sumIf\(event_count, cost_status = 'unpriced'\)/);
  }
  const summaryQuery = queries.find((query) => query.includes("GROUP BY session_id"));
  assert.ok(summaryQuery);
  assert.match(summaryQuery, /sumIf\(cost_usd, cost_status != 'unpriced'\)/);
  assert.match(summaryQuery, /countIf\(cost_status = 'legacy'\)/);
  const eventQuery = queries.find((query) => /ORDER BY ts ASC/.test(query));
  assert.ok(eventQuery);
  assert.match(eventQuery, /cost_status/);
  assert.equal(comparison.current.costCoverage.unpricedEvents, 1);
  assert.equal(comparison.byModel[0]?.current.costCoverage.unpricedEvents, 1);
  assert.equal(summaries[0]?.costCoverage.unpricedEvents, 1);
  assert.equal(events[0]?.costStatus, "unpriced");
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

test("7일 cleanup으로 done job이 사라져도 실제 cache bucket coverage가 있으면 timezone source를 사용한다", async () => {
  const range = localDayRange("Asia/Seoul", "2025-07-01", 2);
  const { storage, queries, pgQueries } = sourceRouterFixture({
    watermark: range.to,
    jobs: [],
    coverageBuckets: range.jobs.map(({ bucket }) => bucket),
  });

  await storage.getDailyTimeseries({
    from: range.from,
    to: range.to,
    bucket: "day",
    timezone: "Asia/Seoul",
  });

  assert.equal(
    pgQueries.some(({ sql }) => sql.includes("FROM clickhouse_timezone_rollup_coverage")),
    true,
  );
  assert.match(queries.at(-1)!.query, /usage_daily_timezone_rollup FINAL/);
  assert.doesNotMatch(queries.at(-1)!.query, /usage_15m_rollup_v2|usage_events/);
});

test("시간대 cache는 개별 validator marker가 있는 registry만 읽는다", async () => {
  const range = localDayRange("Asia/Seoul", "2025-07-01", 1);
  const { storage, pgQueries } = sourceRouterFixture({
    watermark: range.to,
    jobs: range.jobs,
  });

  await storage.getDailyTimeseries({
    from: range.from,
    to: range.to,
    bucket: "day",
    timezone: "Asia/Seoul",
  });

  const registry = pgQueries.find(({ sql }) => sql.includes("FROM clickhouse_rollup_timezones"));
  assert.match(registry!.sql, /validated_at IS NOT NULL/);
});

test("동시 dashboard 집계는 readiness snapshot 한 세트만 공유하고 settle 뒤 새 상태를 조회한다", async () => {
  const range = localDayRange("Asia/Seoul", "2025-07-01", 2);
  const fixture = sourceRouterFixture({ watermark: range.to, jobs: range.jobs });
  const period = { ...range, bucket: "day" as const, timezone: "Asia/Seoul" };

  await Promise.all([
    fixture.storage.getOverview(period),
    fixture.storage.getDailyTimeseries(period),
    fixture.storage.getLeaderboard({ ...period, scope: "user" }),
    fixture.storage.getLeaderboard({ ...period, scope: "team" }),
    fixture.storage.getProviderBreakdown(period),
    fixture.storage.getUserModelTimeseries("user-1", period),
    fixture.storage.getTeamMemberTimeseries({ ...period, teamId: "team-1", userIds: ["user-1"] }),
  ]);

  for (const table of [
    "clickhouse_rollup_timezones",
    "clickhouse_rollup_watermarks",
    "clickhouse_rollup_dirty_buckets",
    "clickhouse_timezone_rollup_jobs",
    "clickhouse_timezone_rollup_coverage",
  ]) {
    assert.equal(
      fixture.pgQueries.filter(({ sql }) => sql.includes(`FROM ${table}`)).length,
      1,
      `${table} concurrent snapshot query count`,
    );
  }

  await fixture.storage.getOverview(period);
  assert.equal(
    fixture.pgQueries.filter(({ sql }) => sql.includes("FROM clickhouse_rollup_timezones")).length,
    2,
    "settled snapshot is not reused by a later request",
  );
});

test("동일한 timezone 기간의 순수 calendar bucket 계획은 bounded cache에서 재사용한다", () => {
  const range = localDayRange("Europe/London", "2025-07-01", 2);
  const { storage } = sourceRouterFixture({ watermark: range.to, jobs: range.jobs });
  const planner = storage as unknown as {
    timezoneCacheBuckets(
      resolution: "hour" | "day",
      timezone: string,
      query: { from: Date; to: Date },
    ): Array<{ from: Date; to: Date }>;
  };

  const first = planner.timezoneCacheBuckets("day", "Europe/London", range);
  const repeated = planner.timezoneCacheBuckets("day", "Europe/London", range);
  const otherResolution = planner.timezoneCacheBuckets("hour", "Europe/London", range);

  assert.strictEqual(repeated, first);
  assert.notStrictEqual(otherResolution, first);

  for (let index = 0; index < 65; index++) {
    const from = new Date(range.from.getTime() + index * 86_400_000);
    planner.timezoneCacheBuckets("day", "Europe/London", {
      from,
      to: new Date(from.getTime() + 2 * 86_400_000),
    });
  }
  const plans = (storage as unknown as { timezoneBucketPlans: Map<string, unknown> }).timezoneBucketPlans;
  assert.equal(plans.size, 64);
});

test("readiness snapshot 오류도 in-flight cache에서 제거되어 다음 호출이 재시도한다", async () => {
  const range = localDayRange("Asia/Seoul", "2025-07-01", 2);
  const fixture = sourceRouterFixture({
    watermark: range.to,
    jobs: range.jobs,
    failRegistryOnce: true,
  });
  const period = { ...range, bucket: "day" as const, timezone: "Asia/Seoul" };

  await fixture.storage.getOverview(period);
  await fixture.storage.getOverview(period);

  assert.equal(
    fixture.pgQueries.filter(({ sql }) => sql.includes("FROM clickhouse_rollup_timezones")).length,
    2,
  );
  assert.match(fixture.queries[0]!.query, /usage_15m_rollup_v2|usage_events/);
  assert.match(fixture.queries[1]!.query, /usage_daily_timezone_rollup FINAL/);
});

test("done job과 coverage 없는 mixed snapshot은 durable 완료 근거가 아니므로 exact fallback한다", async () => {
  const range = localDayRange("Asia/Seoul", "2025-07-01", 2);
  const { storage, queries } = sourceRouterFixture({
    watermark: range.to,
    jobs: range.jobs,
    coverageBuckets: [],
  });

  await storage.getDailyTimeseries({
    from: range.from,
    to: range.to,
    bucket: "day",
    timezone: "Asia/Seoul",
  });

  assert.match(queries.at(-1)!.query, /usage_15m_rollup_v2|usage_events/);
  assert.doesNotMatch(queries.at(-1)!.query, /usage_daily_timezone_rollup FINAL/);
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

test("legacy flag만 켜져도 ready coverage가 있으면 guarded timezone source를 사용한다", async () => {
  const range = localDayRange("Asia/Kathmandu", "2026-07-01", 1);
  const flag = resolveClickHouseRollupReadFlag({ CLICKHOUSE_READ_ROLLUP: "1" });
  const { storage, queries, pgQueries } = sourceRouterFixture({
    watermark: range.to,
    jobs: range.jobs,
    readRollup: flag.enabled,
  });

  await storage.getDailyTimeseries({
    from: range.from,
    to: range.to,
    bucket: "day",
    timezone: "Asia/Kathmandu",
  });

  assert.match(queries[0]!.query, /usage_daily_timezone_rollup FINAL/);
  assert.doesNotMatch(queries[0]!.query, /usage_hourly_rollup/);
  for (const guardTable of [
    "clickhouse_rollup_timezones",
    "clickhouse_rollup_watermarks",
    "clickhouse_rollup_dirty_buckets",
    "clickhouse_timezone_rollup_jobs",
    "clickhouse_timezone_rollup_coverage",
  ]) {
    assert.ok(pgQueries.some(({ sql }) => sql.includes(guardTable)), `${guardTable} guard`);
  }
});

test("legacy flag만 켜져도 coverage가 없으면 old hourly가 아니라 exact fallback한다", async () => {
  const range = localDayRange("Asia/Kathmandu", "2026-07-01", 1);
  const flag = resolveClickHouseRollupReadFlag({ CLICKHOUSE_READ_ROLLUP: "1" });
  const { storage, queries } = sourceRouterFixture({
    watermark: range.to,
    jobs: range.jobs,
    coverageBuckets: [],
    readRollup: flag.enabled,
  });

  await storage.getDailyTimeseries({
    from: range.from,
    to: range.to,
    bucket: "day",
    timezone: "Asia/Kathmandu",
  });

  assert.match(queries[0]!.query, /usage_15m_rollup_v2|usage_events/);
  assert.doesNotMatch(queries[0]!.query, /usage_daily_timezone_rollup|usage_hourly_rollup/);
});

test("compose와 운영 문서는 legacy hourly를 제거하고 runtime 자동 전환을 안내한다", () => {
  const compose = readFileSync(new URL("../../../docker-compose.yml", import.meta.url), "utf8");
  const runbook = readFileSync(new URL("../../../docs/clickhouse-exact-rollup-runbook.md", import.meta.url), "utf8");
  const readme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");

  assert.match(compose, /CLICKHOUSE_READ_ROLLUP:.*deprecated alias/);
  assert.doesNotMatch(compose, /CLICKHOUSE_READ_ROLLUP:.*hourly rollup.*대시보드/);
  assert.doesNotMatch(runbook, /CLICKHOUSE_READ_ROLLUP=1/);
  assert.match(runbook, /schema.*rollup:activate-timezones.*worker.*coverage.*benchmark.*unset.*자동/is);
  assert.match(readme, /CLICKHOUSE_READ_ROLLUP.*deprecated alias/);
  assert.match(readme, /schema 배포.*worker 자동 백필.*T0 고정.*60분.*자동 전환/is);
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

test("partial 인사이트의 head·cache·tail SQL은 모든 기간 파라미터를 바인딩한다", async () => {
  const range = localDayRange("Asia/Seoul", "2026-07-01", 9);
  const previousFrom = new Date(range.from.getTime() + 12 * 60 * 60 * 1000);
  const previousTo = new Date(range.jobs[4]!.bucket.getTime() + 12 * 60 * 60 * 1000);
  const currentFrom = previousTo;
  const currentTo = new Date(range.jobs[8]!.bucket.getTime() + 12 * 60 * 60 * 1000);
  const { storage, queries } = sourceRouterFixture({ watermark: currentTo, jobs: range.jobs });

  await storage.getUserInsightComparison("user-1", {
    previous: { from: previousFrom, to: previousTo },
    current: { from: currentFrom, to: currentTo },
    timezone: "Asia/Seoul",
  });

  assert.equal(queries.length, 2);
  const aggregate = queries.find(({ query }) => query.includes("tagged AS"));
  assert.ok(aggregate);
  assert.match(aggregate.query, /previous_head_from/);
  assert.match(aggregate.query, /previous_cache_from/);
  assert.match(aggregate.query, /previous_tail_from/);
  assert.match(aggregate.query, /current_head_from/);
  assert.match(aggregate.query, /current_cache_from/);
  assert.match(aggregate.query, /current_tail_from/);

  const referenced = [...aggregate.query.matchAll(/\{([A-Za-z0-9_]+):/g)].map((match) => match[1]!);
  const missing = [...new Set(referenced.filter((name) => !(name in aggregate.params)))];
  assert.deepEqual(missing, []);
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

test("v2 read는 runtime auto와 비상 override를 지원하고 compactor는 단일 coordinator를 사용한다", () => {
  const storageSource = readFileSync(new URL("./storage.ts", import.meta.url), "utf8");
  const workerSource = readFileSync(new URL("../../../apps/web/lib/clickhouse-outbox.ts", import.meta.url), "utf8");
  const instrumentationSource = readFileSync(new URL("../../../apps/web/instrumentation.ts", import.meta.url), "utf8");

  assert.match(storageSource, /CLICKHOUSE_READ_15M_V2_ROLLUP/);
  assert.match(storageSource, /CLICKHOUSE_READ_TIMEZONE_ROLLUP/);
  assert.match(workerSource, /CLICKHOUSE_15M_V2_COMPACTOR/);
  assert.match(workerSource, /CLICKHOUSE_TIMEZONE_ROLLUP_COMPACTOR/);
  assert.match(workerSource, /shadowWorkerEnabled\(process\.env, "CLICKHOUSE_15M_V2_COMPACTOR"\)/);
  assert.match(workerSource, /shadowWorkerEnabled\(process\.env, "CLICKHOUSE_TIMEZONE_ROLLUP_COMPACTOR"\)/);
  assert.match(workerSource, /runObservedWorkerTick\(\{/);
  assert.match(workerSource, /worker: "usage_15m_v2"/);
  assert.match(workerSource, /worker: "timezone"/);
  assert.match(workerSource, /__toardClickHouseTimezoneRollupRunning/);
  assert.match(workerSource, /__toardClickHouse15mV2RollupRunning/);
  assert.match(workerSource, /__toardClickHouseOutboxRunning/);
  assert.match(workerSource, /COMPACTOR_TICK_MS\s*=\s*60_000/);
  assert.equal(instrumentationSource.match(/startRollupCoordinator\(\)/g)?.length, 1);
  assert.doesNotMatch(instrumentationSource, /startClickHouse15mV2Compaction\(\)/);
  assert.doesNotMatch(instrumentationSource, /startClickHouseTimezoneRollupCompaction\(\)/);
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

test("ClickHouse 기본 schema ensure는 opt-in raw TTL을 변경하지 않는다", async () => {
  const commands = await schemaCommands();

  assert.equal(commands.some((query) => /usage_events\s+MODIFY TTL/i.test(query)), false);
});

test("ClickHouse 기본 schema ensure는 보조 raw 7일과 legacy hourly 400일 TTL을 적용한다", async () => {
  const commands = await schemaCommands();

  assert.equal(
    commands.filter((query) => /raw_events\s+MODIFY TTL\s+toDateTime\(received_at\)\s*\+\s*INTERVAL\s+7\s+DAY\s+DELETE/i.test(query)).length,
    1,
  );
  assert.equal(
    commands.filter((query) => /usage_hourly_rollup\s+MODIFY TTL\s+toDateTime\(bucket_hour\)\s*\+\s*INTERVAL\s+400\s+DAY\s+DELETE/i.test(query)).length,
    1,
  );
});

test("ClickHouse retention TTL을 명시하면 raw 원본에만 7일 grace를 포함한 97일 TTL을 적용한다", async () => {
  const commands = await schemaCommands({ enforceRetentionTtl: true });

  assert.equal(
    commands.filter((query) => /usage_events\s+MODIFY TTL\s+toDateTime\(ts\)\s*\+\s*INTERVAL\s+97\s+DAY\s+DELETE/i.test(query)).length,
    1,
  );
});

test("ClickHouse init schema는 가격 상태 원본과 400일 15분 v2 테이블을 선언한다", () => {
  const rawSchema = readFileSync(new URL("../../../clickhouse/init/001-schema.sql", import.meta.url), "utf8");
  const rollupSchema = readFileSync(new URL("../../../clickhouse/init/004-rollup.sql", import.meta.url), "utf8");

  assert.match(rawSchema, /pricing_revision_id\s+String/);
  assert.match(rawSchema, /cost_status\s+LowCardinality\(String\)/);
  assert.match(rawSchema, /runtime opt-in[\s\S]*97일/i);
  assert.match(rollupSchema, /CREATE TABLE IF NOT EXISTS toard\.usage_15m_rollup_v2/);
  assert.match(rollupSchema, /TTL\s+toDateTime\(bucket_15m\)\s*\+\s*INTERVAL\s+400\s+DAY\s+DELETE/);
  assert.match(
    rollupSchema,
    /ORDER BY\s*\(bucket_15m, provider_key, user_id, team_id, session_id, model, host, pricing_revision_id, cost_status\)/,
  );
  assert.doesNotMatch(
    `${rawSchema}\n${rollupSchema}`,
    /ALTER TABLE toard\.usage_events\s+MODIFY TTL/,
  );
});

test("ClickHouse init schema는 보조 raw 7일과 legacy hourly 400일 TTL을 선언한다", () => {
  const rawSchema = readFileSync(new URL("../../../clickhouse/init/001-schema.sql", import.meta.url), "utf8");
  const rollupSchema = readFileSync(new URL("../../../clickhouse/init/004-rollup.sql", import.meta.url), "utf8");
  const runtime = readFileSync(new URL("./storage.ts", import.meta.url), "utf8");

  assert.match(
    rawSchema,
    /ALTER TABLE toard\.raw_events\s+MODIFY TTL toDateTime\(received_at\) \+ INTERVAL 7 DAY DELETE/,
  );
  assert.match(
    rollupSchema,
    /ALTER TABLE toard\.usage_hourly_rollup\s+MODIFY TTL toDateTime\(bucket_hour\) \+ INTERVAL 400 DAY DELETE/,
  );
  assert.doesNotMatch(`${rawSchema}\n${rollupSchema}`, /ALTER TABLE toard\.usage_events\s+MODIFY TTL/);
  assert.match(runtime, /table:\s*"usage_hourly_rollup"/);
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

test("시간대 rollup 재집계는 결과가 0행이어도 기존 bucket을 먼저 동기 삭제한다", async () => {
  const commands: Array<Record<string, unknown>> = [];
  const ch = {
    command: async (args: Record<string, unknown>) => {
      commands.push(args);
    },
    query: async () => ({ json: async () => [] }),
  } as unknown as ClickHouseClient;
  const storage = new ClickHouseStorage(ch, {} as Pool);
  const bucket = new Date("2026-03-08T08:00:00.000Z");

  assert.equal(await storage.compactTimezoneRollup("day", "America/Los_Angeles", bucket), 0);
  const deletion = commands.find((command) =>
    /ALTER TABLE usage_daily_timezone_rollup\s+DELETE WHERE timezone/.test(String(command.query ?? "")));
  assert.match(String(deletion?.query ?? ""), /ALTER TABLE usage_daily_timezone_rollup\s+DELETE WHERE timezone/);
  assert.equal((deletion?.query_params as { timezone: string }).timezone, "America/Los_Angeles");
  assert.equal((deletion?.query_params as { bucket: string }).bucket, "2026-03-08 08:00:00.000");
  assert.equal((deletion?.clickhouse_settings as { mutations_sync: string }).mutations_sync, "1");
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

test("rollup storage snapshot은 active part만 합산하고 raw min/max를 2초 제한으로 조회한다", async () => {
  const queries: Array<{
    query: string;
    clickhouse_settings?: Record<string, unknown>;
  }> = [];
  const ch = {
    query: async (args: {
      query: string;
      clickhouse_settings?: Record<string, unknown>;
    }) => {
      queries.push(args);
      if (args.query.includes("system.parts")) {
        return {
          json: async () => [
            { table: "usage_events", rows: "12", bytes: "2400" },
            { table: "usage_15m_rollup_v2", rows: "4", bytes: "800" },
          ],
        };
      }
      return {
        json: async () => [{
          from: "2026-07-01 00:00:00.000",
          to: "2026-07-12 11:45:00.000",
        }],
      };
    },
  } as unknown as ClickHouseClient;
  const storage = new ClickHouseStorage(ch, {} as Pool);

  const stats = await storage.getRollupStorageStats();

  assert.equal(stats.tables.usage_events.rows, 12);
  assert.equal(stats.tables.usage_events.bytes, 2400);
  assert.equal(stats.tables.usage_15m_rollup_v2.rows, 4);
  assert.deepEqual(stats.tables.usage_daily_timezone_rollup, { rows: 0, bytes: 0 });
  assert.deepEqual(stats.rawRange, {
    from: "2026-07-01T00:00:00.000Z",
    to: "2026-07-12T11:45:00.000Z",
  });
  assert.ok(Number.isFinite(Date.parse(stats.collectedAt)));

  assert.equal(queries.length, 2);
  const parts = queries.find(({ query }) => query.includes("system.parts"));
  const rawRange = queries.find(({ query }) => query.includes("min(ts)"));
  assert.ok(parts);
  assert.ok(rawRange);
  assert.match(parts.query, /active\s*=\s*1/);
  assert.match(parts.query, /sum\(rows\)/);
  assert.match(parts.query, /sum\(bytes_on_disk\)/);
  assert.match(rawRange.query, /min\(ts\)/);
  assert.match(rawRange.query, /max\(ts\)/);
  assert.ok(queries.every(({ clickhouse_settings }) => clickhouse_settings?.max_execution_time === 2));
});

test("ClickHouseStorage의 동시 JSON read는 네 개를 넘지 않는다", async () => {
  let active = 0;
  let maxActive = 0;
  const releases = new Map<number, () => void>();
  let nextIndex = 0;
  const ch = {
    command: async () => undefined,
    query: async () => {
      const index = nextIndex++;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => releases.set(index, resolve));
      active -= 1;
      return { json: async () => [] };
    },
  } as unknown as ClickHouseClient;
  const runner = new ClickHouseOperationController({ maxConcurrent: 4, queueTimeoutMs: 1_000 });
  const storage = new ClickHouseStorage(ch, {} as Pool, { operationRunner: runner });
  const jobs = Array.from({ length: 6 }, (_, index) => storage.getUserHosts(`user-${index}`));

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(active, 4);
  releases.get(0)!();
  await new Promise<void>((resolve) => setImmediate(resolve));
  releases.get(1)!();
  await new Promise<void>((resolve) => setImmediate(resolve));
  for (const index of [2, 3, 4, 5]) releases.get(index)!();
  await Promise.all(jobs);

  assert.equal(maxActive, 4);
});

test("ClickHouse client 호출과 readiness ping은 operation controller를 거친다", () => {
  const source = readFileSync(new URL("./storage.ts", import.meta.url), "utf8");
  const clientCalls = [...source.matchAll(/this\.ch\.(?:query|command|insert)\(/g)];
  const guardedCalls = [...source.matchAll(
    /this\.operationRunner\.run\(\s*(?:"[^"]+"|operation),\s*(?:async\s*)?\(\)\s*=>\s*this\.ch\.(?:query|command|insert)\(/g,
  )];

  assert.ok(clientCalls.length > 0);
  assert.equal(guardedCalls.length, clientCalls.length);
  assert.equal([...source.matchAll(/retryTransient:\s*true/g)].length, 2);
  assert.match(
    source,
    /defaultClickHouseOperationController\.run\(\s*"readiness_ping",[\s\S]*?\{\s*retryTransient:\s*true\s*}\s*\)/,
  );
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

test("0023 migration은 cleanup 뒤에도 유지할 timezone cache coverage를 backfill한다", () => {
  const migration = new URL("../../../migrations/1700000023_clickhouse_timezone_rollup_coverage.sql", import.meta.url);
  assert.equal(existsSync(migration), true);
  const sql = readFileSync(migration, "utf8");

  assert.match(sql, /CREATE TABLE clickhouse_timezone_rollup_coverage/);
  assert.match(sql, /PRIMARY KEY \(resolution, timezone, bucket\)/);
  assert.match(sql, /FROM clickhouse_timezone_rollup_jobs AS job[\s\S]*JOIN clickhouse_rollup_timezones[\s\S]*WHERE job\.status = 'done'/);
  assert.match(sql, /ON DELETE CASCADE/);
});
