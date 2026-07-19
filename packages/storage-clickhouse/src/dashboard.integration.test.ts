import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createClient, type ClickHouseClient } from "@clickhouse/client";
import type { Pool } from "pg";
import { ClickHouseStorage } from "./storage";

const previous = {
  from: new Date("2026-06-24T00:00:00.000Z"),
  to: new Date("2026-07-01T00:00:00.000Z"),
};

const current = {
  from: new Date("2026-07-01T00:00:00.000Z"),
  to: new Date("2026-07-08T00:00:00.000Z"),
  bucket: "day" as const,
  timezone: "UTC",
};

const usageRows = [
  {
    dedup_key: "previous-priced",
    provider_key: "codex",
    user_id: "user-1",
    team_id: "team-1",
    session_id: "session-previous",
    model: "gpt",
    ts: "2026-06-30 12:00:00.000",
    input_tokens: 10,
    output_tokens: 5,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    cost_usd: "0.50000000",
    pricing_revision_id: "revision-1",
    cost_status: "priced",
    log_adapter: "codex",
    host: "macbook",
  },
  {
    dedup_key: "current-priced",
    provider_key: "codex",
    user_id: "user-1",
    team_id: "team-1",
    session_id: "session-current-1",
    model: "gpt",
    ts: "2026-07-02 12:00:00.000",
    input_tokens: 20,
    output_tokens: 10,
    cache_read_tokens: 5,
    cache_creation_tokens: 0,
    cost_usd: "1.00000000",
    pricing_revision_id: "revision-1",
    cost_status: "priced",
    log_adapter: "codex",
    host: "macbook",
  },
  {
    dedup_key: "current-unpriced",
    provider_key: "anthropic",
    user_id: "user-2",
    team_id: "team-2",
    session_id: "session-current-2",
    model: "claude",
    ts: "2026-07-03 12:00:00.000",
    input_tokens: 40,
    output_tokens: 20,
    cache_read_tokens: 10,
    cache_creation_tokens: 5,
    cost_usd: "0.00000000",
    pricing_revision_id: "",
    cost_status: "unpriced",
    log_adapter: "claude",
    host: "macmini",
  },
  {
    dedup_key: "current-legacy",
    provider_key: "anthropic",
    user_id: "user-2",
    team_id: "team-2",
    session_id: "session-current-3",
    model: "claude",
    ts: "2026-07-04 12:00:00.000",
    input_tokens: 30,
    output_tokens: 15,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    cost_usd: "2.00000000",
    pricing_revision_id: "",
    cost_status: "legacy",
    log_adapter: "claude",
    host: "macmini",
  },
] as const;

function labelPool(): Pool {
  const userSql = "SELECT id::text AS id, COALESCE(name, email) AS label FROM users WHERE id = ANY($1)";
  const teamSql = "SELECT id::text AS id, name AS label FROM teams WHERE id = ANY($1)";
  return {
    query: async (sql: string, params: unknown[] = []) => {
      assert.equal(params.length, 1);
      assert.ok(Array.isArray(params[0]));
      const ids = [...params[0]].sort();
      if (sql === userSql) {
        assert.deepEqual(ids, ["user-1", "user-2"]);
        return { rows: [{ id: "user-1", label: "User 1" }], rowCount: 1 };
      }
      if (sql === teamSql) {
        assert.deepEqual(ids, ["team-1", "team-2"]);
        return { rows: [{ id: "team-1", label: "Team 1" }], rowCount: 1 };
      }
      throw new Error("Unexpected PostgreSQL query in ClickHouse integration test");
    },
  } as unknown as Pool;
}

