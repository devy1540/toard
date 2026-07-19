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
  return {
    query: async (sql: string) => {
      if (sql.includes("FROM users")) {
        return { rows: [{ id: "user-1", label: "User 1" }], rowCount: 1 };
      }
      if (sql.includes("FROM teams")) {
        return { rows: [{ id: "team-1", label: "Team 1" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
}

function explicitLoopbackUrl(): string {
  const raw = process.env.CLICKHOUSE_URL;
  assert.ok(raw, "explicit local CLICKHOUSE_URL is required");
  const parsed = new URL(raw);
  const hostname = parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]")
    ? parsed.hostname.slice(1, -1)
    : parsed.hostname;
  assert.ok(
    hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1",
    "CLICKHOUSE_URL hostname must be an exact loopback host",
  );
  return raw;
}

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
  let client: ClickHouseClient | undefined;
  let databaseCreated = false;

  try {
    await admin.command({ query: `CREATE DATABASE ${quotedDatabase}` });
    databaseCreated = true;
    client = createClient({ ...connection, database });
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
    assert.deepEqual(daily.map((row) => [row.day, row.costUsd]), [
      ["2026-07-02", 1],
      ["2026-07-03", 0],
      ["2026-07-04", 2],
    ]);
    assert.deepEqual(topUsers.map(({ key, label, totalTokens }) => ({
      key,
      label,
      totalTokens,
    })), [
      { key: "user-2", label: "user-2", totalTokens: 120 },
      { key: "user-1", label: "User 1", totalTokens: 35 },
    ]);
    assert.deepEqual(topTeams.map(({ key, label, costUsd }) => ({ key, label, costUsd })), [
      { key: "team-2", label: "team-2", costUsd: 2 },
      { key: "team-1", label: "Team 1", costUsd: 1 },
    ]);
    assert.deepEqual(providerBreakdown.map(({ providerKey, totalTokens }) => ({
      providerKey,
      totalTokens,
    })), [
      { providerKey: "anthropic", totalTokens: 120 },
      { providerKey: "codex", totalTokens: 35 },
    ]);
  } finally {
    try {
      await client?.close();
    } finally {
      try {
        if (databaseCreated) {
          await admin.command({ query: `DROP DATABASE ${quotedDatabase}` });
        }
      } finally {
        await admin.close();
      }
    }
  }
});
