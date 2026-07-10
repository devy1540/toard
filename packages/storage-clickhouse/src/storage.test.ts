import assert from "node:assert/strict";
import test from "node:test";
import type { ClickHouseClient } from "@clickhouse/client";
import type { Pool } from "pg";
import { ClickHouseStorage } from "./storage";

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