function explicitLoopbackUrl(): string {
  const raw = process.env.CLICKHOUSE_URL;
  assert.ok(raw, "explicit local CLICKHOUSE_URL is required");
  const parsed = new URL(raw);
  assert.ok(
    parsed.protocol === "http:" || parsed.protocol === "https:",
    "CLICKHOUSE_URL protocol must be HTTP or HTTPS",
  );
  const hostname = parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]")
    ? parsed.hostname.slice(1, -1)
    : parsed.hostname;
  assert.ok(
    hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1",
    "CLICKHOUSE_URL hostname must be an exact loopback host",
  );
  assert.ok(
    parsed.pathname === "" || parsed.pathname === "/",
    "CLICKHOUSE_URL pathname must be empty",
  );
  assert.equal(parsed.search, "", "CLICKHOUSE_URL search parameters are not allowed");
  assert.equal(parsed.hash, "", "CLICKHOUSE_URL hash is not allowed");
  assert.equal(parsed.username, "", "CLICKHOUSE_URL userinfo is not allowed");
  assert.equal(parsed.password, "", "CLICKHOUSE_URL userinfo is not allowed");
  return parsed.origin;
}

type CleanupAdmin = Pick<ClickHouseClient, "command" | "close">;
type CleanupClient = Pick<ClickHouseClient, "close">;

async function cleanupTemporaryDatabase({
  admin,
  client,
  quotedDatabase,
  databaseCreationAttempted,
}: {
  admin: CleanupAdmin;
  client: CleanupClient | undefined;
  quotedDatabase: string;
  databaseCreationAttempted: boolean;
}): Promise<void> {
  assert.match(quotedDatabase, /^`toard_dashboard_[0-9a-f]{32}`$/);
  const errors: unknown[] = [];
  try {
    await client?.close();
  } catch (error) {
    errors.push(error);
  }
  if (databaseCreationAttempted) {
    try {
      await admin.command({ query: `DROP DATABASE IF EXISTS ${quotedDatabase}` });
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    await admin.close();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, "Temporary ClickHouse database cleanup failed");
  }
}

async function withTemporaryDatabase<T>({
  admin,
  quotedDatabase,
  createDatabaseClient,
  run,
}: {
  admin: CleanupAdmin;
  quotedDatabase: string;
  createDatabaseClient: () => ClickHouseClient;
  run: (client: ClickHouseClient) => Promise<T>;
}): Promise<T> {
  let client: ClickHouseClient | undefined;
  let hasPrimaryError = false;
  let primaryError: unknown;
  try {
    await admin.command({ query: `CREATE DATABASE ${quotedDatabase}` });
    client = createDatabaseClient();
    return await run(client);
  } catch (error) {
    hasPrimaryError = true;
    primaryError = error;
    throw error;
  } finally {
    try {
      await cleanupTemporaryDatabase({
        admin,
        client,
        quotedDatabase,
        databaseCreationAttempted: true,
      });
    } catch (cleanupError) {
      if (!hasPrimaryError) throw cleanupError;
      const cleanupErrors = cleanupError instanceof AggregateError
        ? cleanupError.errors
        : [cleanupError];
      throw new AggregateError(
        [primaryError, ...cleanupErrors],
        "Temporary ClickHouse database lifecycle failed",
        { cause: primaryError },
      );
    }
  }
}

test("integration URL은 client 생성 전에 config-bearing URL과 non-loopback을 거부한다", () => {
  const original = process.env.CLICKHOUSE_URL;
  const invalidUrls = [
    "ftp://localhost:8123",
    "http://localhost:8123/existing_db",
    "http://localhost:8123/?database=existing_db",
    "http://localhost:8123/#fragment",
    "http://user@localhost:8123",
    "http://:password@localhost:8123",
    "http://127.0.0.2:8123",
    "http://localhost.example:8123",
  ];
  try {
    for (const url of invalidUrls) {
      process.env.CLICKHOUSE_URL = url;
      let reachedClientCreation = false;
      assert.throws(() => {
        explicitLoopbackUrl();
        reachedClientCreation = true;
      });
      assert.equal(reachedClientCreation, false);
    }

    for (const url of ["http://localhost:8123", "http://localhost:8123/"]) {
      process.env.CLICKHOUSE_URL = url;
      assert.equal(explicitLoopbackUrl(), "http://localhost:8123");
    }
  } finally {
    if (original == null) delete process.env.CLICKHOUSE_URL;
    else process.env.CLICKHOUSE_URL = original;
  }
});

