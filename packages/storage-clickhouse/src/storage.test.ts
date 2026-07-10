import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import type { ClickHouseClient } from "@clickhouse/client";
import type { FinalizedUsageEvent } from "@toard/core";
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

function storageWithInsertedRows(inserts: InsertedRows[]): ClickHouseStorage {
  const outboxRows: Array<Record<string, unknown>> = [];
  let pendingBatch = true;
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
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
  const storage = storageWithInsertedRows(inserts);

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
  assert.match(ddl, /TTL\s+bucket_15m\s*\+\s*INTERVAL\s+400\s+DAY\s+DELETE/);
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
  assert.match(rollupSchema, /TTL\s+bucket_15m\s*\+\s*INTERVAL\s+400\s+DAY\s+DELETE/);
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
