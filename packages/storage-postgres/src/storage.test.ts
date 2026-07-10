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
