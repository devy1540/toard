import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { PostgresStorage } from "./storage";

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
