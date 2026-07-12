import assert from "node:assert/strict";
import test from "node:test";
import type { FinalizedUsageEvent } from "@toard/core";
import type { Pool, PoolClient } from "pg";
import { PostgresStorage } from "./storage";

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
    ...overrides,
  };
}

test("PostgresStorage groups team member usage by bucket and user", async () => {
  let capturedSql = "";
  let capturedParams: unknown[] = [];
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      capturedSql = sql;
      capturedParams = params;
      return {
        rows: [
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
  } as unknown as Pool;

  const result = await new PostgresStorage(pool).getTeamMemberTimeseries({
    from: new Date("2026-07-06T00:00:00.000Z"),
    to: new Date("2026-07-08T00:00:00.000Z"),
    bucket: "day",
    timezone: "UTC",
    teamId: "team-1",
    userIds: ["u1", "u2"],
  });

  assert.match(capturedSql, /team_id = \$3/);
  assert.match(capturedSql, /user_id = ANY\(\$4\)/);
  assert.match(capturedSql, /GROUP BY 1, 2 ORDER BY 1, 2/);
  assert.deepEqual(capturedParams[3], ["u1", "u2"]);
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

test("Postgres usage_events는 pricing revision과 모든 cost status를 보존한다", async () => {
  const usageInserts: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes("INSERT INTO usage_events")) {
        usageInserts.push({ sql, params });
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  } as unknown as PoolClient;
  const pool = {
    connect: async () => client,
  } as unknown as Pool;
  const storage = new PostgresStorage(pool);

  await storage.saveUsageEvents([
    finalizedEvent(),
    finalizedEvent({ dedupKey: "event-2", pricingRevisionId: null, costStatus: "unpriced", costUsd: 0 }),
    finalizedEvent({ dedupKey: "event-3", pricingRevisionId: null, costStatus: "legacy" }),
  ]);

  assert.equal(usageInserts.length, 3);
  for (const { sql } of usageInserts) {
    assert.match(sql, /pricing_revision_id, cost_status/);
  }
  assert.deepEqual(
    usageInserts.map(({ params }) => params.slice(-2)),
    [
      ["rev-1", "priced"],
      [null, "unpriced"],
      [null, "legacy"],
    ],
  );
});

test("Postgres overview는 priced+unpriced+legacy coverage와 확정 비용만 같은 query에서 집계한다", async () => {
  let capturedSql = "";
  const pool = {
    query: async (sql: string) => {
      capturedSql = sql;
      return {
        rows: [{
          sessions: "2",
          active_users: "1",
          cost: "1.25",
          input: "10",
          output: "5",
          cache_read: "0",
          cache_creation: "0",
          priced_events: "2",
          unpriced_events: "3",
          legacy_events: "4",
        }],
      };
    },
  } as unknown as Pool;

  const overview = await new PostgresStorage(pool).getOverview({
    from: new Date("2026-07-01T00:00:00.000Z"),
    to: new Date("2026-07-02T00:00:00.000Z"),
  });

  assert.match(capturedSql, /SUM\(cost_usd\) FILTER \(WHERE cost_status <> 'unpriced'\)/);
  assert.match(capturedSql, /COUNT\(\*\) FILTER \(WHERE cost_status = 'priced'\) AS priced_events/);
  assert.deepEqual(overview.costCoverage, {
    pricedEvents: 2,
    unpricedEvents: 3,
    legacyEvents: 4,
  });
});

test("Postgres 모델별 집계는 all-unpriced와 legacy-only 상태를 구분한다", async () => {
  const pool = {
    query: async (sql: string) => {
      if (sql.includes("GROUP BY 1 ORDER BY cost DESC")) {
        return {
          rows: [
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
        };
      }
      if (sql.includes("GROUP BY host")) {
        return { rows: [] };
      }
      if (sql.includes("GROUP BY 1 ORDER BY 1")) {
        return { rows: [] };
      }
      return {
        rows: [{
          sessions: "0",
          active_users: "0",
          cost: "0",
          input: "0",
          output: "0",
          cache_read: "0",
          cache_creation: "0",
          priced_events: "0",
          unpriced_events: "0",
          legacy_events: "0",
        }],
      };
    },
  } as unknown as Pool;

  const usage = await new PostgresStorage(pool).getUserUsage("user-1", {
    from: new Date("2026-07-01T00:00:00.000Z"),
    to: new Date("2026-07-02T00:00:00.000Z"),
    timezone: "UTC",
  });

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

test("Postgres 인사이트는 current·previous summary/trend/composition coverage를 같은 query에서 보존한다", async () => {
  const queries: string[] = [];
  const pool = {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes("SELECT 'summary' AS kind")) {
        return {
          rows: [
            {
              kind: "summary", period: "current", position: null,
              cost: "1.25", sessions: "2", tokens: "15",
              priced_events: "2", unpriced_events: "1", legacy_events: "0",
            },
            {
              kind: "trend", period: "current", position: 0,
              cost: "1.25", sessions: "2", tokens: "15",
              priced_events: "2", unpriced_events: "1", legacy_events: "0",
            },
          ],
        };
      }
      return {
        rows: [{
          dimension: "model", key: "model-a", period: "current",
          cost: "1.25", tokens: "15",
          priced_events: "2", unpriced_events: "1", legacy_events: "0",
        }],
      };
    },
  } as unknown as Pool;

  const comparison = await new PostgresStorage(pool).getUserInsightComparison("user-1", {
    previous: { from: new Date("2026-06-01T00:00:00Z"), to: new Date("2026-06-08T00:00:00Z") },
    current: { from: new Date("2026-06-08T00:00:00Z"), to: new Date("2026-06-15T00:00:00Z") },
    timezone: "UTC",
  });

  for (const sql of queries) {
    assert.match(sql, /SUM\(cost_usd\) FILTER \(WHERE cost_status <> 'unpriced'\)/);
    assert.match(sql, /COUNT\(\*\) FILTER \(WHERE cost_status = 'unpriced'\)/);
  }
  assert.deepEqual(comparison.current.costCoverage, {
    pricedEvents: 2,
    unpricedEvents: 1,
    legacyEvents: 0,
  });
  assert.equal(comparison.trend[0]?.current.costCoverage.unpricedEvents, 1);
  assert.equal(comparison.byModel[0]?.current.costCoverage.unpricedEvents, 1);
});

test("Postgres session summary와 event row는 추가 query 없이 가격 상태를 반환한다", async () => {
  const queries: string[] = [];
  const pool = {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes("GROUP BY session_id")) {
        return {
          rows: [{
            session_id: "session-1", models: ["model-a"], hosts: ["host-a"],
            input: "10", output: "5", cache_read: "0", cache_creation: "0",
            cost: "2.5", events: "4",
            priced_events: "2", unpriced_events: "1", legacy_events: "1",
          }],
        };
      }
      return {
        rows: [{
          ts: new Date("2026-07-01T00:00:00Z"), model: "model-a",
          input_tokens: "10", output_tokens: "5", cache_read_tokens: "0", cache_creation_tokens: "0",
          cost_usd: "0", cost_status: "unpriced",
        }],
      };
    },
  } as unknown as Pool;
  const storage = new PostgresStorage(pool);

  const [summaries, events] = await Promise.all([
    storage.getSessionUsageSummaries("user-1", ["session-1"]),
    storage.getSessionUsageEvents("user-1", "session-1"),
  ]);

  assert.equal(queries.length, 2);
  assert.match(queries[0]!, /SUM\(cost_usd\) FILTER \(WHERE cost_status <> 'unpriced'\)/);
  assert.match(queries[0]!, /COUNT\(\*\) FILTER \(WHERE cost_status = 'legacy'\)/);
  assert.match(queries[1]!, /cost_status/);
  assert.deepEqual(summaries[0]?.costCoverage, {
    pricedEvents: 2,
    unpricedEvents: 1,
    legacyEvents: 1,
  });
  assert.equal(events[0]?.costStatus, "unpriced");
});

test("Postgres 세 시계열 경로는 nonzero unpriced 비용을 모두 제외해 ClickHouse 의미와 맞춘다", async () => {
  const queries: string[] = [];
  const pool = {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes("GROUP BY 1, 2 ORDER BY 1, 2")) {
        return { rows: [{ day: "2026-07-01", user_id: "user-1", sessions: "1", active_users: "1", cost: "0.5", input: "10", output: "0", cache_read: "0", cache_creation: "0" }] };
      }
      if (sql.includes("GROUP BY 1, 2 ORDER BY 1, cost DESC")) {
        return { rows: [{ day: "2026-07-01", model: "model-a", cost: "0.5", tokens: "10" }] };
      }
      return { rows: [{ day: "2026-07-01", sessions: "1", active_users: "1", cost: "0.5", input: "10", output: "0", cache_read: "0", cache_creation: "0" }] };
    },
  } as unknown as Pool;
  const storage = new PostgresStorage(pool);
  const period = {
    from: new Date("2026-07-01T00:00:00Z"),
    to: new Date("2026-07-02T00:00:00Z"),
    timezone: "UTC",
    bucket: "day" as const,
  };

  const [daily, members, models] = await Promise.all([
    storage.getDailyTimeseries(period),
    storage.getTeamMemberTimeseries({ ...period, teamId: "team-1", userIds: ["user-1"] }),
    storage.getUserModelTimeseries("user-1", period),
  ]);

  assert.equal(queries.length, 3);
  for (const sql of queries) {
    assert.match(sql, /SUM\(cost_usd\) FILTER \(WHERE cost_status <> 'unpriced'\)/);
  }
  assert.equal(daily[0]?.costUsd, 0.5);
  assert.equal(members[0]?.costUsd, 0.5);
  assert.equal(models[0]?.costUsd, 0.5);
});
