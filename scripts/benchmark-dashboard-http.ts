import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import bcrypt from "bcryptjs";
import { createClient, type ClickHouseClient } from "../packages/storage-clickhouse/node_modules/@clickhouse/client/dist/index.js";
import { Pool } from "pg";
import { canonicalTimezoneId } from "../packages/core/src/timezone";
import { ClickHouseStorage } from "../packages/storage-clickhouse/src/storage";
import {
  activateTimezoneRollupWith,
  createPgTimezoneRollupRepository,
  runTimezoneRollupWorkerWith,
} from "../apps/web/lib/timezone-rollup";
import {
  assertDashboardResponse,
  assertAppCgroupLimits,
  assertBenchmarkTarget,
  assertNonProductionBenchmarkEnvironment,
  assertTimezoneFixtureCoverage,
  benchmarkExecutionMode,
  benchmarkPercentiles,
  dashboardFixtureStart,
  parseDashboardBenchmarkOptions,
} from "./benchmark-dashboard-http-lib";

const FIXTURE_PREFIX = "__toard_benchmark_dashboard_http_v1__";
const EXPECTED_EVENTS = 1_000_000;
const EXPECTED_DAYS = 400;
const EXPECTED_USERS = 100;
const EXPECTED_PROVIDERS = 5;
const EXPECTED_MODELS = 10;
const EXPECTED_RUNS = 100;
const P50_MAX_MS = 1_000;
const P95_MAX_MS = 2_000;
const SEED_BATCH_SIZE = 100_000;
const ADMIN_USER_ID = "018f3b57-0000-7000-8000-000000000101";
const TEAM_ID = "018f3b57-0000-7000-8000-000000000001";
const TIMEZONES = [
  "Asia/Seoul",
  "America/Los_Angeles",
  "Asia/Kolkata",
  "Asia/Kathmandu",
  "Europe/London",
] as const;

type FixtureStats = {
  events: string;
  days: string;
  users: string;
  providers: string;
  models: string;
  teams: string;
};

type Scenario = {
  name: string;
  timezone: typeof TIMEZONES[number];
  path: string;
  marker: string;
};

type ScenarioResult = {
  name: string;
  timezone: string;
  p50: number;
  p95: number;
  passed: boolean;
};

class CookieJar {
  private readonly cookies = new Map<string, string>();

  absorb(headers: Headers): void {
    const values = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.()
      ?? (headers.get("set-cookie") ? [headers.get("set-cookie")!] : []);
    for (const value of values) {
      const pair = value.split(";", 1)[0] ?? "";
      const separator = pair.indexOf("=");
      if (separator <= 0) continue;
      const name = pair.slice(0, separator).trim();
      const cookieValue = pair.slice(separator + 1).trim();
      if (cookieValue) this.cookies.set(name, cookieValue);
      else this.cookies.delete(name);
    }
  }

  header(extra: Record<string, string> = {}): string {
    return [
      ...this.cookies.entries(),
      ...Object.entries(extra),
    ].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  hasSession(): boolean {
    return [...this.cookies.keys()].some((name) => name.endsWith("session-token"));
  }
}

function clickHouseTimestamp(date: Date): string {
  return date.toISOString().replace("T", " ").replace("Z", "");
}

function fixtureUserId(index: number): string {
  return `018f3b57-0000-7000-8000-${String(index + 101).padStart(12, "0")}`;
}

function providerKey(index: number): string {
  return `${FIXTURE_PREFIX}provider-${index}`;
}

function schemaDatabaseUrl(databaseUrl: string, schema: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-csearch_path=${schema},public`);
  return url.toString();
}

async function runCommand(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const collect = (chunk: Buffer): void => {
      output = `${output}${chunk.toString()}`.slice(-20_000);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} failed (${code ?? "signal"})\n${output}`));
    });
  });
}

