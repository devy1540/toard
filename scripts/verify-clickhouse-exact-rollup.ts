import { createClient } from "../packages/storage-clickhouse/node_modules/@clickhouse/client/dist/index.js";
import type { FinalizedUsageEvent } from "../packages/core/src/storage";
import {
  canonicalTimezoneId,
  firstInstantOfLocalDate,
} from "../packages/core/src/timezone";
import { ClickHouseStorage } from "../packages/storage-clickhouse/src/storage";
import {
  activateTimezoneRollupWith,
  type TimezoneRollupRepository,
} from "../apps/web/lib/timezone-rollup";
import { Pool, type PoolClient } from "pg";

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

async function compactUntil(
  compact: (limitBuckets: number) => Promise<{ watermark: string }>,
  target: Date,
  label: string,
): Promise<void> {
  for (let i = 0; i < 2_000; i++) {
    const result = await compact(256);
    if (new Date(result.watermark) >= target) return;
  }
  throw new Error(`${label} watermark did not reach ${target.toISOString()} within bounded retries`);
}

function chTs(d: Date): string {
  return d.toISOString().replace("T", " ").replace("Z", "");
}

type TimezoneTotals = {
  events: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  cost: number;
};

function timezoneTotals(row: {
  events?: string;
  input?: string;
  output?: string;
  cache_read?: string;
  cache_creation?: string;
  cost?: string;
} | undefined): TimezoneTotals {
  return {
    events: Number(row?.events ?? 0),
    input: Number(row?.input ?? 0),
    output: Number(row?.output ?? 0),
    cacheRead: Number(row?.cache_read ?? 0),
    cacheCreation: Number(row?.cache_creation ?? 0),
    cost: Number(row?.cost ?? 0),
  };
}

async function readTimezoneSourceTotals(
  ch: ReturnType<typeof createClient>,
  resolution: "hour" | "day",
  timezone: string,
  bucket: Date,
  providerKey: string,
): Promise<TimezoneTotals> {
  const canonical = canonicalTimezoneId(timezone);
  if (!canonical) throw new Error(`invalid timezone: ${timezone}`);
  const expression = resolution === "hour"
    ? `toStartOfInterval(bucket_15m, INTERVAL 1 HOUR, '${canonical}')`
    : `toStartOfDay(bucket_15m, '${canonical}')`;
  const result = await ch.query({
    query: `SELECT sum(event_count) AS events,
                   sum(input_tokens) AS input,
                   sum(output_tokens) AS output,
                   sum(cache_read_tokens) AS cache_read,
                   sum(cache_creation_tokens) AS cache_creation,
                   sum(cost_usd) AS cost
            FROM usage_15m_rollup_v2 FINAL
            WHERE provider_key = {provider:String}
              AND ${expression} = {bucket:DateTime64(3)}`,
    query_params: { provider: providerKey, bucket: chTs(bucket) },
    format: "JSONEachRow",
  });
  return timezoneTotals((await result.json<{
    events?: string;
    input?: string;
    output?: string;
    cache_read?: string;
    cache_creation?: string;
    cost?: string;
  }>())[0]);
}

async function readTimezoneCacheTotals(
  ch: ReturnType<typeof createClient>,
  resolution: "hour" | "day",
  timezone: string,
  bucket: Date,
  providerKey: string,
): Promise<TimezoneTotals> {
  const canonical = canonicalTimezoneId(timezone);
  if (!canonical) throw new Error(`invalid timezone: ${timezone}`);
  const table = resolution === "hour" ? "usage_hourly_timezone_rollup" : "usage_daily_timezone_rollup";
  const result = await ch.query({
    query: `SELECT sum(event_count) AS events,
                   sum(input_tokens) AS input,
                   sum(output_tokens) AS output,
                   sum(cache_read_tokens) AS cache_read,
                   sum(cache_creation_tokens) AS cache_creation,
                   sum(cost_usd) AS cost
            FROM ${table} FINAL
            WHERE timezone = {timezone:String}
              AND bucket_start = {bucket:DateTime64(3)}
              AND provider_key = {provider:String}`,
    query_params: { timezone: canonical, bucket: chTs(bucket), provider: providerKey },
    format: "JSONEachRow",
  });
  return timezoneTotals((await result.json<{
    events?: string;
    input?: string;
    output?: string;
    cache_read?: string;
    cache_creation?: string;
    cost?: string;
  }>())[0]);
}

