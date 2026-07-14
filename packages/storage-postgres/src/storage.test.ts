import assert from "node:assert/strict";
import test from "node:test";
import type { FinalizedUsageEvent, PricingRepairResolver } from "@toard/core";
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

test("Postgres 가격 복구는 unpriced 행만 잠그고 revision과 mart를 같은 transaction에서 갱신한다", async () => {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const client = {
    async query(sql: string, params?: unknown[]) {
      queries.push({ sql, params });
      if (sql.includes("FROM usage_events") && sql.includes("FOR UPDATE SKIP LOCKED")) {
        return {
          rows: [{
            dedup_key: "event-1",
            provider_key: "anthropic",
            user_id: "user-1",
            session_id: "session-1",
            model: "claude-sonnet-4",
            ts: new Date("2026-07-10T10:05:00.000Z"),
            input_tokens: "100",
            output_tokens: "20",
            cache_read_tokens: "5",
            cache_creation_tokens: "3",
            cost_usd: "0",
            log_adapter: null,
            host: "host-a",
            local_day: "2026-07-10",
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("UPDATE usage_events")) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release() {},
  } as unknown as PoolClient;
  const pool = { connect: async () => client } as unknown as Pool;
  const storage = new PostgresStorage(pool, { timezone: "Asia/Seoul" });
  const resolver: PricingRepairResolver = (event) => event.model === "claude-sonnet-4"
    ? { costUsd: 0.0042, pricingRevisionId: "revision-1" }
    : null;

  const result = await storage.repairUnpricedUsage({
    from: new Date("2026-04-11T00:00:00.000Z"),
    to: new Date("2026-07-10T12:00:00.000Z"),
    models: ["claude-sonnet-4"],
    limit: 100,
    generation: "2026-07-10T12:00:00.000Z",
  }, resolver);

  const select = queries.find(({ sql }) => sql.includes("FOR UPDATE SKIP LOCKED"));
  const update = queries.find(({ sql }) => sql.includes("UPDATE usage_events"));
  assert.ok(select);
  assert.match(select.sql, /cost_status = 'unpriced'/);
  assert.match(select.sql, /model = ANY/);
  assert.ok(update);
  assert.match(update.sql, /pricing_revision_id = \$3/);
  assert.match(update.sql, /cost_status = 'priced'/);
  assert.match(update.sql, /WHERE dedup_key = \$1 AND cost_status = 'unpriced'/);
  assert.ok(queries.some(({ sql }) => sql.includes("DELETE FROM usage_daily_user")));
  assert.ok(queries.some(({ sql }) => sql.includes("DELETE FROM usage_daily_team")));
  assert.deepEqual(result, {
    scanned: 1,
    recovered: 1,
    affectedBuckets: [new Date("2026-07-10T00:00:00.000Z")],
    hasMore: false,
  });
});

test("Postgres Codex 재생 보정은 모델이 있는 원본과 완전히 일치하는 빈 모델 행만 제거한다", async () => {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const client = {
    async query(sql: string, params?: unknown[]) {
      queries.push({ sql, params });
      if (sql.includes("FROM usage_events bad") && sql.includes("FOR UPDATE OF bad SKIP LOCKED")) {
        return {
          rows: [{
            dedup_key: "replayed-1",
            ts: new Date("2026-07-13T09:14:50.000Z"),
            local_day: "2026-07-13",
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("DELETE FROM usage_events")) return { rows: [], rowCount: 1 };
      if (sql.includes("count(*) AS remaining_unpriced")) {
        return { rows: [{ remaining_unpriced: "40" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  } as unknown as PoolClient;
  const pool = { connect: async () => client } as unknown as Pool;
  const storage = new PostgresStorage(pool, { timezone: "Asia/Seoul" });

  const result = await storage.reconcileCodexReplayUsage({
    from: new Date("2026-04-15T00:00:00.000Z"),
    to: new Date("2026-07-14T00:00:00.000Z"),
    limit: 100,
  });

  const select = queries.find(({ sql }) => sql.includes("FROM usage_events bad"));
  const deletion = queries.find(({ sql }) => sql.includes("DELETE FROM usage_events"));
  assert.ok(select);
  assert.match(select.sql, /bad\.provider_key = 'codex'/);
  assert.match(select.sql, /bad\.cost_status = 'unpriced'/);
  assert.match(select.sql, /COALESCE\(bad\.model, ''\) = ''/);
  assert.match(select.sql, /EXISTS\s*\(\s*SELECT 1\s*FROM usage_events good/);
  assert.match(select.sql, /good\.session_id = bad\.session_id/);
  assert.match(select.sql, /good\.input_tokens = bad\.input_tokens/);
  assert.match(select.sql, /good\.output_tokens = bad\.output_tokens/);
  assert.match(select.sql, /good\.cache_read_tokens = bad\.cache_read_tokens/);
  assert.match(select.sql, /good\.cache_creation_tokens = bad\.cache_creation_tokens/);
  assert.match(select.sql, /good\.user_id IS NOT DISTINCT FROM bad\.user_id/);
  assert.match(select.sql, /good\.host IS NOT DISTINCT FROM bad\.host/);
  assert.ok(deletion);
  assert.match(deletion.sql, /dedup_key = ANY/);
  assert.deepEqual(deletion.params?.[0], ["replayed-1"]);
  assert.ok(queries.some(({ sql }) => sql.includes("DELETE FROM usage_daily_user")));
  assert.deepEqual(result, {
    scanned: 1,
    reconciled: 1,
    remainingUnpriced: 40,
    affectedBuckets: [new Date("2026-07-13T00:00:00.000Z")],
    hasMore: false,
  });
});

test("Postgres 미확정 모델 진단은 범위 안 unpriced만 모델별로 반환한다", async () => {
  let capturedSql = "";
  let capturedParams: unknown[] = [];
  const pool = {
    async query(sql: string, params: unknown[]) {
      capturedSql = sql;
      capturedParams = params;
      return { rows: [{ model: "model-a", events: "3", first_at: new Date("2026-07-01T00:00:00Z"), last_at: new Date("2026-07-02T00:00:00Z") }] };
    },
  } as unknown as Pool;
  const from = new Date("2026-07-01T00:00:00Z");
  const to = new Date("2026-07-03T00:00:00Z");

  const diagnostics = await new PostgresStorage(pool).getUnpricedUsageModels(from, to);

  assert.match(capturedSql, /cost_status = 'unpriced'/);
  assert.match(capturedSql, /ts >= \$1 AND ts < \$2/);
  assert.deepEqual(capturedParams, [from, to]);
  assert.deepEqual(diagnostics, [{
    model: "model-a",
    events: 3,
    firstAt: new Date("2026-07-01T00:00:00Z"),
    lastAt: new Date("2026-07-02T00:00:00Z"),
  }]);
});