test("CREATE 응답이 유실되어도 생성 시도한 UUID database를 exact DROP IF EXISTS로 정리한다", async () => {
  const database = "toard_dashboard_0123456789abcdef0123456789abcdef";
  const quotedDatabase = `\`${database}\``;
  const primaryError = new Error("CREATE response lost");
  const commands: string[] = [];
  let adminClosed = false;
  let databaseExists = false;
  const admin = {
    command: async ({ query }: { query: string }) => {
      commands.push(query);
      if (query === `CREATE DATABASE ${quotedDatabase}`) {
        databaseExists = true;
        throw primaryError;
      }
      if (query === `DROP DATABASE IF EXISTS ${quotedDatabase}`) {
        databaseExists = false;
        return;
      }
      throw new Error("unexpected command");
    },
    close: async () => {
      adminClosed = true;
    },
  } as unknown as Pick<ClickHouseClient, "command" | "close">;

  await assert.rejects(
    withTemporaryDatabase({
      admin,
      quotedDatabase,
      createDatabaseClient: () => {
        throw new Error("client creation must not run");
      },
      run: async () => {
        throw new Error("run must not execute");
      },
    }),
    (error: unknown) => error === primaryError,
  );

  assert.deepEqual(commands, [
    `CREATE DATABASE ${quotedDatabase}`,
    `DROP DATABASE IF EXISTS ${quotedDatabase}`,
  ]);
  assert.equal(databaseExists, false);
  assert.equal(adminClosed, true);
});