async function timezoneHourStart(
  ch: ReturnType<typeof createClient>,
  timezone: string,
  at: Date,
): Promise<Date> {
  const canonical = canonicalTimezoneId(timezone);
  if (!canonical) throw new Error(`invalid timezone: ${timezone}`);
  const result = await ch.query({
    query: `SELECT toUnixTimestamp(
                     toStartOfInterval(toDateTime64({at:String}, 3, 'UTC'), INTERVAL 1 HOUR, '${canonical}')
                   ) AS epoch_seconds`,
    query_params: { at: chTs(at) },
    format: "JSONEachRow",
  });
  const row = (await result.json<{ epoch_seconds: string }>())[0];
  if (!row) throw new Error(`failed to resolve hourly bucket for ${timezone}`);
  return new Date(Number(row.epoch_seconds) * 1000);
}

function transactionalTimezoneRepository(
  client: PoolClient,
  enqueuedBuckets: Date[],
): TimezoneRollupRepository {
  return {
    async activateTimezone(timezone) {
      await client.query(
        `INSERT INTO clickhouse_rollup_timezones (timezone)
         VALUES ($1)
         ON CONFLICT (timezone) DO UPDATE SET last_requested_at = now()`,
        [timezone],
      );
      return true;
    },
    async enqueueJobs(resolution, timezone, buckets) {
      enqueuedBuckets.push(...buckets);
      await client.query(
        `INSERT INTO clickhouse_timezone_rollup_jobs (resolution, timezone, bucket)
         SELECT $1, $2, bucket
         FROM unnest($3::timestamptz[]) AS bucket
         ON CONFLICT (resolution, timezone, bucket) DO UPDATE
         SET status = 'pending', updated_at = now()`,
        [resolution, timezone, buckets],
      );
    },
  } as unknown as TimezoneRollupRepository;
}

function hourBucket(d: Date): string {
  const bucket = new Date(d);
  bucket.setUTCMinutes(0, 0, 0);
  return chTs(bucket);
}

