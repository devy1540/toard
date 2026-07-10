import { createClient } from "../packages/storage-clickhouse/node_modules/@clickhouse/client/dist/index.js";
import type { UsageEvent } from "../packages/core/src/storage";
import { ClickHouseStorage } from "../packages/storage-clickhouse/src/storage";
import { Pool } from "pg";

function assertLocalUrl(name: string, value: string | undefined): string {
  const v = value ?? "";
  if (!v.includes("localhost") && !v.includes("127.0.0.1")) {
    throw new Error(`${name} must point at localhost/127.0.0.1 for this destructive local verification`);
  }
  return v;
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label} mismatch\nactual:   ${a}\nexpected: ${e}`);
}

function chTs(d: Date): string {
  return d.toISOString().replace("T", " ").replace("Z", "");
}

function hourBucket(d: Date): string {
  const bucket = new Date(d);
  bucket.setUTCMinutes(0, 0, 0);
  return chTs(bucket);
}

function event(base: {
  dedupKey: string;
  providerKey: string;
  userId: string;
  sessionId: string;
  model: string;
  ts: Date;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd: number;
  host: string;
}): UsageEvent {
  return {
    dedupKey: base.dedupKey,
    providerKey: base.providerKey,
    userId: base.userId,
    sessionId: base.sessionId,
    model: base.model,
    ts: base.ts,
    inputTokens: base.inputTokens,
    outputTokens: base.outputTokens,
    cacheReadTokens: base.cacheReadTokens ?? 0,
    cacheCreationTokens: base.cacheCreationTokens ?? 0,
    costUsd: base.costUsd,
    host: base.host,
  };
}

async function main(): Promise<void> {
  const databaseUrl = assertLocalUrl("DATABASE_URL", process.env.DATABASE_URL);
  const clickhouseUrl = assertLocalUrl("CLICKHOUSE_URL", process.env.CLICKHOUSE_URL ?? "http://localhost:8123");
  const pg = new Pool({ connectionString: databaseUrl });
  const ch = createClient({
    url: clickhouseUrl,
    username: process.env.CLICKHOUSE_USER ?? "toard",
    password: process.env.CLICKHOUSE_PASSWORD ?? "toard",
    database: process.env.CLICKHOUSE_DB ?? "toard",
  });

  const runId = `verify_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const providerKey = `${runId}_provider`;
  const teamName = `${runId}_team`;
  const email = `${runId}@example.test`;
  const from = new Date("2020-01-01T00:00:00.000Z");
  const to = new Date("2020-01-02T00:00:00.000Z");

  try {
    await pg.query(
      `INSERT INTO providers (key, display_name, service_name_patterns, collection_method, enabled)
       VALUES ($1, $2, ARRAY[$1], 'logfile', true)`,
      [providerKey, providerKey],
    );
    const team = await pg.query<{ id: string }>("INSERT INTO teams (name) VALUES ($1) RETURNING id", [teamName]);
    const teamId = team.rows[0]!.id;
    const user = await pg.query<{ id: string }>(
      `INSERT INTO users (email, name, team_id, role)
       VALUES ($1, $2, $3, 'member')
       RETURNING id`,
      [email, runId, teamId],
    );
    const userId = user.rows[0]!.id;

    const raw = new ClickHouseStorage(ch, pg, { timezone: "UTC", readRollup: false });
    const rollup = new ClickHouseStorage(ch, pg, { timezone: "UTC", readRollup: true });
    const rollup15m = new ClickHouseStorage(ch, pg, { timezone: "UTC", read15mRollup: true });

    const duplicate = event({
      dedupKey: `${runId}:duplicate`,
      providerKey,
      userId,
      sessionId: `${runId}:s1`,
      model: "verify-model-a",
      ts: new Date("2020-01-01T01:10:00.000Z"),
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 3,
      cacheCreationTokens: 4,
      costUsd: 0.12345678,
      host: "verify-host-a",
    });

    const duplicateResults = await Promise.all(Array.from({ length: 20 }, () => raw.saveUsageEvents([duplicate])));
    const insertedDuplicates = duplicateResults.reduce((sum, r) => sum + r.inserted, 0);
    const dedupedDuplicates = duplicateResults.reduce((sum, r) => sum + r.deduped, 0);
    assertEqual(insertedDuplicates, 1, "concurrent duplicate inserted count");
    assertEqual(dedupedDuplicates, 19, "concurrent duplicate deduped count");

    const rest = [
      event({
        dedupKey: `${runId}:2`,
        providerKey,
        userId,
        sessionId: `${runId}:s1`,
        model: "verify-model-a",
        ts: new Date("2020-01-01T01:20:00.000Z"),
        inputTokens: 7,
        outputTokens: 11,
        costUsd: 0.2,
        host: "verify-host-a",
      }),
      event({
        dedupKey: `${runId}:3`,
        providerKey,
        userId,
        sessionId: `${runId}:s2`,
        model: "verify-model-b",
        ts: new Date("2020-01-01T02:00:00.000Z"),
        inputTokens: 5,
        outputTokens: 13,
        cacheReadTokens: 2,
        costUsd: 0.3,
        host: "verify-host-b",
      }),
      event({
        dedupKey: `${runId}:4`,
        providerKey,
        userId,
        sessionId: `${runId}:s3`,
        model: "verify-model-b",
        ts: new Date("2020-01-01T03:30:00.000Z"),
        inputTokens: 17,
        outputTokens: 19,
        cacheCreationTokens: 5,
        costUsd: 0.4,
        host: "verify-host-b",
      }),
    ];
    const saveRest = await raw.saveUsageEvents(rest);
    assertEqual(saveRest, { inserted: 3, deduped: 0 }, "unique batch save result");
    await raw.flushUsageOutbox(10);

    const duplicateCount = await ch.query({
      query:
        "SELECT count() AS rows, uniqExact(dedup_key) AS uniq FROM usage_events WHERE startsWith(dedup_key, {prefix:String})",
      query_params: { prefix: runId },
      format: "JSONEachRow",
    });
    const duplicateRows = (await duplicateCount.json<{ rows: string; uniq: string }>())[0]!;
    assertEqual(Number(duplicateRows.rows) - Number(duplicateRows.uniq), 0, "ClickHouse raw duplicate rows");

    const batch = await pg.query<{ insert_token: string; batch_id: string }>(
      `SELECT b.insert_token, o.batch_id::text
       FROM clickhouse_usage_outbox o
       JOIN clickhouse_usage_batches b ON b.id = o.batch_id
       WHERE o.dedup_key = $1`,
      [duplicate.dedupKey],
    );
    const token = batch.rows[0]!.insert_token;
    await ch.insert({
      table: "usage_events",
      values: [{
        dedup_key: duplicate.dedupKey,
        provider_key: duplicate.providerKey,
        user_id: duplicate.userId ?? "",
        team_id: teamId,
        session_id: duplicate.sessionId ?? "",
        model: duplicate.model ?? "",
        ts: "2020-01-01 01:10:00.000",
        input_tokens: duplicate.inputTokens,
        output_tokens: duplicate.outputTokens,
        cache_read_tokens: duplicate.cacheReadTokens,
        cache_creation_tokens: duplicate.cacheCreationTokens,
        cost_usd: "0.12345678",
        log_adapter: "",
        host: duplicate.host ?? "",
      }],
      format: "JSONEachRow",
      clickhouse_settings: {
        insert_deduplication_token: `${token}:raw`,
      },
    });
    await ch.insert({
      table: "usage_hourly_rollup",
      values: [{
        bucket_hour: hourBucket(duplicate.ts),
        provider_key: duplicate.providerKey,
        user_id: duplicate.userId ?? "",
        team_id: teamId,
        session_id: duplicate.sessionId ?? "",
        model: duplicate.model ?? "",
        host: duplicate.host ?? "",
        event_count: 1,
        input_tokens: duplicate.inputTokens,
        output_tokens: duplicate.outputTokens,
        cache_read_tokens: duplicate.cacheReadTokens,
        cache_creation_tokens: duplicate.cacheCreationTokens,
        cost_usd: "0.12345678",
      }],
      format: "JSONEachRow",
      clickhouse_settings: {
        insert_deduplication_token: `${token}:rollup`,
      },
    });
    const retryCount = await ch.query({
      query: "SELECT count() AS rows, uniqExact(dedup_key) AS uniq FROM usage_events WHERE dedup_key = {key:String}",
      query_params: { key: duplicate.dedupKey },
      format: "JSONEachRow",
    });
    const retryRows = (await retryCount.json<{ rows: string; uniq: string }>())[0]!;
    assertEqual(Number(retryRows.rows), 1, "same-token retry raw row count");
    assertEqual(Number(retryRows.uniq), 1, "same-token retry raw uniq count");
    const retryRollup = await ch.query({
      query: `SELECT
                sum(event_count) AS events,
                sum(input_tokens) AS input,
                sum(output_tokens) AS output,
                sum(cache_read_tokens) AS cache_read,
                sum(cache_creation_tokens) AS cache_creation,
                sum(cost_usd) AS cost
              FROM usage_hourly_rollup
              WHERE bucket_hour = {bucket:DateTime64(3)}
                AND provider_key = {provider:String}
                AND user_id = {user:String}
                AND team_id = {team:String}
                AND session_id = {session:String}
                AND model = {model:String}
                AND host = {host:String}`,
      query_params: {
        bucket: hourBucket(duplicate.ts),
        provider: duplicate.providerKey,
        user: duplicate.userId ?? "",
        team: teamId,
        session: duplicate.sessionId ?? "",
        model: duplicate.model ?? "",
        host: duplicate.host ?? "",
      },
      format: "JSONEachRow",
    });
    const retryRollupRows = (await retryRollup.json<{
      events: string;
      input: string;
      output: string;
      cache_read: string;
      cache_creation: string;
      cost: string;
    }>())[0]!;
    assertEqual(
      {
        events: Number(retryRollupRows.events),
        input: Number(retryRollupRows.input),
        output: Number(retryRollupRows.output),
        cacheRead: Number(retryRollupRows.cache_read),
        cacheCreation: Number(retryRollupRows.cache_creation),
        cost: Number(retryRollupRows.cost),
      },
      {
        events: 2,
        input: 17,
        output: 31,
        cacheRead: 3,
        cacheCreation: 4,
        cost: 0.32345678,
      },
      "same-token retry rollup group totals",
    );

    await raw.compactUsage15mRollup(256);
    const rollup15mRows = await ch.query({
      query: "SELECT count() AS rows FROM usage_15m_rollup WHERE provider_key = {provider:String}",
      query_params: { provider: providerKey },
      format: "JSONEachRow",
    });
    const rollup15mCount = (await rollup15mRows.json<{ rows: string }>())[0]!;
    if (Number(rollup15mCount.rows) === 0) throw new Error("15m rollup compaction produced no rows");

    const watermark = await pg.query<{ watermark: Date }>(
      "SELECT watermark FROM clickhouse_rollup_watermarks WHERE name = 'usage_15m'",
    );
    const watermarkValue = watermark.rows[0]?.watermark;
    if (!watermarkValue || watermarkValue < to) {
      throw new Error(`15m rollup watermark did not cover verification period: ${watermarkValue?.toISOString() ?? "missing"}`);
    }

    const period = { from, to, providerKey };
    const late = event({
      dedupKey: `${runId}:late`,
      providerKey,
      userId,
      sessionId: `${runId}:s4`,
      model: "verify-model-c",
      ts: new Date("2020-01-01T01:25:00.000Z"),
      inputTokens: 23,
      outputTokens: 29,
      cacheReadTokens: 7,
      cacheCreationTokens: 11,
      costUsd: 0.5,
      host: "verify-host-c",
    });
    const saveLate = await raw.saveUsageEvents([late]);
    assertEqual(saveLate, { inserted: 1, deduped: 0 }, "late event save result");
    assertEqual(
      await rollup15m.getDailyTimeseries({ ...period, bucket: "15m", timezone: "UTC" }),
      await raw.getDailyTimeseries({ ...period, bucket: "15m", timezone: "UTC" }),
      "15m dirty fallback raw vs hybrid rollup",
    );
    await raw.compactUsage15mRollup(256);

    const insightQuery = {
      previous: { from: new Date("2019-12-31T00:00:00Z"), to: from },
      current: { from, to },
      providerKey,
      timezone: "UTC",
    };
    assertEqual(
      await rollup15m.getUserInsightComparison(userId, insightQuery),
      await raw.getUserInsightComparison(userId, insightQuery),
      "insights raw vs hybrid rollup",
    );

    assertEqual(await rollup.getOverview(period), await raw.getOverview(period), "overview raw vs rollup");
    assertEqual(
      await rollup.getDailyTimeseries({ ...period, bucket: "hour", timezone: "UTC" }),
      await raw.getDailyTimeseries({ ...period, bucket: "hour", timezone: "UTC" }),
      "hourly raw vs rollup",
    );
    assertEqual(
      await rollup.getUserModelTimeseries(userId, { ...period, bucket: "hour", timezone: "UTC" }),
      await raw.getUserModelTimeseries(userId, { ...period, bucket: "hour", timezone: "UTC" }),
      "model timeseries raw vs rollup",
    );
    assertEqual(
      await rollup15m.getDailyTimeseries({ ...period, bucket: "15m", timezone: "UTC" }),
      await raw.getDailyTimeseries({ ...period, bucket: "15m", timezone: "UTC" }),
      "15m raw vs hybrid rollup",
    );
    assertEqual(
      await rollup15m.getDailyTimeseries({ ...period, bucket: "30m", timezone: "UTC" }),
      await raw.getDailyTimeseries({ ...period, bucket: "30m", timezone: "UTC" }),
      "30m raw vs hybrid rollup",
    );
    assertEqual(
      await rollup15m.getDailyTimeseries({ ...period, bucket: "hour", timezone: "UTC" }),
      await raw.getDailyTimeseries({ ...period, bucket: "hour", timezone: "UTC" }),
      "hour raw vs hybrid rollup",
    );
    assertEqual(
      await rollup15m.getDailyTimeseries({ ...period, bucket: "day", timezone: "UTC" }),
      await raw.getDailyTimeseries({ ...period, bucket: "day", timezone: "UTC" }),
      "day raw vs hybrid rollup",
    );
    assertEqual(
      await rollup15m.getUserModelTimeseries(userId, { ...period, bucket: "15m", timezone: "UTC" }),
      await raw.getUserModelTimeseries(userId, { ...period, bucket: "15m", timezone: "UTC" }),
      "15m model timeseries raw vs hybrid rollup",
    );
    const partialPeriod = {
      from: new Date("2020-01-01T01:05:00.000Z"),
      to: new Date("2020-01-01T03:35:00.000Z"),
      providerKey,
    };
    assertEqual(
      await rollup15m.getDailyTimeseries({ ...partialPeriod, bucket: "15m", timezone: "UTC" }),
      await raw.getDailyTimeseries({ ...partialPeriod, bucket: "15m", timezone: "UTC" }),
      "15m partial-boundary raw vs hybrid rollup",
    );
    assertEqual(
      await rollup15m.getDailyTimeseries({ ...partialPeriod, bucket: "hour", timezone: "UTC" }),
      await raw.getDailyTimeseries({ ...partialPeriod, bucket: "hour", timezone: "UTC" }),
      "hour partial-boundary raw vs hybrid rollup",
    );
    assertEqual(
      await rollup15m.getDailyTimeseries({ ...partialPeriod, bucket: "day", timezone: "UTC" }),
      await raw.getDailyTimeseries({ ...partialPeriod, bucket: "day", timezone: "UTC" }),
      "day partial-boundary raw vs hybrid rollup",
    );
    assertEqual(
      await rollup15m.getUserModelTimeseries(userId, { ...partialPeriod, bucket: "15m", timezone: "UTC" }),
      await raw.getUserModelTimeseries(userId, { ...partialPeriod, bucket: "15m", timezone: "UTC" }),
      "15m partial-boundary model raw vs hybrid rollup",
    );
    assertEqual(
      await rollup.getLeaderboard({ ...period, scope: "user" }),
      await raw.getLeaderboard({ ...period, scope: "user" }),
      "user leaderboard raw vs rollup",
    );

    console.log(JSON.stringify({ ok: true, runId, inserted: insertedDuplicates + saveRest.inserted + saveLate.inserted }));
  } finally {
    await ch.close();
    await pg.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