async function createIsolatedPostgres(
  baseDatabaseUrl: string,
  schema: string,
): Promise<{ admin: Pool; pool: Pool; databaseUrl: string }> {
  const admin = new Pool({ connectionString: baseDatabaseUrl, max: 2 });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    const databaseUrl = schemaDatabaseUrl(baseDatabaseUrl, schema);
    await runCommand(
      "pnpm",
      [
        "exec",
        "node-pg-migrate",
        "-j",
        "sql",
        "-m",
        "migrations",
        "-d",
        "DATABASE_URL",
        "-s",
        schema,
        "--migrations-schema",
        schema,
        "up",
      ],
      { ...process.env, DATABASE_URL: databaseUrl },
    );
    const pool = new Pool({ connectionString: databaseUrl, max: 10 });
    const searchPath = await pool.query<{ search_path: string }>("SHOW search_path");
    if (!searchPath.rows[0]?.search_path.startsWith(schema)) {
      await pool.end();
      throw new Error(`isolated Postgres search_path was not applied: ${searchPath.rows[0]?.search_path ?? "missing"}`);
    }
    return { admin, pool, databaseUrl };
  } catch (error) {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    await admin.end().catch(() => undefined);
    throw error;
  }
}

async function seedPostgresFixture(pool: Pool, email: string, password: string): Promise<void> {
  const passwordHash = await bcrypt.hash(password, 12);
  await pool.query("INSERT INTO teams (id, name) VALUES ($1, 'Benchmark Team')", [TEAM_ID]);
  for (let index = 0; index < EXPECTED_USERS; index++) {
    await pool.query(
      `INSERT INTO users (id, email, name, role, team_id, timezone, password_hash, team_onboarding_completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
      [
        fixtureUserId(index),
        index === 0 ? email : `benchmark-user-${index}@example.test`,
        index === 0 ? "Benchmark Admin" : `Benchmark User ${index}`,
        index === 0 ? "admin" : "member",
        TEAM_ID,
        TIMEZONES[index % TIMEZONES.length],
        index === 0 ? passwordHash : null,
      ],
    );
  }
  for (let index = 0; index < EXPECTED_PROVIDERS; index++) {
    await pool.query(
      `INSERT INTO providers (key, display_name, service_name_patterns, collection_method, enabled)
       VALUES ($1, $2, ARRAY[]::text[], 'logfile', true)`,
      [providerKey(index), `Benchmark Provider ${index}`],
    );
  }
  for (let index = 0; index < EXPECTED_MODELS; index++) {
    await pool.query(
      `INSERT INTO pricing_revisions
         (model_id, input_price_per_mtok, output_price_per_mtok, cache_read_price_per_mtok,
          cache_creation_price_per_mtok, effective_at, source)
       VALUES ($1, 1, 2, 0.1, 0.2, TIMESTAMPTZ '2020-01-01T00:00:00Z', 'benchmark')`,
      [`${FIXTURE_PREFIX}model-${index}`],
    );
  }
  await pool.query(
    `INSERT INTO ingest_tokens (user_id, token_hash, last_used_at)
     VALUES ($1, $2, now())`,
    [ADMIN_USER_ID, randomBytes(32).toString("hex")],
  );
  const stats = await pool.query<{ users: number; providers: number; models: number; teams: number }>(
    `SELECT
       (SELECT count(*)::int FROM users) AS users,
       (SELECT count(*)::int FROM providers) AS providers,
       (SELECT count(*)::int FROM pricing_revisions) AS models,
       (SELECT count(*)::int FROM teams) AS teams`,
  );
  const row = stats.rows[0];
  if (row?.users !== EXPECTED_USERS || row.providers !== EXPECTED_PROVIDERS || row.models !== EXPECTED_MODELS || row.teams !== 1) {
    throw new Error(`invalid isolated Postgres fixture: ${JSON.stringify(row ?? null)}`);
  }
}

async function createIsolatedClickHouse(
  clickHouseUrl: string,
  username: string,
  password: string,
  database: string,
): Promise<{ admin: ClickHouseClient; client: ClickHouseClient }> {
  const admin = createClient({ url: clickHouseUrl, username, password, database: "default" });
  try {
    await admin.command({ query: `CREATE DATABASE ${database}` });
    return {
      admin,
      client: createClient({ url: clickHouseUrl, username, password, database }),
    };
  } catch (error) {
    await admin.command({ query: `DROP DATABASE IF EXISTS ${database}` }).catch(() => undefined);
    await admin.close().catch(() => undefined);
    throw error;
  }
}

async function assertRawRetentionDisabled(ch: ClickHouseClient): Promise<void> {
  const result = await ch.query({ query: "SHOW CREATE TABLE usage_events", format: "JSONEachRow" });
  const row = (await result.json<Record<string, string>>())[0];
  if (/\bTTL\b/i.test(Object.values(row ?? {}).join("\n"))) {
    throw new Error("400-day benchmark fixture requires an isolated local usage_events table without TTL");
  }
}

async function initializeClickHouseBaseSchema(ch: ClickHouseClient): Promise<void> {
  await ch.command({
    query: `CREATE TABLE usage_events
            (
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
            )
            ENGINE = ReplacingMergeTree(inserted_at)
            PARTITION BY toYYYYMM(ts)
            ORDER BY dedup_key`,
  });
  await ch.command({
    query: `CREATE TABLE raw_events
            (
              id UInt64,
              provider_key LowCardinality(String),
              payload String,
              received_at DateTime64(3, 'UTC') DEFAULT now64(3)
            )
            ENGINE = MergeTree
            ORDER BY (received_at, id)`,
  });
}

async function seedClickHouseFixture(ch: ClickHouseClient, fixtureStart: Date): Promise<void> {
  for (let offset = 0; offset < EXPECTED_EVENTS; offset += SEED_BATCH_SIZE) {
    const count = Math.min(SEED_BATCH_SIZE, EXPECTED_EVENTS - offset);
    await ch.command({
      query: `INSERT INTO usage_events
              (dedup_key, provider_key, user_id, team_id, session_id, model, ts,
               input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
               cost_usd, pricing_revision_id, cost_status, log_adapter, host)
              SELECT concat({prefix:String}, toString(number)),
                     concat({prefix:String}, 'provider-', toString(number % ${EXPECTED_PROVIDERS})),
                     concat('018f3b57-0000-7000-8000-', leftPad(toString(101 + number % ${EXPECTED_USERS}), 12, '0')),
                     {team:String},
                     concat({prefix:String}, 'session-', toString(number % ${EXPECTED_USERS})),
                     concat({prefix:String}, 'model-', toString(number % ${EXPECTED_MODELS})),
                     toDateTime64({fixtureStart:String}, 3, 'UTC')
                       + toIntervalSecond(toInt64(intDiv(number, 2500) * 86400)),
                     100 + (number % 100),
                     50 + (number % 50),
                     number % 20,
                     number % 10,
                     toDecimal64((number % 1000) / 100000, 8),
                     'benchmark-pricing-v1',
                     'priced',
                     '',
                     concat('benchmark-host-', toString(number % 10))
              FROM numbers(${offset}, ${count})`,
      query_params: {
        prefix: FIXTURE_PREFIX,
        team: TEAM_ID,
        fixtureStart: clickHouseTimestamp(fixtureStart),
      },
    });
    console.log(`[dashboard-http] raw seed ${offset + count}/${EXPECTED_EVENTS}`);
  }
}

async function fixtureStats(ch: ClickHouseClient): Promise<FixtureStats> {
  const result = await ch.query({
    query: `SELECT count() AS events,
                   uniqExact(toDate(ts)) AS days,
                   uniqExact(user_id) AS users,
                   uniqExact(provider_key) AS providers,
                   uniqExact(model) AS models,
                   uniqExact(team_id) AS teams
            FROM usage_events FINAL
            WHERE startsWith(dedup_key, {prefix:String})`,
    query_params: { prefix: FIXTURE_PREFIX },
    format: "JSONEachRow",
  });
  return (await result.json<FixtureStats>())[0]!;
}

async function validateRawFixture(ch: ClickHouseClient): Promise<void> {
  const stats = await fixtureStats(ch);
  if (
    Number(stats.events) !== EXPECTED_EVENTS
    || Number(stats.days) !== EXPECTED_DAYS
    || Number(stats.users) !== EXPECTED_USERS
    || Number(stats.providers) !== EXPECTED_PROVIDERS
    || Number(stats.models) !== EXPECTED_MODELS
    || Number(stats.teams) !== 1
  ) {
    throw new Error(`invalid dashboard HTTP raw fixture: ${JSON.stringify(stats)}`);
  }
  console.log(`[dashboard-http] fixed fixture validated ${JSON.stringify(stats)}`);
}

async function compactCanonicalV2(
  pg: Pool,
  storage: ClickHouseStorage,
  ch: ClickHouseClient,
  fixtureStart: Date,
): Promise<void> {
  const fixtureEnd = new Date(fixtureStart.getTime() + EXPECTED_DAYS * 86_400_000);
  await pg.query(
    `INSERT INTO clickhouse_rollup_dirty_buckets (name, bucket)
     SELECT 'usage_15m_v2', bucket
     FROM generate_series($1::timestamptz, $2::timestamptz - interval '1 day', interval '1 day') AS bucket
     ON CONFLICT (name, bucket) DO UPDATE SET updated_at = now()`,
    [fixtureStart, fixtureEnd],
  );
  let remaining = EXPECTED_DAYS;
  for (let iteration = 0; iteration < 1_000 && remaining > 0; iteration++) {
    await storage.compactUsage15mV2(256);
    if (iteration % 25 === 0) {
      const pending = await pg.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM clickhouse_rollup_dirty_buckets WHERE name = 'usage_15m_v2'",
      );
      remaining = pending.rows[0]?.count ?? 0;
      console.log(`[dashboard-http] v2 compactor dirty=${remaining}`);
    }
  }
  const pending = await pg.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM clickhouse_rollup_dirty_buckets WHERE name = 'usage_15m_v2'",
  );
  if ((pending.rows[0]?.count ?? 0) !== 0) throw new Error("v2 compactor did not consume the fixed fixture dirty buckets");
  const result = await ch.query({
    query: `SELECT sum(event_count) AS events, uniqExact(toDate(bucket_15m)) AS days
            FROM usage_15m_rollup_v2 FINAL
            WHERE startsWith(provider_key, {prefix:String})`,
    query_params: { prefix: FIXTURE_PREFIX },
    format: "JSONEachRow",
  });
  const row = (await result.json<{ events: string; days: string }>())[0];
  if (Number(row?.events) !== EXPECTED_EVENTS || Number(row?.days) !== EXPECTED_DAYS) {
    throw new Error(`v2 compactor fixture mismatch: ${JSON.stringify(row ?? null)}`);
  }
}

async function buildTimezoneCaches(pg: Pool, storage: ClickHouseStorage): Promise<void> {
  const repository = createPgTimezoneRollupRepository(pg);
  for (const timezone of TIMEZONES) {
    const activated = await activateTimezoneRollupWith(
      repository,
      timezone,
      new Date(),
      (candidate) => storage.supportsTimezone(candidate),
    );
    console.log(`[dashboard-http] activation ${timezone} ${JSON.stringify(activated)}`);
  }

  let stalled = 0;
  let backlog = await repository.countBacklog();
  for (let iteration = 0; iteration < 2_000; iteration++) {
    if (backlog.eligible === 0) break;
    const result = await runTimezoneRollupWorkerWith(repository, storage);
    stalled = result.jobs === 0 ? stalled + 1 : 0;
    if (stalled >= 5) throw new Error(`timezone worker stalled with ${backlog.eligible} eligible jobs remaining`);
    backlog = await repository.countBacklog();
    if (iteration % 50 === 0) {
      console.log(`[dashboard-http] timezone worker eligible=${backlog.eligible} waiting_for_base=${backlog.waitingForBase}`);
    }
  }
  backlog = await repository.countBacklog();
  console.log(`[dashboard-http] timezone worker finalized eligible=${backlog.eligible} waiting_for_base=${backlog.waitingForBase}`);

  for (const timezone of TIMEZONES) {
    const canonical = canonicalTimezoneId(timezone);
    if (!canonical) throw new Error(`invalid benchmark timezone: ${timezone}`);
    const coverage = await pg.query<{
      day_jobs: number;
      day_coverage: number;
      day_waiting: number;
      hour_jobs: number;
      hour_coverage: number;
      hour_waiting: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM clickhouse_timezone_rollup_jobs
          WHERE timezone = $1 AND resolution = 'day') AS day_jobs,
         (SELECT count(*)::int FROM clickhouse_timezone_rollup_coverage
          WHERE timezone = $1 AND resolution = 'day') AS day_coverage,
         (SELECT count(*)::int FROM clickhouse_timezone_rollup_jobs
          WHERE timezone = $1 AND resolution = 'day' AND status = 'pending') AS day_waiting,
         (SELECT count(*)::int FROM clickhouse_timezone_rollup_jobs
          WHERE timezone = $1 AND resolution = 'hour') AS hour_jobs,
         (SELECT count(*)::int FROM clickhouse_timezone_rollup_coverage
          WHERE timezone = $1 AND resolution = 'hour') AS hour_coverage,
         (SELECT count(*)::int FROM clickhouse_timezone_rollup_jobs
          WHERE timezone = $1 AND resolution = 'hour' AND status = 'pending') AS hour_waiting`,
      [canonical],
    );
    const row = coverage.rows[0];
    if (!row) throw new Error(`missing durable timezone coverage for ${timezone}`);
    assertTimezoneFixtureCoverage({
      eligible: backlog.eligible,
      dayJobs: row.day_jobs,
      dayCoverage: row.day_coverage,
      dayWaiting: row.day_waiting,
      hourJobs: row.hour_jobs,
      hourCoverage: row.hour_coverage,
      hourWaiting: row.hour_waiting,
    });
  }
}

