import assert from "node:assert/strict";
import test from "node:test";
import type { ClickHouseClient } from "@clickhouse/client";
import type { Pool } from "pg";
import { ClickHouseStorage } from "./storage";

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