test("temporary database cleanup은 client close, DROP, admin close 실패를 서로 격리한다", async () => {
  const operations: string[] = [];
  const clientCloseError = new Error("client close failed");
  const dropError = new Error("drop failed");
  const adminCloseError = new Error("admin close failed");
  const client = {
    close: async () => {
      operations.push("client.close");
      throw clientCloseError;
    },
  } as unknown as Pick<ClickHouseClient, "close">;
  const admin = {
    command: async ({ query }: { query: string }) => {
      if (query.startsWith("CREATE DATABASE ")) {
        operations.push("admin.create");
        return;
      }
      operations.push("admin.drop");
      throw dropError;
    },
    close: async () => {
      operations.push("admin.close");
      throw adminCloseError;
    },
  } as unknown as Pick<ClickHouseClient, "command" | "close">;

  await assert.rejects(
    withTemporaryDatabase({
      admin,
      quotedDatabase: "`toard_dashboard_0123456789abcdef0123456789abcdef`",
      createDatabaseClient: () => client as ClickHouseClient,
      run: async () => {
        operations.push("run");
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [clientCloseError, dropError, adminCloseError]);
      return true;
    },
  );
  assert.deepEqual(operations, [
    "admin.create",
    "run",
    "client.close",
    "admin.drop",
    "admin.close",
  ]);
});

test("temporary database lifecycle은 CREATE primary와 복수 cleanup 오류를 함께 보존한다", async () => {
  const database = "toard_dashboard_0123456789abcdef0123456789abcdef";
  const quotedDatabase = `\`${database}\``;
  const primaryError = new Error("CREATE response lost");
  const dropError = new Error("DROP response lost");
  const adminCloseError = new Error("admin close failed");
  const operations: string[] = [];
  const admin = {
    command: async ({ query }: { query: string }) => {
      if (query === `CREATE DATABASE ${quotedDatabase}`) {
        operations.push("admin.create");
        throw primaryError;
      }
      if (query === `DROP DATABASE IF EXISTS ${quotedDatabase}`) {
        operations.push("admin.drop");
        throw dropError;
      }
      throw new Error("unexpected command");
    },
    close: async () => {
      operations.push("admin.close");
      throw adminCloseError;
    },
  } as unknown as CleanupAdmin;

  await assert.rejects(
    withTemporaryDatabase({
      admin,
      quotedDatabase,
      createDatabaseClient: () => {
        operations.push("client.create");
        throw new Error("client creation must not run");
      },
      run: async () => {
        operations.push("run");
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.strictEqual(error.errors[0], primaryError);
      assert.deepEqual(error.errors.slice(1), [dropError, adminCloseError]);
      assert.strictEqual(error.cause, primaryError);
      return true;
    },
  );
  assert.deepEqual(operations, ["admin.create", "admin.drop", "admin.close"]);
});

test("temporary database lifecycle은 primary와 cleanup 오류가 없으면 결과를 반환한다", async () => {
  const operations: string[] = [];
  const client = {
    close: async () => {
      operations.push("client.close");
    },
  } as unknown as ClickHouseClient;
  const admin = {
    command: async ({ query }: { query: string }) => {
      operations.push(query.startsWith("CREATE DATABASE ") ? "admin.create" : "admin.drop");
    },
    close: async () => {
      operations.push("admin.close");
    },
  } as unknown as CleanupAdmin;

  const result = await withTemporaryDatabase({
    admin,
    quotedDatabase: "`toard_dashboard_0123456789abcdef0123456789abcdef`",
    createDatabaseClient: () => client,
    run: async () => {
      operations.push("run");
      return "ok";
    },
  });

  assert.equal(result, "ok");
  assert.deepEqual(operations, [
    "admin.create",
    "run",
    "client.close",
    "admin.drop",
    "admin.close",
  ]);
});

test("실제 ClickHouse에서 dashboard snapshot은 기존 개별 결과와 동일하다", {
  skip: process.env.RUN_CLICKHOUSE_DASHBOARD_INTEGRATION !== "1",
  timeout: 120_000,
}, async () => {
  const url = explicitLoopbackUrl();
  const databaseSuffix = randomUUID().replaceAll("-", "");
  assert.match(databaseSuffix, /^[0-9a-f]{32}$/);
  const database = `toard_dashboard_${databaseSuffix}`;
  assert.match(database, /^toard_dashboard_[0-9a-f]{32}$/);
  const quotedDatabase = `\`${database}\``;
  const connection = {
    url,
    username: process.env.CLICKHOUSE_USER ?? "toard",
    password: process.env.CLICKHOUSE_PASSWORD ?? "toard",
  };
  const admin = createClient(connection);

  await withTemporaryDatabase({
    admin,
    quotedDatabase,
    createDatabaseClient: () => createClient({ ...connection, database }),
    run: async (client) => {
    const effectiveDatabase = await client.query({
      query: "SELECT currentDatabase() AS database",
      format: "JSONEachRow",
    }).then((result) => result.json<{ database: string }>());
    assert.deepEqual(effectiveDatabase, [{ database }]);
    await client.command({ query: `CREATE TABLE usage_events (
      dedup_key String,
      provider_key LowCardinality(String),
      user_id String,
      team_id String,
      session_id String,
      model LowCardinality(String),
      ts DateTime64(3, 'UTC'),
      input_tokens UInt64,
      output_tokens UInt64,
      cache_read_tokens UInt64,
      cache_creation_tokens UInt64,
      cost_usd Decimal(18, 8),
      pricing_revision_id String DEFAULT '',
      cost_status LowCardinality(String) DEFAULT 'legacy',
      log_adapter LowCardinality(String) DEFAULT '',
      host LowCardinality(String) DEFAULT '',
      inserted_at DateTime64(3, 'UTC') DEFAULT now64(3)
    ) ENGINE = ReplacingMergeTree(inserted_at)
      PARTITION BY toYYYYMM(ts)
      ORDER BY (dedup_key)` });
    await client.command({ query: `CREATE TABLE raw_events (
      id UInt64,
      provider_key LowCardinality(String),
      payload String,
      received_at DateTime64(3, 'UTC') DEFAULT now64(3)
    ) ENGINE = MergeTree
      ORDER BY (received_at, id)` });

    const storage = new ClickHouseStorage(client, labelPool(), {
      timezone: "UTC",
      readFinal: true,
      readRollup: false,
      read15mV2Rollup: false,
    });
    await storage.getOverview({ from: previous.from, to: current.to });
    await client.insert({ table: "usage_events", values: usageRows, format: "JSONEachRow" });

    const [
      overview,
      previousOverview,
      daily,
      topUsers,
      topTeams,
      providerBreakdown,
    ] = await Promise.all([
      storage.getOverview(current),
      storage.getOverview(previous),
      storage.getDailyTimeseries(current),
      storage.getLeaderboard({ ...current, scope: "user", orderBy: "tokens" }),
      storage.getLeaderboard({ ...current, scope: "team" }),
      storage.getProviderBreakdown(current),
    ]);
    const snapshot = await storage.getOrganizationDashboard({
      current,
      previous,
      includeTeamLeaderboard: true,
      leaderboardOrder: "tokens",
    });

    assert.deepEqual(snapshot, {
      overview,
      previousOverview,
      daily,
      topUsers,
      topTeams,
      providerBreakdown,
    });
    assert.deepEqual(overview, {
      totalSessions: 3,
      activeUsers: 2,
      totalCostUsd: 3,
      totalInputTokens: 90,
      totalOutputTokens: 45,
      totalCacheReadTokens: 15,
      totalCacheCreationTokens: 5,
      costCoverage: { pricedEvents: 1, unpricedEvents: 1, legacyEvents: 1 },
    });
    assert.deepEqual(previousOverview, {
      totalSessions: 1,
      activeUsers: 1,
      totalCostUsd: 0.5,
      totalInputTokens: 10,
      totalOutputTokens: 5,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      costCoverage: { pricedEvents: 1, unpricedEvents: 0, legacyEvents: 0 },
    });
    assert.deepEqual(daily, [
      {
        day: "2026-07-02",
        sessions: 1,
        activeUsers: 1,
        costUsd: 1,
        inputTokens: 20,
        outputTokens: 10,
        cacheReadTokens: 5,
        cacheCreationTokens: 0,
      },
      {
        day: "2026-07-03",
        sessions: 1,
        activeUsers: 1,
        costUsd: 0,
        inputTokens: 40,
        outputTokens: 20,
        cacheReadTokens: 10,
        cacheCreationTokens: 5,
      },
      {
        day: "2026-07-04",
        sessions: 1,
        activeUsers: 1,
        costUsd: 2,
        inputTokens: 30,
        outputTokens: 15,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    ]);
    assert.deepEqual(topUsers, [
      {
        key: "user-2",
        label: "user-2",
        costUsd: 2,
        totalTokens: 120,
        sessions: 2,
        costCoverage: { pricedEvents: 0, unpricedEvents: 1, legacyEvents: 1 },
      },
      {
        key: "user-1",
        label: "User 1",
        costUsd: 1,
        totalTokens: 35,
        sessions: 1,
        costCoverage: { pricedEvents: 1, unpricedEvents: 0, legacyEvents: 0 },
      },
    ]);
    assert.deepEqual(topTeams, [
      {
        key: "team-2",
        label: "team-2",
        costUsd: 2,
        totalTokens: 120,
        sessions: 2,
        costCoverage: { pricedEvents: 0, unpricedEvents: 1, legacyEvents: 1 },
      },
      {
        key: "team-1",
        label: "Team 1",
        costUsd: 1,
        totalTokens: 35,
        sessions: 1,
        costCoverage: { pricedEvents: 1, unpricedEvents: 0, legacyEvents: 0 },
      },
    ]);
    assert.deepEqual(providerBreakdown, [
      {
        providerKey: "anthropic",
        costUsd: 2,
        totalTokens: 120,
        sessions: 2,
        costCoverage: { pricedEvents: 0, unpricedEvents: 1, legacyEvents: 1 },
      },
      {
        providerKey: "codex",
        costUsd: 1,
        totalTokens: 35,
        sessions: 1,
        costCoverage: { pricedEvents: 1, unpricedEvents: 0, legacyEvents: 0 },
      },
    ]);
    },
  });
});
