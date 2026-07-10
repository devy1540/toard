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
} {
  const aggregateQueries: string[] = [];
  const inserts: InsertedRows[] = [];
  const bucket = new Date(Math.floor((Date.now() - 2 * 60 * 60 * 1000) / (15 * 60 * 1000)) * (15 * 60 * 1000));
  let watermark = bucket;
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
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
  return { storage: new ClickHouseStorage(ch, pg), aggregateQueries, inserts };
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
  const { storage, aggregateQueries, inserts } = v2CompactorFixture();
  const compact = (storage as unknown as {
    compactUsage15mV2?: (limitBuckets?: number) => Promise<{ buckets: number; rows: number; watermark: string }>;
  }).compactUsage15mV2;

  assert.equal(typeof compact, "function");
  if (!compact) return;
  await compact.call(storage, 1);

  const aggregate = aggregateQueries.find((query) => query.includes("GROUP BY bucket_15m"));
  assert.ok(aggregate);
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