function pricedEvent(base: {
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
}): FinalizedUsageEvent {
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
    pricingRevisionId: "00000000-0000-0000-0000-000000000001",
    costStatus: "priced",
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
  const from = new Date("2026-04-15T00:00:00.000Z");
  const to = new Date("2026-04-16T00:00:00.000Z");

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
    const v2 = new ClickHouseStorage(ch, pg, { timezone: "UTC", read15mV2Rollup: true });

    const duplicate = pricedEvent({
      dedupKey: `${runId}:duplicate`,
      providerKey,
      userId,
      sessionId: `${runId}:s1`,
      model: "verify-model-a",
      ts: new Date("2026-04-15T01:10:00.000Z"),
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
      pricedEvent({
        dedupKey: `${runId}:2`,
        providerKey,
        userId,
        sessionId: `${runId}:s1`,
        model: "verify-model-a",
        ts: new Date("2026-04-15T01:20:00.000Z"),
        inputTokens: 7,
        outputTokens: 11,
        costUsd: 0.2,
        host: "verify-host-a",
      }),
      pricedEvent({
        dedupKey: `${runId}:3`,
        providerKey,
        userId,
        sessionId: `${runId}:s2`,
        model: "verify-model-b",
        ts: new Date("2026-04-15T02:00:00.000Z"),
        inputTokens: 5,
        outputTokens: 13,
        cacheReadTokens: 2,
        costUsd: 0.3,
        host: "verify-host-b",
      }),
      pricedEvent({
        dedupKey: `${runId}:4`,
        providerKey,
        userId,
        sessionId: `${runId}:s3`,
        model: "verify-model-b",
        ts: new Date("2026-04-15T03:30:00.000Z"),
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
        ts: "2026-04-15 01:10:00.000",
        input_tokens: duplicate.inputTokens,
        output_tokens: duplicate.outputTokens,
        cache_read_tokens: duplicate.cacheReadTokens,
        cache_creation_tokens: duplicate.cacheCreationTokens,
        cost_usd: "0.12345678",
        pricing_revision_id: duplicate.pricingRevisionId,
        cost_status: duplicate.costStatus,
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

    const canonicalDuplicate = pricedEvent({
      dedupKey: `${runId}:canonical-duplicate`,
      providerKey: `${runId}:canonical-provider`,
      userId,
      sessionId: `${runId}:canonical-session`,
      model: "verify-model-canonical",
      ts: new Date("2026-04-15T01:12:00.000Z"),
      inputTokens: 31,
      outputTokens: 37,
      cacheReadTokens: 7,
      cacheCreationTokens: 11,
      costUsd: 0.6,
      host: "verify-host-canonical",
    });
    const canonicalRawRow = {
      dedup_key: canonicalDuplicate.dedupKey,
      provider_key: canonicalDuplicate.providerKey,
      user_id: canonicalDuplicate.userId ?? "",
      team_id: teamId,
      session_id: canonicalDuplicate.sessionId ?? "",
      model: canonicalDuplicate.model ?? "",
      ts: chTs(canonicalDuplicate.ts),
      input_tokens: canonicalDuplicate.inputTokens,
      output_tokens: canonicalDuplicate.outputTokens,
      cache_read_tokens: canonicalDuplicate.cacheReadTokens,
      cache_creation_tokens: canonicalDuplicate.cacheCreationTokens,
      cost_usd: canonicalDuplicate.costUsd.toFixed(8),
      pricing_revision_id: canonicalDuplicate.pricingRevisionId,
      cost_status: canonicalDuplicate.costStatus,
      log_adapter: "",
      host: canonicalDuplicate.host ?? "",
    };
    await ch.command({ query: "SYSTEM STOP MERGES usage_events" });
    try {
      for (const tokenSuffix of ["a", "b"]) {
        await ch.insert({
          table: "usage_events",
          values: [canonicalRawRow],
          format: "JSONEachRow",
          clickhouse_settings: {
            insert_deduplication_token: `${runId}:canonical:${tokenSuffix}`,
          },
        });
      }
      const physicalDuplicates = await ch.query({
        query: "SELECT count() AS rows FROM usage_events WHERE dedup_key = {key:String}",
        query_params: { key: canonicalDuplicate.dedupKey },
        format: "JSONEachRow",
      });
      const physicalDuplicateRows = (await physicalDuplicates.json<{ rows: string }>())[0]!;
      assertEqual(Number(physicalDuplicateRows.rows), 2, "different-token physical raw duplicate rows");

      await compactUntil((limit) => v2.compactUsage15mV2(limit), to, "15m v2 rollup");
      const canonicalV2 = await ch.query({
        query: `SELECT sum(event_count) AS events,
                       sum(input_tokens) AS input,
                       sum(output_tokens) AS output,
                       sum(cache_read_tokens) AS cache_read,
                       sum(cache_creation_tokens) AS cache_creation,
                       sum(cost_usd) AS cost
                FROM usage_15m_rollup_v2 FINAL
                WHERE provider_key = {provider:String}`,
        query_params: { provider: canonicalDuplicate.providerKey },
        format: "JSONEachRow",
      });
      const canonicalV2Rows = (await canonicalV2.json<{
        events: string;
        input: string;
        output: string;
        cache_read: string;
        cache_creation: string;
        cost: string;
      }>())[0]!;
      assertEqual(
        {
          events: Number(canonicalV2Rows.events),
          input: Number(canonicalV2Rows.input),
          output: Number(canonicalV2Rows.output),
          cacheRead: Number(canonicalV2Rows.cache_read),
          cacheCreation: Number(canonicalV2Rows.cache_creation),
          cost: Number(canonicalV2Rows.cost),
        },
        {
          events: 1,
          input: canonicalDuplicate.inputTokens,
          output: canonicalDuplicate.outputTokens,
          cacheRead: canonicalDuplicate.cacheReadTokens,
          cacheCreation: canonicalDuplicate.cacheCreationTokens,
          cost: canonicalDuplicate.costUsd,
        },
        "different-token duplicate canonical v2 totals",
      );
    } finally {
      await ch.command({ query: "SYSTEM START MERGES usage_events" });
    }

    await compactUntil((limit) => raw.compactUsage15mRollup(limit), to, "15m rollup");
    const rollup15mRows = await ch.query({
      query: "SELECT count() AS rows FROM usage_15m_rollup WHERE provider_key = {provider:String}",
      query_params: { provider: providerKey },
      format: "JSONEachRow",
    });
    const rollup15mCount = (await rollup15mRows.json<{ rows: string }>())[0]!;
    if (Number(rollup15mCount.rows) === 0) throw new Error("15m rollup compaction produced no rows");
    const rollup15mV2Rows = await ch.query({
      query: "SELECT count() AS rows FROM usage_15m_rollup_v2 WHERE provider_key = {provider:String}",
      query_params: { provider: providerKey },
      format: "JSONEachRow",
    });
    const rollup15mV2Count = (await rollup15mV2Rows.json<{ rows: string }>())[0]!;
    if (Number(rollup15mV2Count.rows) === 0) throw new Error("15m v2 rollup compaction produced no rows");

    const watermark = await pg.query<{ watermark: Date }>(
      "SELECT watermark FROM clickhouse_rollup_watermarks WHERE name = 'usage_15m'",
    );
    const watermarkValue = watermark.rows[0]?.watermark;
    if (!watermarkValue || watermarkValue < to) {
      throw new Error(`15m rollup watermark did not cover verification period: ${watermarkValue?.toISOString() ?? "missing"}`);
    }
    const v2Watermark = await pg.query<{ watermark: Date }>(
      "SELECT watermark FROM clickhouse_rollup_watermarks WHERE name = 'usage_15m_v2'",
    );
    const v2WatermarkValue = v2Watermark.rows[0]?.watermark;
    if (!v2WatermarkValue || v2WatermarkValue < to) {
      throw new Error(`15m v2 rollup watermark did not cover verification period: ${v2WatermarkValue?.toISOString() ?? "missing"}`);
    }

    const period = { from, to, providerKey };
    const late = pricedEvent({
      dedupKey: `${runId}:late`,
      providerKey,
      userId,
      sessionId: `${runId}:s4`,
      model: "verify-model-c",
      ts: new Date("2026-04-15T10:05:00.000Z"),
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
    assertEqual(
      await v2.getDailyTimeseries({ ...period, bucket: "15m", timezone: "UTC" }),
      await raw.getDailyTimeseries({ ...period, bucket: "15m", timezone: "UTC" }),
      "15m v2 dirty fallback raw equivalence",
    );
    await raw.compactUsage15mRollup(256);
    await v2.compactUsage15mV2(256);

    const insightQuery = {
      previous: { from: new Date("2026-04-14T00:00:00Z"), to: from },
      current: { from, to },
      providerKey,
      timezone: "UTC",
    };
    assertEqual(
      await rollup15m.getUserInsightComparison(userId, insightQuery),
      await raw.getUserInsightComparison(userId, insightQuery),
      "insights raw vs hybrid rollup",
    );
    const unalignedInsightQuery = {
      previous: { from, to: new Date("2026-04-15T01:17:00.000Z") },
      current: { from: new Date("2026-04-15T01:23:00.000Z"), to: new Date("2026-04-15T04:00:00.000Z") },
      providerKey,
      timezone: "UTC",
    };
    assertEqual(
      await rollup15m.getUserInsightComparison(userId, unalignedInsightQuery),
      await raw.getUserInsightComparison(userId, unalignedInsightQuery),
      "insights unaligned period boundaries raw vs hybrid rollup",
    );
    assertEqual(
      await v2.getUserInsightComparison(userId, unalignedInsightQuery),
      await raw.getUserInsightComparison(userId, unalignedInsightQuery),
      "insights unaligned period boundaries raw vs v2 rollup",
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
      await v2.getDailyTimeseries({ ...period, bucket: "15m", timezone: "UTC" }),
      await raw.getDailyTimeseries({ ...period, bucket: "15m", timezone: "UTC" }),
      "15m raw vs v2 rollup",
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
      from: new Date("2026-04-15T01:05:00.000Z"),
      to: new Date("2026-04-15T03:35:00.000Z"),
      providerKey,
    };
    assertEqual(
      await rollup15m.getDailyTimeseries({ ...partialPeriod, bucket: "15m", timezone: "UTC" }),
      await raw.getDailyTimeseries({ ...partialPeriod, bucket: "15m", timezone: "UTC" }),
      "15m partial-boundary raw vs hybrid rollup",
    );
    assertEqual(
      await v2.getDailyTimeseries({ ...partialPeriod, bucket: "15m", timezone: "UTC" }),
      await raw.getDailyTimeseries({ ...partialPeriod, bucket: "15m", timezone: "UTC" }),
      "15m partial-boundary raw vs v2 rollup",
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

    const timezoneProviderKey = `${runId}:timezone-provider`;
    const marchTimezoneRows = Array.from(
      { length: (4 * 24 * 60) / 15 },
      (_, index) => ({
        bucket_15m: chTs(new Date(Date.UTC(2026, 2, 7) + index * 15 * 60 * 1000)),
        provider_key: timezoneProviderKey,
        user_id: userId,
        team_id: teamId,
        session_id: `${runId}:timezone-session`,
        model: "verify-timezone-model",
        host: "verify-timezone-host",
        pricing_revision_id: "00000000-0000-0000-0000-000000000001",
        cost_status: "priced",
        event_count: 1,
        input_tokens: 2,
        output_tokens: 3,
        cache_read_tokens: 5,
        cache_creation_tokens: 7,
        cost_usd: "0.01000000",
        version: Date.now(),
      }),
    );
    const santiagoTimezoneRows = Array.from(
      { length: 23 * 4 },
      (_, index) => ({
        bucket_15m: chTs(new Date(Date.UTC(2025, 8, 7, 4) + index * 15 * 60 * 1000)),
        provider_key: timezoneProviderKey,
        user_id: userId,
        team_id: teamId,
        session_id: `${runId}:santiago-session`,
        model: "verify-timezone-model",
        host: "verify-timezone-host",
        pricing_revision_id: "00000000-0000-0000-0000-000000000001",
        cost_status: "priced",
        event_count: 1,
        input_tokens: 2,
        output_tokens: 3,
        cache_read_tokens: 5,
        cache_creation_tokens: 7,
        cost_usd: "0.01000000",
        version: Date.now(),
      }),
    );
    const timezoneRows = [...marchTimezoneRows, ...santiagoTimezoneRows];
    await ch.insert({
      table: "usage_15m_rollup_v2",
      values: timezoneRows,
      format: "JSONEachRow",
    });

    const verifiedTimezones = [
      "Asia/Seoul",
      "America/Los_Angeles",
      "Asia/Kolkata",
      "Asia/Kathmandu",
      "Europe/London",
    ] as const;
    for (const timezone of verifiedTimezones) {
      const dayBucket = firstInstantOfLocalDate("2026-03-08", timezone);
      await v2.compactTimezoneRollup("day", timezone, dayBucket);
      const daySource = await readTimezoneSourceTotals(ch, "day", timezone, dayBucket, timezoneProviderKey);
      const dayCache = await readTimezoneCacheTotals(ch, "day", timezone, dayBucket, timezoneProviderKey);
      assertEqual(dayCache, daySource, `${timezone} daily timezone cache vs 15m v2`);
      if (timezone === "America/Los_Angeles") {
        assertEqual(daySource.events, 23 * 4, "Los Angeles DST transition day 15m bucket count");
      }

      const hourBucket = await timezoneHourStart(ch, timezone, new Date("2026-03-08T12:34:00.000Z"));
      await v2.compactTimezoneRollup("hour", timezone, hourBucket);
      const hourSource = await readTimezoneSourceTotals(ch, "hour", timezone, hourBucket, timezoneProviderKey);
      const hourCache = await readTimezoneCacheTotals(ch, "hour", timezone, hourBucket, timezoneProviderKey);
      assertEqual(hourCache, hourSource, `${timezone} hourly timezone cache vs 15m v2`);
      assertEqual(hourSource.events, 4, `${timezone} hourly 15m bucket count`);
    }

    const hybridRouterTimezone = "America/Los_Angeles";
    const hybridCacheFrom = firstInstantOfLocalDate("2026-03-08", hybridRouterTimezone);
    const hybridCacheTo = firstInstantOfLocalDate("2026-03-09", hybridRouterTimezone);
    const hybridTo = new Date("2026-03-09T12:34:00.000Z");
    const routeTx = await pg.connect();
    try {
      await routeTx.query("BEGIN");
      await routeTx.query(
        `INSERT INTO clickhouse_rollup_timezones (timezone)
         VALUES ($1)
         ON CONFLICT (timezone) DO UPDATE SET last_requested_at = now()`,
        [hybridRouterTimezone],
      );
      await routeTx.query(
        `INSERT INTO clickhouse_timezone_rollup_jobs (resolution, timezone, bucket, status)
         VALUES ('day', $1, $2, 'done')
         ON CONFLICT (resolution, timezone, bucket) DO UPDATE SET status = 'done', updated_at = now()`,
        [hybridRouterTimezone, hybridCacheFrom],
      );
      const routedPg = {
        query: (text: string, values?: unknown[]) => routeTx.query(text, values),
      } as unknown as Pool;
      const routed = new ClickHouseStorage(ch, routedPg, {
        timezone: hybridRouterTimezone,
        readRollup: true,
        read15mV2Rollup: true,
      });
      const hybridPeriod = {
        from: hybridCacheFrom,
        to: hybridTo,
        providerKey: timezoneProviderKey,
        bucket: "day" as const,
        timezone: hybridRouterTimezone,
      };
      assertEqual(
        await routed.getDailyTimeseries(hybridPeriod),
        await v2.getDailyTimeseries(hybridPeriod),
        "timezone cache plus exact tail daily equivalence",
      );
      assertEqual(
        await routed.getOverview(hybridPeriod),
        await v2.getOverview(hybridPeriod),
        "timezone cache plus exact tail overview equivalence",
      );
      assertEqual(hybridCacheTo.toISOString(), "2026-03-09T07:00:00.000Z", "hybrid DST cache boundary");
    } finally {
      await routeTx.query("ROLLBACK").catch(() => undefined);
      routeTx.release();
    }

    const santiagoBucket = firstInstantOfLocalDate("2025-09-07", "America/Santiago");
    assertEqual(santiagoBucket.toISOString(), "2025-09-07T04:00:00.000Z", "Santiago local-date first instant");
    await v2.compactTimezoneRollup("day", "America/Santiago", santiagoBucket);
    const santiagoSource = await readTimezoneSourceTotals(
      ch,
      "day",
      "America/Santiago",
      santiagoBucket,
      timezoneProviderKey,
    );
    const santiagoCache = await readTimezoneCacheTotals(
      ch,
      "day",
      "America/Santiago",
      santiagoBucket,
      timezoneProviderKey,
    );
    assertEqual(santiagoSource.events, 23 * 4, "Santiago midnight-gap non-empty source count");
    assertEqual(santiagoCache, santiagoSource, "Santiago daily timezone cache vs 15m v2");

    assertEqual(await v2.supportsTimezone("US/Pacific"), true, "ClickHouse canonical alias capability");
    assertEqual(await v2.supportsTimezone("America/Coyhaique"), false, "ClickHouse Node-only timezone capability");

    const tx = await pg.connect();
    const aliasBuckets: Date[] = [];
    try {
      await tx.query("BEGIN");
      const repository = transactionalTimezoneRepository(tx, aliasBuckets);
      const supportsTimezone = (timezone: string) => v2.supportsTimezone(timezone);
      let unsupportedRejected = false;
      try {
        await activateTimezoneRollupWith(
          repository,
          "America/Coyhaique",
          new Date("2026-07-10T12:00:00.000Z"),
          supportsTimezone,
        );
      } catch {
        unsupportedRejected = true;
      }
      assertEqual(unsupportedRejected, true, "unsupported timezone rejected before registry write");

      const activationNow = new Date("2026-07-10T12:00:00.000Z");
      await activateTimezoneRollupWith(repository, "US/Pacific", activationNow, supportsTimezone);
      await activateTimezoneRollupWith(repository, "America/Los_Angeles", activationNow, supportsTimezone);
      const uniqueAliasBuckets = [...new Map(aliasBuckets.map((bucket) => [bucket.toISOString(), bucket])).values()];
      const registry = await tx.query<{ timezone: string }>(
        `SELECT timezone FROM clickhouse_rollup_timezones
         WHERE timezone IN ('US/Pacific', 'America/Los_Angeles')
         ORDER BY timezone`,
      );
      const jobs = await tx.query<{ timezone: string; count: string }>(
        `SELECT timezone, count(*)::text AS count
         FROM clickhouse_timezone_rollup_jobs
         WHERE resolution = 'day'
           AND timezone IN ('US/Pacific', 'America/Los_Angeles')
           AND bucket = ANY($1::timestamptz[])
         GROUP BY timezone
         ORDER BY timezone`,
        [uniqueAliasBuckets],
      );
      assertEqual(registry.rows, [{ timezone: "America/Los_Angeles" }], "canonical timezone registry key");
      assertEqual(jobs.rows, [{ timezone: "America/Los_Angeles", count: "400" }], "canonical timezone job keys");
    } finally {
      await tx.query("ROLLBACK").catch(() => undefined);
      tx.release();
    }

    const duplicateJobBucket = new Date();
    await pg.query(
      `INSERT INTO clickhouse_timezone_rollup_jobs (resolution, timezone, bucket, status)
       VALUES ('day', 'Asia/Seoul', $1, 'done')`,
      [duplicateJobBucket],
    );
    await pg.query(
      `INSERT INTO clickhouse_timezone_rollup_jobs (resolution, timezone, bucket)
       VALUES ('day', 'Asia/Seoul', $1)
       ON CONFLICT (resolution, timezone, bucket) DO UPDATE
       SET status = 'pending', updated_at = now()`,
      [duplicateJobBucket],
    );
    const duplicateJobs = await pg.query<{ count: string; status: string }>(
      `SELECT count(*)::text AS count, min(status) AS status
       FROM clickhouse_timezone_rollup_jobs
       WHERE resolution = 'day' AND timezone = 'Asia/Seoul' AND bucket = $1`,
      [duplicateJobBucket],
    );
    assertEqual(Number(duplicateJobs.rows[0]?.count), 1, "timezone rollup duplicate PG job count");
    assertEqual(duplicateJobs.rows[0]?.status, "pending", "timezone rollup completed job requeue status");
    await pg.query(
      `DELETE FROM clickhouse_timezone_rollup_jobs
       WHERE resolution = 'day' AND timezone = 'Asia/Seoul' AND bucket = $1`,
      [duplicateJobBucket],
    );

    console.log(JSON.stringify({
      ok: true,
      runId,
      inserted: insertedDuplicates + saveRest.inserted + saveLate.inserted,
      verifiedTimezones,
      hybridRouterTimezone,
      verifiedMidnightGapTimezone: "America/Santiago",
      timezoneRows: timezoneRows.length,
    }));
  } finally {
    await ch.close();
    await pg.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