async function clearClickHouseCaches(ch: ClickHouseClient): Promise<void> {
  await ch.command({ query: "SYSTEM DROP QUERY CACHE" });
  await ch.command({ query: "SYSTEM DROP UNCOMPRESSED CACHE" });
  await ch.command({ query: "SYSTEM DROP MARK CACHE" });
}

async function loginWithCredentials(
  baseUrl: string,
  email: string,
  password: string,
): Promise<CookieJar> {
  const jar = new CookieJar();
  const csrf = await fetch(`${baseUrl}/api/auth/csrf`, { redirect: "manual" });
  jar.absorb(csrf.headers);
  if (csrf.status !== 200) throw new Error(`credentials CSRF endpoint returned ${csrf.status}`);
  const token = String((await csrf.json() as { csrfToken?: unknown }).csrfToken ?? "");
  if (!token) throw new Error("credentials CSRF token missing");

  const login = await fetch(`${baseUrl}/api/auth/callback/credentials`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: jar.header({ NEXT_LOCALE: "en" }),
    },
    body: new URLSearchParams({ csrfToken: token, email, password, callbackUrl: `${baseUrl}/` }),
  });
  jar.absorb(login.headers);
  if (![200, 302, 303].includes(login.status) || !jar.hasSession()) {
    throw new Error(`credentials login failed with status ${login.status}`);
  }
  const session = await fetch(`${baseUrl}/api/auth/session`, {
    headers: { cookie: jar.header({ NEXT_LOCALE: "en" }) },
  });
  if (session.status !== 200) throw new Error(`authenticated session endpoint returned ${session.status}`);
  const userId = (await session.json() as { user?: { id?: string } }).user?.id;
  if (userId !== ADMIN_USER_ID) throw new Error("credentials session did not resolve the fixed benchmark admin user");
  return jar;
}

