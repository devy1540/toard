import { performance } from "node:perf_hooks";
import { createClient } from "../packages/storage-clickhouse/node_modules/@clickhouse/client/dist/index.js";

const FIXTURE_ID = "timezone-rollup-v1";
const FIXTURE_PREFIX = "__toard_benchmark_timezone_v1__";
const EXPECTED_EVENTS = 1_000_000;
const EXPECTED_DAYS = 400;
const EXPECTED_USERS = 100;
const EXPECTED_PROVIDERS = 5;
const EXPECTED_MODELS = 10;
const EXPECTED_RUNS = 100;
const SEED_BATCH_SIZE = 100_000;
const P50_MAX_MS = 1_000;
const P95_MAX_MS = 2_000;
const TIMEZONES = [
  "Asia/Seoul",
  "America/Los_Angeles",
  "Asia/Kolkata",
  "Asia/Kathmandu",
  "Europe/London",
] as const;

type SeedMode = "if-missing" | "always" | "never";

type BenchmarkOptions = {
  fixture: string;
  events: number;
  days: number;
  runs: number;
  seed: SeedMode;
};

type FixtureStats = {
  events: string;
  days: string;
  users: string;
  providers: string;
  models: string;
};

function assertLocalUrl(name: string, value: string | undefined): string {
  const raw = value ?? "";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be a valid localhost URL`);
  }
  if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1" && url.hostname !== "::1") {
    throw new Error(`${name} must point at localhost/127.0.0.1/::1; production benchmark seed is forbidden`);
  }
  return raw;
}

function assertDevelopmentEnvironment(): void {
  const markers = [process.env.NODE_ENV, process.env.TOARD_ENV, process.env.ENVIRONMENT, process.env.VERCEL_ENV]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.toLowerCase());
  if (markers.some((value) => value === "production" || value === "prod")) {
    throw new Error("timezone rollup benchmark seed is forbidden in production");
  }
}

function parsePositiveInt(name: string, value: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

export function parseBenchmarkOptions(args: readonly string[]): BenchmarkOptions {
  const options: BenchmarkOptions = {
    fixture: FIXTURE_ID,
    events: EXPECTED_EVENTS,
    days: EXPECTED_DAYS,
    runs: EXPECTED_RUNS,
    seed: "if-missing",
  };
  for (const arg of args) {
    const [name, value] = arg.split("=", 2);
    if (!value) throw new Error(`invalid benchmark argument: ${arg}`);
    if (name === "--fixture") options.fixture = value;
    else if (name === "--events") options.events = parsePositiveInt(name, value);
    else if (name === "--days") options.days = parsePositiveInt(name, value);
    else if (name === "--runs") options.runs = parsePositiveInt(name, value);
    else if (name === "--seed" && (value === "if-missing" || value === "always" || value === "never")) {
      options.seed = value;
    } else {
      throw new Error(`unsupported benchmark argument: ${arg}`);
    }
  }
  if (options.fixture !== FIXTURE_ID) throw new Error(`--fixture must be ${FIXTURE_ID}`);
  if (options.events !== EXPECTED_EVENTS) throw new Error(`--events must be ${EXPECTED_EVENTS}`);
  if (options.days !== EXPECTED_DAYS) throw new Error(`--days must be ${EXPECTED_DAYS}`);
  if (options.runs !== EXPECTED_RUNS) throw new Error(`--runs must be ${EXPECTED_RUNS}`);
  return options;
}

function utcStartOfToday(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function clickHouseTimestamp(date: Date): string {
  return date.toISOString().replace("T", " ").replace("Z", "");
}

function validFixture(stats: FixtureStats | undefined): boolean {
  return Boolean(stats)
    && Number(stats!.events) === EXPECTED_EVENTS
    && Number(stats!.days) === EXPECTED_DAYS
    && Number(stats!.users) === EXPECTED_USERS
    && Number(stats!.providers) === EXPECTED_PROVIDERS
    && Number(stats!.models) === EXPECTED_MODELS;
}

async function fixtureStats(ch: ReturnType<typeof createClient>): Promise<FixtureStats | undefined> {
  const result = await ch.query({
    query: `SELECT count() AS events,
                   uniqExact(toDate(ts)) AS days,
                   uniqExact(user_id) AS users,
                   uniqExact(provider_key) AS providers,
                   uniqExact(model) AS models
            FROM usage_events FINAL
            WHERE startsWith(dedup_key, {prefix:String})`,
    query_params: { prefix: FIXTURE_PREFIX },
    format: "JSONEachRow",
  });
  return (await result.json<FixtureStats>())[0];
}

async function assertRawRetentionDisabled(ch: ReturnType<typeof createClient>): Promise<void> {
  const result = await ch.query({ query: "SHOW CREATE TABLE usage_events", format: "JSONEachRow" });
  const row = (await result.json<Record<string, string>>())[0];
  const ddl = Object.values(row ?? {}).join("\n");
  if (/TTL[\s\S]*INTERVAL\s+90\s+DAY/i.test(ddl)) {
    throw new Error("local usage_events has the 90-day production TTL; use a fresh local dev volume for the 400-day benchmark fixture");
  }
}

async function removeFixture(ch: ReturnType<typeof createClient>): Promise<void> {
  await ch.command({
    query: `ALTER TABLE usage_events
            DELETE WHERE startsWith(dedup_key, {prefix:String})
            SETTINGS mutations_sync = 2`,
    query_params: { prefix: FIXTURE_PREFIX },
  });
  for (const timezone of TIMEZONES) {
    await ch.command({
      query: `ALTER TABLE usage_daily_timezone_rollup
              DELETE WHERE timezone = {timezone:String}
                AND startsWith(provider_key, {prefix:String})
              SETTINGS mutations_sync = 2`,
      query_params: { timezone, prefix: FIXTURE_PREFIX },
    });
  }
}

async function seedEvents(ch: ReturnType<typeof createClient>, fixtureStart: Date): Promise<void> {
  await removeFixture(ch);
  for (let offset = 0; offset < EXPECTED_EVENTS; offset += SEED_BATCH_SIZE) {
    const count = Math.min(SEED_BATCH_SIZE, EXPECTED_EVENTS - offset);
    await ch.command({
      query: `INSERT INTO usage_events
              (dedup_key, provider_key, user_id, team_id, session_id, model, ts,
               input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
               cost_usd, pricing_revision_id, cost_status, log_adapter, host)
              SELECT concat({prefix:String}, toString(number)),
                     concat({prefix:String}, 'provider-', toString(number % ${EXPECTED_PROVIDERS})),
                     concat({prefix:String}, 'user-', toString(number % ${EXPECTED_USERS})),
                     concat({prefix:String}, 'team-', toString(number % 10)),
                     '',
                     concat({prefix:String}, 'model-', toString(number % ${EXPECTED_MODELS})),
                     toDateTime64({fixtureStart:String}, 3, 'UTC')
                       + toIntervalSecond(toInt64(intDiv(number, 2500) * 86400 + (number % 2500) * 34)),
                     100 + (number % 100),
                     50 + (number % 50),
                     number % 20,
                     number % 10,
                     toDecimal64((number % 1000) / 100000, 8),
                     'benchmark-pricing-v1',
                     'priced',
                     '',
                     concat('benchmark-host-', toString(number % 4))
              FROM numbers(${offset}, ${count})`,
      query_params: {
        prefix: FIXTURE_PREFIX,
        fixtureStart: clickHouseTimestamp(fixtureStart),
      },
    });
    console.log(`[benchmark] raw fixture seed ${offset + count}/${EXPECTED_EVENTS}`);
  }
}

async function validateFixture(ch: ReturnType<typeof createClient>): Promise<void> {
  const stats = await fixtureStats(ch);
  if (!validFixture(stats)) {
    throw new Error(
      `invalid ${FIXTURE_ID} fixture: expected events=${EXPECTED_EVENTS}, days=${EXPECTED_DAYS}, users=${EXPECTED_USERS}, providers=${EXPECTED_PROVIDERS}, models=${EXPECTED_MODELS}; actual=${JSON.stringify(stats ?? null)}`,
    );
  }
  console.log(`[benchmark] fixture validated ${JSON.stringify(stats)}`);
}

async function timezoneCacheRows(
  ch: ReturnType<typeof createClient>,
  timezone: typeof TIMEZONES[number],
): Promise<number> {
  const result = await ch.query({
    query: `SELECT count() AS rows
            FROM usage_daily_timezone_rollup FINAL
            WHERE timezone = {timezone:String}
              AND startsWith(provider_key, {prefix:String})`,
    query_params: { timezone, prefix: FIXTURE_PREFIX },
    format: "JSONEachRow",
  });
  return Number((await result.json<{ rows: string }>())[0]?.rows ?? 0);
}

async function ensureTimezoneCaches(
  ch: ReturnType<typeof createClient>,
  seedMode: SeedMode,
): Promise<void> {
  const version = Date.now();
  for (const timezone of TIMEZONES) {
    const existingRows = await timezoneCacheRows(ch, timezone);
    if (existingRows >= EXPECTED_DAYS * EXPECTED_USERS && seedMode !== "always") {
      console.log(`[benchmark] timezone cache validated ${timezone} rows=${existingRows}`);
      continue;
    }
    if (seedMode === "never") {
      throw new Error(`${timezone} cache fixture is missing or incomplete and --seed=never was requested`);
    }
    await ch.command({
      query: `ALTER TABLE usage_daily_timezone_rollup
              DELETE WHERE timezone = {timezone:String}
                AND startsWith(provider_key, {prefix:String})
              SETTINGS mutations_sync = 2`,
      query_params: { timezone, prefix: FIXTURE_PREFIX },
    });
    await ch.command({
      query: `INSERT INTO usage_daily_timezone_rollup
              SELECT {timezone:String} AS timezone,
                     toStartOfDay(ts, {timezone:String}) AS bucket_start,
                     user_id,
                     team_id,
                     provider_key,
                     model,
                     host,
                     session_id,
                     pricing_revision_id,
                     cost_status,
                     count() AS event_count,
                     sum(input_tokens) AS input_tokens,
                     sum(output_tokens) AS output_tokens,
                     sum(cache_read_tokens) AS cache_read_tokens,
                     sum(cache_creation_tokens) AS cache_creation_tokens,
                     sum(cost_usd) AS cost_usd,
                     {version:UInt64} AS version
              FROM usage_events FINAL
              WHERE startsWith(dedup_key, {prefix:String})
              GROUP BY bucket_start, user_id, team_id, provider_key, model, host, session_id,
                       pricing_revision_id, cost_status`,
      query_params: { timezone, prefix: FIXTURE_PREFIX, version },
    });
    const rows = await timezoneCacheRows(ch, timezone);
    if (rows < EXPECTED_DAYS * EXPECTED_USERS) {
      throw new Error(`${timezone} cache fixture is incomplete: ${rows} rows`);
    }
    console.log(`[benchmark] timezone cache ${timezone} rows=${rows}`);
  }
}

async function clearCaches(ch: ReturnType<typeof createClient>): Promise<void> {
  await ch.command({ query: "SYSTEM DROP QUERY CACHE" });
  await ch.command({ query: "SYSTEM DROP UNCOMPRESSED CACHE" });
  await ch.command({ query: "SYSTEM DROP MARK CACHE" });
}

async function benchmarkTimezone(
  ch: ReturnType<typeof createClient>,
  timezone: typeof TIMEZONES[number],
  from: Date,
  to: Date,
): Promise<{ p50: number; p95: number }> {
  const durations: number[] = [];
  for (let run = 0; run < EXPECTED_RUNS; run++) {
    await clearCaches(ch);
    const startedAt = performance.now();
    const result = await ch.query({
      query: `SELECT bucket_start,
                     sum(event_count) AS events,
                     sum(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens) AS tokens,
                     sum(cost_usd) AS cost
              FROM usage_daily_timezone_rollup FINAL
              WHERE timezone = {timezone:String}
                AND bucket_start >= {from:DateTime64(3)}
                AND bucket_start < {to:DateTime64(3)}
                AND startsWith(provider_key, {prefix:String})
              GROUP BY bucket_start
              ORDER BY bucket_start`,
      query_params: {
        timezone,
        from: clickHouseTimestamp(from),
        to: clickHouseTimestamp(to),
        prefix: FIXTURE_PREFIX,
      },
      format: "JSONEachRow",
      clickhouse_settings: { use_query_cache: 0 },
    });
    const rows = await result.json<Record<string, string>>();
    durations.push(performance.now() - startedAt);
    if (rows.length < 360 || rows.length > 366) {
      throw new Error(`${timezone} 12-month query returned unexpected ${rows.length} daily rows`);
    }
  }
  const sorted = durations.toSorted((a, b) => a - b);
  return { p50: sorted[49]!, p95: sorted[94]! };
}

async function main(): Promise<void> {
  const options = parseBenchmarkOptions(process.argv.slice(2));
  assertDevelopmentEnvironment();
  const clickhouseUrl = assertLocalUrl(
    "CLICKHOUSE_URL",
    process.env.CLICKHOUSE_URL ?? "http://localhost:8123",
  );
  const ch = createClient({
    url: clickhouseUrl,
    username: process.env.CLICKHOUSE_USER ?? "toard",
    password: process.env.CLICKHOUSE_PASSWORD ?? "toard",
    database: process.env.CLICKHOUSE_DB ?? "toard",
  });
  try {
    await assertRawRetentionDisabled(ch);
    const current = await fixtureStats(ch);
    const seedRequired = options.seed === "always" || !validFixture(current);
    if (seedRequired && options.seed === "never") {
      throw new Error(`${FIXTURE_ID} fixture is missing or invalid and --seed=never was requested`);
    }
    if (seedRequired) {
      const fixtureStart = new Date(utcStartOfToday().getTime() - (EXPECTED_DAYS - 1) * 86_400_000);
      await seedEvents(ch, fixtureStart);
    }
    await validateFixture(ch);
    await ensureTimezoneCaches(ch, options.seed);

    const to = utcStartOfToday();
    const from = new Date(to.getTime() - 365 * 86_400_000);
    let failed = false;
    for (const timezone of TIMEZONES) {
      const { p50, p95 } = await benchmarkTimezone(ch, timezone, from, to);
      const passed = p50 <= P50_MAX_MS && p95 <= P95_MAX_MS;
      console.log(`${timezone} runs=${EXPECTED_RUNS} p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms ${passed ? "PASS" : "FAIL"}`);
      if (!passed) failed = true;
    }
    if (failed) process.exitCode = 1;
  } finally {
    await ch.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