function startProductionApp(port: number, env: NodeJS.ProcessEnv): { child: ChildProcess; output: () => string } {
  let recentOutput = "";
  const child = spawn(
    "pnpm",
    ["--filter", "@toard/web", "exec", "next", "start", "-p", String(port)],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  const collect = (chunk: Buffer): void => {
    recentOutput = `${recentOutput}${chunk.toString()}`.slice(-20_000);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  return { child, output: () => recentOutput };
}

async function waitForApp(baseUrl: string, app: ChildProcess, output: () => string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (app.exitCode != null) throw new Error(`production app exited before readiness (${app.exitCode})\n${output()}`);
    try {
      const response = await fetch(`${baseUrl}/api/ready`, { signal: AbortSignal.timeout(2_000) });
      if (response.status === 200) return;
    } catch {
      // The production server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`production app did not become ready\n${output()}`);
}

async function stopApp(app: ChildProcess | undefined): Promise<void> {
  if (!app || app.exitCode != null) return;
  app.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => app.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (app.exitCode == null) app.kill("SIGKILL");
}

async function benchmarkScenario(
  scenario: Scenario,
  baseUrl: string,
  jar: CookieJar,
  pg: Pool,
  ch: ClickHouseClient,
): Promise<ScenarioResult> {
  await pg.query("UPDATE users SET timezone = $1 WHERE id = $2", [scenario.timezone, ADMIN_USER_ID]);
  const durations: number[] = [];
  for (let run = 0; run < EXPECTED_RUNS; run++) {
    await clearClickHouseCaches(ch);
    const url = new URL(scenario.path, baseUrl);
    url.searchParams.set("benchmark_run", `${scenario.name}-${run}-${randomBytes(6).toString("hex")}`);
    const startedAt = performance.now();
    const response = await fetch(url, {
      redirect: "manual",
      headers: {
        accept: "text/html",
        "accept-language": "en",
        "cache-control": "no-cache, no-store, max-age=0",
        pragma: "no-cache",
        cookie: jar.header({ NEXT_LOCALE: "en" }),
      },
    });
    await assertDashboardResponse(response, scenario.marker);
    durations.push(performance.now() - startedAt);
  }
  const { p50, p95 } = benchmarkPercentiles(durations);
  return {
    name: scenario.name,
    timezone: scenario.timezone,
    p50,
    p95,
    passed: p50 <= P50_MAX_MS && p95 <= P95_MAX_MS,
  };
}

async function main(): Promise<void> {
  parseDashboardBenchmarkOptions(process.argv.slice(2));
  assertNonProductionBenchmarkEnvironment(process.env);
  const mode = benchmarkExecutionMode(process.env);
  const baseDatabaseUrl = assertBenchmarkTarget(
    "DATABASE_URL",
    process.env.DATABASE_URL ?? "postgresql://toard:toard@localhost:5432/toard",
    mode,
  );
  const clickHouseUrl = assertBenchmarkTarget(
    "CLICKHOUSE_URL",
    process.env.CLICKHOUSE_URL ?? "http://localhost:8123",
    mode,
  );
  const appBaseUrl = assertBenchmarkTarget(
    "APP_BASE_URL",
    process.env.APP_BASE_URL ?? "http://localhost:3117",
    mode,
  );
  if (mode === "release") {
    const [cpuMax, memoryMax] = await Promise.all([
      readFile("/sys/fs/cgroup/cpu.max", "utf8"),
      readFile("/sys/fs/cgroup/memory.max", "utf8"),
    ]);
    assertAppCgroupLimits(cpuMax, memoryMax);
  }
  const port = Number(new URL(appBaseUrl).port || "80");
  const runSuffix = `${process.pid}_${Date.now()}`;
  const pgSchema = `toard_benchmark_http_${runSuffix}`;
  const chDatabase = `toard_benchmark_http_${runSuffix}`;
  const authSecret = randomBytes(33).toString("base64");
  const adminPassword = randomBytes(32).toString("base64url");
  const adminEmail = `benchmark-admin-${runSuffix}@example.test`;
  const clickHouseUser = process.env.CLICKHOUSE_USER ?? "toard";
  const clickHousePassword = process.env.CLICKHOUSE_PASSWORD ?? "toard";
  let pgAdmin: Pool | undefined;
  let pg: Pool | undefined;
  let chAdmin: ClickHouseClient | undefined;
  let ch: ClickHouseClient | undefined;
  let app: ChildProcess | undefined;

  console.log(`[dashboard-http] mode=${mode}: authenticated HTTP request through completed response body`);
  console.log(mode === "release"
    ? "[dashboard-http] release reference limits verified: Docker Compose total 4 vCPU / 8 GiB"
    : "[dashboard-http] diagnostic only: host limits are not a release PASS");

  try {
    const isolatedPg = await createIsolatedPostgres(baseDatabaseUrl, pgSchema);
    pgAdmin = isolatedPg.admin;
    pg = isolatedPg.pool;
    await seedPostgresFixture(pg, adminEmail, adminPassword);

    const isolatedCh = await createIsolatedClickHouse(clickHouseUrl, clickHouseUser, clickHousePassword, chDatabase);
    chAdmin = isolatedCh.admin;
    ch = isolatedCh.client;
    await initializeClickHouseBaseSchema(ch);
    const storage = new ClickHouseStorage(ch, pg, { timezone: "UTC", read15mV2Rollup: true, readRollup: true });
    await storage.compactUsage15mV2(1);
    await assertRawRetentionDisabled(ch);
    const fixtureStart = dashboardFixtureStart();
    await seedClickHouseFixture(ch, fixtureStart);
    await validateRawFixture(ch);
    await compactCanonicalV2(pg, storage, ch, fixtureStart);
    await buildTimezoneCaches(pg, storage);

    await runCommand("pnpm", ["--filter", "@toard/web", "build"], {
      ...process.env,
      DATABASE_URL: isolatedPg.databaseUrl,
      CLICKHOUSE_URL: clickHouseUrl,
      CLICKHOUSE_USER: clickHouseUser,
      CLICKHOUSE_PASSWORD: clickHousePassword,
      CLICKHOUSE_DB: chDatabase,
      STORAGE_BACKEND: "clickhouse",
      AUTH_MODE: "oauth",
      AUTH_CREDENTIALS_ENABLED: "true",
      AUTH_SECRET: authSecret,
    });
    const productionEnv: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(port),
      DATABASE_URL: isolatedPg.databaseUrl,
      CLICKHOUSE_URL: clickHouseUrl,
      CLICKHOUSE_USER: clickHouseUser,
      CLICKHOUSE_PASSWORD: clickHousePassword,
      CLICKHOUSE_DB: chDatabase,
      STORAGE_BACKEND: "clickhouse",
      CLICKHOUSE_READ_15M_V2_ROLLUP: "1",
      CLICKHOUSE_READ_TIMEZONE_ROLLUP: "1",
      CLICKHOUSE_15M_V2_COMPACTOR: "0",
      CLICKHOUSE_TIMEZONE_ROLLUP_COMPACTOR: "0",
      AUTH_MODE: "oauth",
      AUTH_CREDENTIALS_ENABLED: "true",
      AUTH_SECRET: authSecret,
      AUTH_TRUST_HOST: "true",
      PRICING_AUTO_SYNC: "off",
      ORG_TIMEZONE: "Asia/Seoul",
    };
    const started = startProductionApp(port, productionEnv);
    app = started.child;
    await waitForApp(appBaseUrl, app, started.output);
    const jar = await loginWithCredentials(appBaseUrl, adminEmail, adminPassword);

    const scenarios: Scenario[] = [
      ...TIMEZONES.map((timezone) => ({
        name: `org-${timezone}`,
        timezone,
        path: "/org?period=year",
        marker: 'data-dashboard-ready="org-overview"',
      })),
      {
        name: "org-provider-filter",
        timezone: "Asia/Seoul",
        path: `/org?period=year&provider=${encodeURIComponent(providerKey(0))}`,
        marker: 'data-dashboard-ready="org-overview"',
      },
      {
        name: "team-view",
        timezone: "Asia/Seoul",
        path: `/org/team?period=year&team=${TEAM_ID}`,
        marker: 'data-dashboard-ready="team-overview"',
      },
      {
        name: "individual-dashboard",
        timezone: "Asia/Seoul",
        path: "/?period=year",
        marker: 'data-dashboard-ready="user-overview"',
      },
    ];

    let failed = false;
    for (const scenario of scenarios) {
      const result = await benchmarkScenario(scenario, appBaseUrl, jar, pg, ch);
      const verdict = result.passed ? (mode === "release" ? "PASS" : "DIAGNOSTIC_PASS") : "FAIL";
      console.log(`[dashboard-http] ${result.name} timezone=${result.timezone} runs=${EXPECTED_RUNS} p50=${result.p50.toFixed(2)}ms p95=${result.p95.toFixed(2)}ms ${verdict}`);
      if (!result.passed) failed = true;
    }
    if (!failed) {
      console.log(mode === "release"
        ? "[dashboard-http] RELEASE_PASS: all authenticated dashboard scenarios met the reference SLO"
        : "[dashboard-http] diagnostic complete: run pnpm benchmark:dashboard-http for release evidence");
    }
    if (failed) process.exitCode = 1;
  } finally {
    await stopApp(app);
    await pg?.end().catch(() => undefined);
    if (pgAdmin) {
      await pgAdmin.query(`DROP SCHEMA IF EXISTS ${pgSchema} CASCADE`).catch(() => undefined);
      await pgAdmin.end().catch(() => undefined);
    }
    await ch?.close().catch(() => undefined);
    if (chAdmin) {
      await chAdmin.command({ query: `DROP DATABASE IF EXISTS ${chDatabase}` }).catch(() => undefined);
      await chAdmin.close().catch(() => undefined);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
