import { type ClickHouseClient, createClient } from "@clickhouse/client";
import type {
  BucketOptions,
  DailyPoint,
  DeviceInfo,
  FinalizedUsageEvent,
  HostBreakdown,
  InsightAggregateRow,
  InsightComparisonQuery,
  InsightCompositionRow,
  LeaderRow,
  LeaderScope,
  ModelBreakdown,
  OverviewStats,
  PeriodQuery,
  ProviderBreakdown,
  SaveResult,
  SessionUsageEventRow,
  SessionUsageSummary,
  ModelDailyPoint,
  StorageBackend,
  TeamMemberTimeseriesPoint,
  TimeBucket,
  TimeseriesScope,
  UsageEvent,
  UserUsage,
  UserInsightComparison,
} from "@toard/core";
import {
  addLocalCalendarDays,
  buildUserInsightComparison,
  canonicalTimezoneId,
  firstInstantOfLocalDate,
  localDateKey,
  CLICKHOUSE_RAW_RETENTION_DAYS,
} from "@toard/core";
import { Pool, type PoolClient } from "pg";

/** CH/PG 는 큰 수·Decimal 을 string 으로 반환 → number 변환 */
const n = (v: unknown): number => (v == null ? 0 : Number(v));

/** UTC Date → ClickHouse DateTime64 문자열 'YYYY-MM-DD HH:mm:ss.SSS' */
const chTs = (d: Date): string => d.toISOString().replace("T", " ").replace("Z", "");

const COST_SCALE = 100_000_000n;

function costToScaled(v: string): bigint {
  const [rawWhole, rawFrac = ""] = v.split(".");
  const sign = rawWhole?.startsWith("-") ? -1n : 1n;
  const whole = BigInt((rawWhole ?? "0").replace("-", "") || "0");
  const frac = BigInt(rawFrac.padEnd(8, "0").slice(0, 8) || "0");
  return sign * (whole * COST_SCALE + frac);
}

function scaledToCost(v: bigint): string {
  const sign = v < 0 ? "-" : "";
  const abs = v < 0 ? -v : v;
  const whole = abs / COST_SCALE;
  const frac = (abs % COST_SCALE).toString().padStart(8, "0");
  return `${sign}${whole}.${frac}`;
}

function hourBucket(ts: Date | string): string {
  const d = new Date(ts);
  d.setUTCMinutes(0, 0, 0);
  return chTs(d);
}

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

function fifteenMinuteBucket(ts: Date | string): string {
  const d = new Date(ts);
  const minute = Math.floor(d.getUTCMinutes() / 15) * 15;
  d.setUTCMinutes(minute, 0, 0);
  return chTs(d);
}

function floorRollupDate(ts: Date, intervalMs: number): Date {
  return new Date(Math.floor(ts.getTime() / intervalMs) * intervalMs);
}

function ceilRollupDate(ts: Date, intervalMs: number): Date {
  const floor = floorRollupDate(ts, intervalMs);
  return floor.getTime() === ts.getTime() ? floor : new Date(floor.getTime() + intervalMs);
}

function chDate(s: string): Date {
  return new Date(`${s.replace(" ", "T")}Z`);
}

function nextTimezoneDayStart(bucket: Date, timezone: string): Date {
  const date = localDateKey(bucket, timezone);
  return firstInstantOfLocalDate(addLocalCalendarDays(date, 1), timezone);
}

type ScopedQuery = PeriodQuery & { userId?: string; userIds?: string[]; teamId?: string };
type Params = Record<string, unknown>;
type InsightSourcePart =
  | { kind: "hybrid"; source: string; params: Params }
  | { kind: "raw"; source: string; where: string; params: Params };
type InsightSource = { source: string; params: Params };
export type TimeseriesSource = {
  source: string;
  params: Params;
  resolution: "raw" | "15m" | "timezone-hour" | "timezone-day";
};
type RollupSource = TimeseriesSource & { resolution: "15m"; from: Date; to: Date };
type CacheBucket = { from: Date; to: Date };
type CacheWindow = { from: Date; to: Date };
type RollupSpec = {
  name: "usage_15m" | "usage_15m_v2";
  table: "usage_15m_rollup" | "usage_15m_rollup_v2";
  bucketColumn: "bucket_15m";
  intervalMs: number;
  sourcePolicy: "dashboard" | "canonical_final";
};

export interface ClickHouseStorageOptions {
  /** 조직 타임존 (IANA, ADR-008) — 쿼리에 timezone 미지정 시 버킷 폴백. 기본 UTC. */
  timezone?: string;
  /** ReplacingMergeTree 중복 제거를 읽기 시점에 강제할지 여부. 기본 false. */
  readFinal?: boolean;
  /** 완성된 요청 시간대별 hour/day cache를 대시보드에서 읽을지 여부. 기본 false. */
  readRollup?: boolean;
  /** finalized 15분 rollup + 최근 raw tail hybrid 시계열 조회를 사용할지 여부. 기본 false. */
  read15mRollup?: boolean;
  /** 가격 provenance를 보존한 v2 15분 rollup 조회를 사용할지 여부. 기본 false. */
  read15mV2Rollup?: boolean;
  /** 원본 usage_events의 90일 논리 기간 + 7일 safety grace TTL을 적용할지 여부. */
  enforceRetentionTtl?: boolean;
}

/** CH 쿼리에 리터럴로 들어가므로 IANA 형식만 허용(주입 방지). 무효 시 fallback. */
function safeTimezone(tz: string | undefined, fallback = "UTC"): string {
  if (!tz || !/^[A-Za-z0-9_+/-]+$/.test(tz)) return fallback;
  return tz;
}

interface AggRow {
  sessions?: string;
  active_users?: string;
  cost?: string;
  input?: string;
  output?: string;
  cache_read?: string;
  cache_creation?: string;
}

interface OutboxBatch {
  id: string;
  insertToken: string;
}

interface OutboxRow {
  dedup_key: string;
  provider_key: string;
  user_id: string | null;
  team_id: string | null;
  session_id: string | null;
  model: string | null;
  ts: Date | string;
  input_tokens: string;
  output_tokens: string;
  cache_read_tokens: string;
  cache_creation_tokens: string;
  cost_usd: string;
  pricing_revision_id: string | null;
  cost_status: FinalizedUsageEvent["costStatus"];
  log_adapter: string | null;
  host: string | null;
}

interface RollupRow {
  bucket_hour: string;
  provider_key: string;
  user_id: string;
  team_id: string;
  session_id: string;
  model: string;
  host: string;
  event_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd: string;
}

interface Rollup15mRow {
  bucket_15m: string;
  provider_key: string;
  user_id: string;
  team_id: string;
  session_id: string;
  model: string;
  host: string;
  pricing_revision_id?: string;
  cost_status?: FinalizedUsageEvent["costStatus"];
  event_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd: string;
  version: number;
}

interface Rollup15mAggRow extends Omit<Rollup15mRow, "event_count" | "input_tokens" | "output_tokens" | "cache_read_tokens" | "cache_creation_tokens" | "version"> {
  event_count?: string;
  input_tokens?: string;
  output_tokens?: string;
  cache_read_tokens?: string;
  cache_creation_tokens?: string;
}

interface TimezoneRollupAggRow {
  provider_key: string;
  user_id: string;
  team_id: string;
  session_id: string;
  model: string;
  host: string;
  pricing_revision_id: string;
  cost_status: FinalizedUsageEvent["costStatus"];
  event_count?: string;
  input_tokens?: string;
  output_tokens?: string;
  cache_read_tokens?: string;
  cache_creation_tokens?: string;
  cost_usd: string;
}

interface RollupAccumulator extends Omit<RollupRow, "event_count" | "cost_usd"> {
  event_count: number;
  cost_scaled: bigint;
}

interface EnqueueResult extends SaveResult {
  batchId?: string;
}

export interface FlushUsageOutboxResult {
  batches: number;
  rows: number;
}

export interface CompactUsage15mRollupResult {
  buckets: number;
  rows: number;
  watermark: string;
}

export interface CompactUsage15mV2Result {
  buckets: number;
  rows: number;
  watermark: string;
}

const CLICKHOUSE_SCHEMA_DDL = [
  "ALTER TABLE usage_events MODIFY SETTING non_replicated_deduplication_window = 10000",
  "ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS pricing_revision_id String DEFAULT '' AFTER cost_usd",
  "ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS cost_status LowCardinality(String) DEFAULT 'legacy' AFTER pricing_revision_id",
  "DROP VIEW IF EXISTS usage_hourly_rollup_mv",
  `CREATE TABLE IF NOT EXISTS usage_hourly_rollup
   (
     bucket_hour           DateTime64(3, 'UTC'),
     provider_key          LowCardinality(String),
     user_id               String,
     team_id               String,
     session_id            String,
     model                 LowCardinality(String),
     host                  LowCardinality(String),
     event_count           UInt64,
     input_tokens          UInt64,
     output_tokens         UInt64,
     cache_read_tokens     UInt64,
     cache_creation_tokens UInt64,
     cost_usd              Decimal(18, 8)
   )
   ENGINE = SummingMergeTree
   PARTITION BY toYYYYMM(bucket_hour)
   ORDER BY (bucket_hour, user_id, team_id, provider_key, model, host, session_id)
   SETTINGS non_replicated_deduplication_window = 10000`,
  "ALTER TABLE usage_hourly_rollup MODIFY SETTING non_replicated_deduplication_window = 10000",
  `CREATE TABLE IF NOT EXISTS usage_15m_rollup
   (
     bucket_15m            DateTime64(3, 'UTC'),
     provider_key          LowCardinality(String),
     user_id               String,
     team_id               String,
     session_id            String,
     model                 LowCardinality(String),
     host                  LowCardinality(String),
     event_count           UInt64,
     input_tokens          UInt64,
     output_tokens         UInt64,
     cache_read_tokens     UInt64,
     cache_creation_tokens UInt64,
     cost_usd              Decimal(18, 8),
     version               UInt64
   )
   ENGINE = ReplacingMergeTree(version)
   PARTITION BY toYYYYMM(bucket_15m)
   ORDER BY (bucket_15m, user_id, team_id, provider_key, model, host, session_id)`,
  `CREATE TABLE IF NOT EXISTS usage_15m_rollup_v2
   (
     bucket_15m            DateTime64(3, 'UTC'),
     provider_key          LowCardinality(String),
     user_id               String,
     team_id               String,
     session_id            String,
     model                 LowCardinality(String),
     host                  LowCardinality(String),
     pricing_revision_id   String,
     cost_status           LowCardinality(String),
     event_count           UInt64,
     input_tokens          UInt64,
     output_tokens         UInt64,
     cache_read_tokens     UInt64,
     cache_creation_tokens UInt64,
     cost_usd              Decimal(18, 8),
     version               UInt64
   )
   ENGINE = ReplacingMergeTree(version)
   PARTITION BY toYYYYMM(bucket_15m)
   ORDER BY (bucket_15m, provider_key, user_id, team_id, session_id, model, host, pricing_revision_id, cost_status)
   TTL toDateTime(bucket_15m) + INTERVAL 400 DAY DELETE`,
  `CREATE TABLE IF NOT EXISTS usage_hourly_timezone_rollup
   (
     timezone              LowCardinality(String),
     bucket_start          DateTime64(3, 'UTC'),
     user_id               String,
     team_id               String,
     provider_key          LowCardinality(String),
     model                 LowCardinality(String),
     host                  LowCardinality(String),
     session_id            String,
     pricing_revision_id   String,
     cost_status           LowCardinality(String),
     event_count           UInt64,
     input_tokens          UInt64,
     output_tokens         UInt64,
     cache_read_tokens     UInt64,
     cache_creation_tokens UInt64,
     cost_usd              Decimal(18, 8),
     version               UInt64
   )
   ENGINE = ReplacingMergeTree(version)
   PARTITION BY toYYYYMM(bucket_start)
   ORDER BY (timezone, bucket_start, user_id, team_id, provider_key, model, host, session_id, pricing_revision_id, cost_status)
   TTL toDateTime(bucket_start) + INTERVAL 400 DAY DELETE`,
  `CREATE TABLE IF NOT EXISTS usage_daily_timezone_rollup
   (
     timezone              LowCardinality(String),
     bucket_start          DateTime64(3, 'UTC'),
     user_id               String,
     team_id               String,
     provider_key          LowCardinality(String),
     model                 LowCardinality(String),
     host                  LowCardinality(String),
     session_id            String,
     pricing_revision_id   String,
     cost_status           LowCardinality(String),
     event_count           UInt64,
     input_tokens          UInt64,
     output_tokens         UInt64,
     cache_read_tokens     UInt64,
     cache_creation_tokens UInt64,
     cost_usd              Decimal(18, 8),
     version               UInt64
   )
   ENGINE = ReplacingMergeTree(version)
   PARTITION BY toYYYYMM(bucket_start)
   ORDER BY (timezone, bucket_start, user_id, team_id, provider_key, model, host, session_id, pricing_revision_id, cost_status)
   TTL toDateTime(bucket_start) + INTERVAL 400 DAY DELETE`,
] as const;

const CLICKHOUSE_RAW_RETENTION_DDL =
  `ALTER TABLE usage_events MODIFY TTL toDateTime(ts) + INTERVAL ${CLICKHOUSE_RAW_RETENTION_DAYS} DAY DELETE`;

const CLICKHOUSE_TRANSIENT_RETRY_ATTEMPTS = 5;
const CLICKHOUSE_TRANSIENT_RETRY_BASE_MS = 150;
const CLICKHOUSE_ROLLUP_DEFAULT_FINALIZE_DELAY_MS = 30 * 60 * 1000;
const CLICKHOUSE_ROLLUP_DEFAULT_MAX_BUCKETS = 16;
const TIMEZONE_ROLLUP_MAX_DAYS = 400;
const TIMEZONE_ROLLUP_MAX_HOURS = TIMEZONE_ROLLUP_MAX_DAYS * 24;
const USAGE_15M: RollupSpec = {
  name: "usage_15m",
  table: "usage_15m_rollup",
  bucketColumn: "bucket_15m",
  intervalMs: FIFTEEN_MINUTES_MS,
  sourcePolicy: "dashboard",
};
const USAGE_15M_V2: RollupSpec = {
  name: "usage_15m_v2",
  table: "usage_15m_rollup_v2",
  bucketColumn: "bucket_15m",
  intervalMs: FIFTEEN_MINUTES_MS,
  sourcePolicy: "canonical_final",
};
const USAGE_ROLLUPS = [USAGE_15M, USAGE_15M_V2] as const;
const TRANSIENT_CLICKHOUSE_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/**
 * ClickHouse 저장 백엔드 (설계 §4.3, ADR-003 옵트인).
 * 이벤트·집계는 CH(ReplacingMergeTree, 읽기 시 FINAL), 메타(이름)는 PG 에서 머지.
 * 팀 귀속은 수집 시점 team_id 를 이벤트에 비정규화해 CH 단독 GROUP BY 로 성립.
 */
export class ClickHouseStorage implements StorageBackend {
  private readonly tz: string;
  private readonly usageEventsSource: string;
  private readonly readRollup: boolean;
  private readonly read15mRollup: boolean;
  private readonly read15mV2Rollup: boolean;
  private readonly enforceRetentionTtl: boolean;
  private schemaReady: Promise<void> | undefined;

  constructor(
    private readonly ch: ClickHouseClient,
    private readonly pg: Pool,
    opts: ClickHouseStorageOptions = {},
  ) {
    this.tz = safeTimezone(opts.timezone);
    this.usageEventsSource = opts.readFinal ? "usage_events FINAL" : "usage_events";
    this.readRollup = opts.readRollup ?? false;
    this.read15mRollup = opts.read15mRollup ?? false;
    this.read15mV2Rollup = opts.read15mV2Rollup ?? false;
    this.enforceRetentionTtl = opts.enforceRetentionTtl ?? false;
  }

  async close(): Promise<void> {
    await this.ch.close();
  }

  // ── 공통 ──
  private periodWhere(q: ScopedQuery): { where: string; params: Params } {
    const conds = ["ts >= {from:DateTime64(3)}", "ts < {to:DateTime64(3)}"];
    const params: Params = { from: chTs(q.from), to: chTs(q.to) };
    if (q.providerKey) {
      conds.push("provider_key = {pk:String}");
      params.pk = q.providerKey;
    }
    if (q.userId) {
      conds.push("user_id = {uid:String}");
      params.uid = q.userId;
    }
    if (q.teamId) {
      conds.push("team_id = {did:String}");
      params.did = q.teamId;
    }
    if (q.userIds?.length) {
      conds.push("user_id IN {userIds:Array(String)}");
      params.userIds = q.userIds;
    }
    return { where: `WHERE ${conds.join(" AND ")}`, params };
  }

  private scopedAndFilter(q: ScopedQuery): { sql: string; params: Params } {
    const conds: string[] = [];
    const params: Params = {};
    if (q.providerKey) {
      conds.push("provider_key = {pk:String}");
      params.pk = q.providerKey;
    }
    if (q.userId) {
      conds.push("user_id = {uid:String}");
      params.uid = q.userId;
    }
    if (q.teamId) {
      conds.push("team_id = {did:String}");
      params.did = q.teamId;
    }
    if (q.userIds?.length) {
      conds.push("user_id IN {userIds:Array(String)}");
      params.userIds = q.userIds;
    }
    return { sql: conds.length > 0 ? ` AND ${conds.join(" AND ")}` : "", params };
  }

  private bucketExpr(bucket: TimeBucket | undefined, timeCol: string, tz: string): string {
    if (bucket === "hour") return `formatDateTime(${timeCol}, '%Y-%m-%d %H:00', '${tz}')`;
    if (bucket === "30m") {
      return `formatDateTime(toStartOfInterval(${timeCol}, INTERVAL 30 minute, '${tz}'), '%Y-%m-%d %H:%i', '${tz}')`;
    }
    if (bucket === "15m") {
      return `formatDateTime(toStartOfInterval(${timeCol}, INTERVAL 15 minute, '${tz}'), '%Y-%m-%d %H:%i', '${tz}')`;
    }
    return `formatDateTime(${timeCol}, '%Y-%m-%d', '${tz}')`;
  }

  private sourceBucketExpr(bucket: TimeBucket | undefined, source: TimeseriesSource, timezone: string): string {
    const cached = source.resolution === "timezone-hour" || source.resolution === "timezone-day";
    const timeCol = cached ? "bucket_start" : "ts";
    const labelTimezone = cached ? (canonicalTimezoneId(timezone) ?? timezone) : timezone;
    return this.bucketExpr(bucket, timeCol, labelTimezone);
  }

  private rawSource(q: ScopedQuery): TimeseriesSource {
    const { where, params } = this.periodWhere(q);
    return {
      source: `(SELECT ts, provider_key, user_id, team_id, session_id, model, host,
                       input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd
                FROM ${this.usageEventsSource} ${where})`,
      params,
      resolution: "raw",
    };
  }

  private async exactTimeseriesSource(q: ScopedQuery): Promise<TimeseriesSource> {
    return await this.rollup15mV2Source(q) ?? this.rawSource(q);
  }

  private namespaceTimeseriesSource(source: TimeseriesSource, prefix: string): TimeseriesSource {
    let query = source.source;
    const params: Params = {};
    for (const [key, value] of Object.entries(source.params)) {
      const namespaced = `${prefix}_${key}`;
      query = query.replaceAll(`{${key}:`, `{${namespaced}:`);
      params[namespaced] = value;
    }
    return { ...source, source: query, params };
  }

  private combineTimeseriesSources(
    parts: Array<{ name: string; source: TimeseriesSource }>,
  ): TimeseriesSource {
    if (parts.length === 1) return parts[0]!.source;
    const columns = `ts, provider_key, user_id, team_id, session_id, model, host,
                     input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd`;
    const namespaced = parts.map(({ name, source }) => ({
      name,
      source: this.namespaceTimeseriesSource(source, name),
    }));
    return {
      source: `(${namespaced.map(({ source }) => `SELECT ${columns} FROM ${source.source}`).join("\nUNION ALL\n")})`,
      params: Object.assign({}, ...namespaced.map(({ source }) => source.params)),
      resolution: "15m",
    };
  }

  private timezoneCacheBuckets(
    resolution: "hour" | "day",
    timezone: string,
    q: ScopedQuery,
  ): CacheBucket[] {
    if (q.to <= q.from) return [];
    const buckets: CacheBucket[] = [];
    let cursor = firstInstantOfLocalDate(localDateKey(q.from, timezone), timezone);
    if (resolution === "day") {
      if (cursor < q.from) cursor = nextTimezoneDayStart(cursor, timezone);
    } else {
      while (cursor < q.from) cursor = new Date(cursor.getTime() + 60 * 60 * 1000);
    }
    const maximum = resolution === "day" ? TIMEZONE_ROLLUP_MAX_DAYS : TIMEZONE_ROLLUP_MAX_HOURS;

    while (cursor < q.to && buckets.length < maximum) {
      const next = resolution === "day"
        ? nextTimezoneDayStart(cursor, timezone)
        : new Date(cursor.getTime() + 60 * 60 * 1000);
      if (next <= cursor || next > q.to) break;
      buckets.push({ from: cursor, to: next });
      cursor = next;
    }
    return buckets;
  }

  private async cacheReady(
    resolution: "hour" | "day",
    timezoneInput: string,
    q: ScopedQuery,
  ): Promise<CacheWindow | null> {
    if (!this.readRollup) return null;
    const timezone = canonicalTimezoneId(timezoneInput);
    if (!timezone) return null;
    try {
      const expected = this.timezoneCacheBuckets(resolution, timezone, q);
      if (expected.length === 0) return null;
      const registry = await this.pg.query(
        "SELECT timezone FROM clickhouse_rollup_timezones WHERE timezone = $1",
        [timezone],
      );
      if (registry.rowCount !== 1) return null;

      const watermark = await this.pg.query<{ watermark: Date }>(
        "SELECT watermark FROM clickhouse_rollup_watermarks WHERE name = $1",
        [USAGE_15M_V2.name],
      );
      const coveredTo = watermark.rows[0]?.watermark;
      if (!coveredTo) return null;

      const dirty = await this.pg.query<{ bucket: Date }>(
        `SELECT min(bucket) AS bucket
         FROM clickhouse_rollup_dirty_buckets
         WHERE name = $1
           AND bucket >= $2
           AND bucket < $3`,
        [USAGE_15M_V2.name, expected[0]!.from, expected.at(-1)!.to],
      );
      const dirtyBucket = dirty.rows[0]?.bucket;

      const jobs = await this.pg.query<{ bucket: Date; status: "pending" | "inflight" | "done" }>(
        `SELECT bucket, status
         FROM clickhouse_timezone_rollup_jobs
         WHERE resolution = $1
           AND timezone = $2
           AND bucket >= $3
           AND bucket < $4
         ORDER BY bucket`,
        [resolution, timezone, expected[0]!.from, expected.at(-1)!.to],
      );
      const coverage = await this.pg.query<{ bucket: Date }>(
        `SELECT bucket
         FROM clickhouse_timezone_rollup_coverage
         WHERE resolution = $1
           AND timezone = $2
           AND bucket >= $3
           AND bucket < $4
         ORDER BY bucket`,
        [resolution, timezone, expected[0]!.from, expected.at(-1)!.to],
      );
      const jobStatus = new Map(
        jobs.rows.map((job) => [new Date(job.bucket).getTime(), job.status]),
      );
      const covered = new Set(
        coverage.rows.map(({ bucket }) => new Date(bucket).getTime()),
      );
      let cacheTo: Date | null = null;
      for (const bucket of expected) {
        if (bucket.to > coveredTo) break;
        if (dirtyBucket && dirtyBucket < bucket.to) break;
        const status = jobStatus.get(bucket.from.getTime());
        if (!covered.has(bucket.from.getTime()) || (status != null && status !== "done")) break;
        cacheTo = bucket.to;
      }
      return cacheTo ? { from: expected[0]!.from, to: cacheTo } : null;
    } catch {
      return null;
    }
  }

  private timezoneSource(
    resolution: "hour" | "day",
    timezone: string,
    q: ScopedQuery,
  ): TimeseriesSource {
    const filter = this.scopedAndFilter(q);
    const table = resolution === "hour"
      ? "usage_hourly_timezone_rollup"
      : "usage_daily_timezone_rollup";
    return {
      source: `(SELECT bucket_start, bucket_start AS ts, provider_key, user_id, team_id, session_id, model, host,
                       input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd
                FROM ${table} FINAL
                WHERE timezone = {timezone:String}
                  AND bucket_start >= {from:DateTime64(3)}
                  AND bucket_start < {to:DateTime64(3)}
                  ${filter.sql})`,
      params: {
        timezone,
        from: chTs(q.from),
        to: chTs(q.to),
        ...filter.params,
      },
      resolution: resolution === "hour" ? "timezone-hour" : "timezone-day",
    };
  }

  private async resolveTimeseriesSource(
    q: ScopedQuery,
    bucket: TimeBucket | undefined,
    timezone: string,
  ): Promise<TimeseriesSource> {
    const canonical = canonicalTimezoneId(timezone);
    const resolution = bucket === "day" ? "day" : bucket === "hour" ? "hour" : null;
    const cache = canonical && resolution
      ? await this.cacheReady(resolution, canonical, q)
      : null;
    if (!cache || !canonical || !resolution) {
      return this.exactTimeseriesSource(q);
    }

    const parts: Array<{ name: "head" | "cache" | "tail"; source: TimeseriesSource }> = [];
    if (q.from < cache.from) {
      parts.push({
        name: "head",
        source: await this.exactTimeseriesSource({ ...q, from: q.from, to: cache.from }),
      });
    }
    parts.push({
      name: "cache",
      source: this.timezoneSource(resolution, canonical, { ...q, from: cache.from, to: cache.to }),
    });
    if (cache.to < q.to) {
      parts.push({
        name: "tail",
        source: await this.exactTimeseriesSource({ ...q, from: cache.to, to: q.to }),
      });
    }
    return this.combineTimeseriesSources(parts);
  }

  private async rollupWindow(
    q: ScopedQuery,
    spec: RollupSpec,
  ): Promise<{ rollupFrom: Date; rollupTo: Date } | null> {
    if (q.to <= q.from) return null;
    const rollupFrom = ceilRollupDate(q.from, spec.intervalMs);
    let rollupTo = floorRollupDate(q.to, spec.intervalMs);
    if (rollupTo <= rollupFrom) return null;
    const watermark = await this.pg.query<{ watermark: Date }>(
      "SELECT watermark FROM clickhouse_rollup_watermarks WHERE name = $1",
      [spec.name],
    );
    const current = watermark.rows[0]?.watermark;
    if (!current) return null;
    if (current < rollupTo) rollupTo = current;
    if (rollupTo <= rollupFrom) return null;
    const dirty = await this.pg.query<{ bucket: Date }>(
      `SELECT min(bucket) AS bucket
       FROM clickhouse_rollup_dirty_buckets
       WHERE name = $1
         AND bucket >= $2
         AND bucket < $3`,
      [spec.name, rollupFrom, rollupTo],
    );
    const dirtyBucket = dirty.rows[0]?.bucket;
    if (dirtyBucket && dirtyBucket < rollupTo) rollupTo = dirtyBucket;
    return rollupTo > rollupFrom ? { rollupFrom, rollupTo } : null;
  }

  private async rollupSource(q: ScopedQuery, spec: RollupSpec): Promise<RollupSource | null> {
    const window = await this.rollupWindow(q, spec);
    if (!window) return null;
    const filter = this.scopedAndFilter(q);
    const v2Dimensions = spec.name === USAGE_15M_V2.name
      ? ", pricing_revision_id, cost_status"
      : "";
    const params = {
      from: chTs(q.from),
      rollupFrom: chTs(window.rollupFrom),
      rollupTo: chTs(window.rollupTo),
      to: chTs(q.to),
      ...filter.params,
    };
    const source = `(
      SELECT ts, provider_key, user_id, team_id, session_id, model, host,
             input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd
      FROM ${this.usageEventsSource}
      WHERE ts >= {from:DateTime64(3)}
        AND ts < {rollupFrom:DateTime64(3)}
        ${filter.sql}
      UNION ALL
      SELECT ts, provider_key, user_id, team_id, session_id, model, host,
             input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd
      FROM (
        SELECT bucket_15m AS ts,
               provider_key,
               user_id,
               team_id,
               session_id,
               model,
               host,
               argMax(input_tokens, version) AS input_tokens,
               argMax(output_tokens, version) AS output_tokens,
               argMax(cache_read_tokens, version) AS cache_read_tokens,
               argMax(cache_creation_tokens, version) AS cache_creation_tokens,
               argMax(cost_usd, version) AS cost_usd
        FROM ${spec.table}
        WHERE ${spec.bucketColumn} >= {rollupFrom:DateTime64(3)}
          AND ${spec.bucketColumn} < {rollupTo:DateTime64(3)}
          ${filter.sql}
        GROUP BY ${spec.bucketColumn}, provider_key, user_id, team_id, session_id, model, host${v2Dimensions}
      )
      UNION ALL
      SELECT ts, provider_key, user_id, team_id, session_id, model, host,
             input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd
      FROM ${this.usageEventsSource}
      WHERE ts >= {rollupTo:DateTime64(3)}
        AND ts < {to:DateTime64(3)}
        ${filter.sql}
    )`;
    return { source, params, resolution: "15m", from: window.rollupFrom, to: window.rollupTo };
  }

  private async rollup15mV2Source(q: ScopedQuery): Promise<RollupSource | null> {
    if (!this.read15mV2Rollup) return null;
    return this.rollupSource(q, USAGE_15M_V2);
  }

  private async rollup15mTimeseriesSource(q: ScopedQuery): Promise<RollupSource | null> {
    if (this.read15mV2Rollup) return this.rollup15mV2Source(q);
    if (!this.read15mRollup) return null;
    return this.rollupSource(q, USAGE_15M);
  }

  private namespaceInsightSource(
    part: InsightSourcePart,
    prefix: "previous" | "current",
  ): { source: string; where: string; params: Params } {
    let source = part.source;
    let where = part.kind === "raw" ? part.where : "";
    const params: Params = {};
    for (const [key, value] of Object.entries(part.params)) {
      const namespaced = `${prefix}_${key}`;
      source = source.replaceAll(`{${key}:`, `{${namespaced}:`);
      where = where.replaceAll(`{${key}:`, `{${namespaced}:`);
      params[namespaced] = value;
    }
    return { source, where, params };
  }

  private async insightPeriodSource(
    q: ScopedQuery,
    prefix: "previous" | "current",
    timezone: string,
  ): Promise<{ source: string; where: string; params: Params }> {
    const source = await this.resolveTimeseriesSource(q, "day", timezone);
    return this.namespaceInsightSource(
      { kind: "hybrid", source: source.source, params: source.params },
      prefix,
    );
  }

  private async insightSource(q: InsightComparisonQuery, userId: string): Promise<InsightSource> {
    const timezone = safeTimezone(q.timezone, this.tz);
    const [previous, current] = await Promise.all([
      this.insightPeriodSource({ ...q.previous, providerKey: q.providerKey, userId }, "previous", timezone),
      this.insightPeriodSource({ ...q.current, providerKey: q.providerKey, userId }, "current", timezone),
    ]);
    const columns = `ts, provider_key, user_id, team_id, session_id, model, host,
                     input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd`;
    return {
      source: `(
        SELECT 'previous' AS period, ${columns}
        FROM ${previous.source} ${previous.where}
        UNION ALL
        SELECT 'current' AS period, ${columns}
        FROM ${current.source} ${current.where}
      )`,
      params: { ...previous.params, ...current.params },
    };
  }

  private async ensureClickHouseSchema(): Promise<void> {
    for (const query of CLICKHOUSE_SCHEMA_DDL) {
      await this.ch.command({ query });
    }
    if (this.enforceRetentionTtl) {
      await this.ch.command({ query: CLICKHOUSE_RAW_RETENTION_DDL });
    }
  }

  private ensureSchema(): Promise<void> {
    this.schemaReady ??= this.ensureClickHouseSchema().catch((err) => {
      this.schemaReady = undefined;
      throw err;
    });
    return this.schemaReady;
  }

  private async queryJson<T>(query: string, query_params: Params): Promise<T[]> {
    return retryTransientClickHouseError(async () => {
      await this.ensureSchema();
      const rs = await this.ch.query({ query, query_params, format: "JSONEachRow" });
      return rs.json<T>();
    });
  }

  // ── 쓰기 ──
  private rawSeq = 0;

  async saveRawEvent(providerKey: string, payload: unknown): Promise<number> {
    await this.ensureSchema();
    // ms 내 단조 증가 시퀀스로 충돌 완화(난수보다 안정적; raw id 하류 의존 없음)
    const id = Date.now() * 1000 + (this.rawSeq++ % 1000);
    await this.ch.insert({
      table: "raw_events",
      values: [{ id, provider_key: providerKey, payload: JSON.stringify(payload) }],
      format: "JSONEachRow",
    });
    return id;
  }

  async saveUsageEvents(events: FinalizedUsageEvent[]): Promise<SaveResult> {
    if (events.length === 0) return { inserted: 0, deduped: 0 };
    const res = await this.enqueueUsageEvents(events);
    if (res.inserted > 0) {
      try {
        await this.flushUsageOutbox();
      } catch (e) {
        console.warn(`[toard] ClickHouse outbox flush failed; queued rows retained: ${String(e)}`);
      }
    }
    return { inserted: res.inserted, deduped: res.deduped };
  }

  private async enqueueUsageEvents(events: FinalizedUsageEvent[]): Promise<EnqueueResult> {
    const client = await this.pg.connect();
    try {
      await client.query("BEGIN");
      const teamMap = await this.teamMap(
        client,
        events.map((e) => e.userId).filter((x): x is string => !!x),
      );
      const batch = await client.query<{ id: string }>(
        `INSERT INTO clickhouse_usage_batches (insert_token)
         VALUES ($1)
         RETURNING id`,
        [`toard-usage-${globalThis.crypto.randomUUID()}`],
      );
      const batchId = batch.rows[0]!.id;
      let inserted = 0;
      for (const e of events) {
        const teamId = e.userId ? (teamMap.get(e.userId) ?? null) : null;
        const r = await client.query(
          `INSERT INTO clickhouse_usage_outbox
             (dedup_key, batch_id, provider_key, user_id, team_id, session_id, model, ts,
              input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd,
              log_adapter, host, pricing_revision_id, cost_status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
           ON CONFLICT (dedup_key) DO NOTHING`,
          [
            e.dedupKey,
            batchId,
            e.providerKey,
            e.userId,
            teamId,
            e.sessionId,
            e.model,
            e.ts,
            e.inputTokens,
            e.outputTokens,
            e.cacheReadTokens,
            e.cacheCreationTokens,
            e.costUsd,
            e.logAdapter ?? null,
            e.host ?? null,
            e.pricingRevisionId,
            e.costStatus,
          ],
        );
        if (r.rowCount === 1) inserted++;
      }
      if (inserted === 0) {
        await client.query("DELETE FROM clickhouse_usage_batches WHERE id = $1", [batchId]);
      }
      await client.query("COMMIT");
      return { inserted, deduped: events.length - inserted, ...(inserted > 0 ? { batchId } : {}) };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async flushUsageOutbox(limit = 10): Promise<FlushUsageOutboxResult> {
    await this.ensureSchema();
    const client = await this.pg.connect();
    let batches = 0;
    let rows = 0;
    try {
      const locked = await client.query<OutboxBatch>(
        `WITH candidate AS (
           SELECT id
           FROM clickhouse_usage_batches
           WHERE delivered_at IS NULL
             AND (
               status = 'pending'
               OR (status = 'inflight' AND locked_at < now() - interval '5 minutes')
             )
           ORDER BY created_at
           LIMIT $1
           FOR UPDATE SKIP LOCKED
         )
         UPDATE clickhouse_usage_batches b
         SET status = 'inflight',
             attempts = attempts + 1,
             locked_at = now(),
             updated_at = now()
         FROM candidate
         WHERE b.id = candidate.id
         RETURNING b.id::text AS id, b.insert_token AS "insertToken"`,
        [limit],
      );
      for (const batch of locked.rows) {
        const batchRows = await client.query<OutboxRow>(
          `SELECT dedup_key, provider_key, user_id::text, team_id::text, session_id, model, ts,
                  input_tokens::text, output_tokens::text, cache_read_tokens::text,
                  cache_creation_tokens::text, cost_usd::text, log_adapter, host,
                  pricing_revision_id::text, cost_status
           FROM clickhouse_usage_outbox
           WHERE batch_id = $1
           ORDER BY dedup_key`,
          [batch.id],
        );
        try {
          await this.insertOutboxRows(batch, batchRows.rows);
          await client.query("BEGIN");
          await this.mark15mRollupDirty(client, batchRows.rows);
          await client.query(
            `UPDATE clickhouse_usage_outbox
             SET delivered_at = now()
             WHERE batch_id = $1`,
            [batch.id],
          );
          await client.query(
            `UPDATE clickhouse_usage_batches
             SET status = 'delivered',
                 delivered_at = now(),
                 locked_at = NULL,
                 last_error = NULL,
                 updated_at = now()
             WHERE id = $1`,
            [batch.id],
          );
          await client.query("COMMIT");
          batches++;
          rows += batchRows.rowCount ?? 0;
        } catch (e) {
          await client.query("ROLLBACK").catch(() => undefined);
          await client.query(
            `UPDATE clickhouse_usage_batches
             SET status = 'pending',
                 locked_at = NULL,
                 last_error = left($2, 2000),
                 updated_at = now()
             WHERE id = $1`,
            [batch.id, String(e)],
          );
          throw e;
        }
      }
      return { batches, rows };
    } finally {
      client.release();
    }
  }

  private async insertOutboxRows(batch: OutboxBatch, rows: OutboxRow[]): Promise<void> {
    if (rows.length === 0) return;
    const rawRows = rows.map((e) => ({
      dedup_key: e.dedup_key,
      provider_key: e.provider_key,
      user_id: e.user_id ?? "",
      team_id: e.team_id ?? "",
      session_id: e.session_id ?? "",
      model: e.model ?? "",
      ts: chTs(new Date(e.ts)),
      input_tokens: Number(e.input_tokens),
      output_tokens: Number(e.output_tokens),
      cache_read_tokens: Number(e.cache_read_tokens),
      cache_creation_tokens: Number(e.cache_creation_tokens),
      cost_usd: e.cost_usd,
      pricing_revision_id: e.pricing_revision_id ?? "",
      cost_status: e.cost_status,
      log_adapter: e.log_adapter ?? "",
      host: e.host ?? "",
    }));
    await this.ch.insert({
      table: "usage_events",
      values: rawRows,
      format: "JSONEachRow",
      clickhouse_settings: {
        insert_deduplication_token: `${batch.insertToken}:raw`,
      },
    });

    const rollupRows = this.rollupRows(rows);
    await this.ch.insert({
      table: "usage_hourly_rollup",
      values: rollupRows,
      format: "JSONEachRow",
      clickhouse_settings: {
        insert_deduplication_token: `${batch.insertToken}:rollup`,
      },
    });
  }

  private rollupRows(rows: OutboxRow[]): RollupRow[] {
    const acc = new Map<string, RollupAccumulator>();
    for (const e of rows) {
      const bucket = hourBucket(e.ts);
      const provider = e.provider_key;
      const user = e.user_id ?? "";
      const team = e.team_id ?? "";
      const session = e.session_id ?? "";
      const model = e.model ?? "";
      const host = e.host ?? "";
      const key = JSON.stringify([bucket, provider, user, team, session, model, host]);
      let r = acc.get(key);
      if (!r) {
        r = {
          bucket_hour: bucket,
          provider_key: provider,
          user_id: user,
          team_id: team,
          session_id: session,
          model,
          host,
          event_count: 0,
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
          cost_scaled: 0n,
        };
        acc.set(key, r);
      }
      r.event_count += 1;
      r.input_tokens += Number(e.input_tokens);
      r.output_tokens += Number(e.output_tokens);
      r.cache_read_tokens += Number(e.cache_read_tokens);
      r.cache_creation_tokens += Number(e.cache_creation_tokens);
      r.cost_scaled += costToScaled(e.cost_usd);
    }
    return [...acc.values()].map(({ cost_scaled, ...r }) => ({
      ...r,
      cost_usd: scaledToCost(cost_scaled),
    }));
  }

  private dirty15mBuckets(rows: OutboxRow[]): Date[] {
    const buckets = new Set(rows.map((r) => fifteenMinuteBucket(r.ts)));
    return [...buckets].map(chDate).sort((a, b) => a.getTime() - b.getTime());
  }

  private async mark15mRollupDirty(client: PoolClient, rows: OutboxRow[]): Promise<void> {
    const buckets = this.dirty15mBuckets(rows);
    if (buckets.length === 0) return;
    for (const spec of USAGE_ROLLUPS) {
      await client.query(
        `INSERT INTO clickhouse_rollup_dirty_buckets (name, bucket)
         SELECT $1, unnest($2::timestamptz[])
         ON CONFLICT (name, bucket) DO UPDATE
           SET updated_at = now()`,
        [spec.name, buckets],
      );
    }
  }

  private async firstRollupBucket(spec: RollupSpec): Promise<Date | null> {
    const intervalMinutes = spec.intervalMs / 60_000;
    const source = this.compactorSource(spec);
    const rows = await this.queryJson<{ events?: string; first_bucket?: string }>(
      `SELECT count() AS events,
              min(toStartOfInterval(ts, INTERVAL ${intervalMinutes} minute, 'UTC')) AS first_bucket
       FROM ${source}`,
      {},
    );
    const row = rows[0];
    if (!row || n(row.events) === 0 || !row.first_bucket) return null;
    return chDate(row.first_bucket);
  }

  private async readOrInitWatermark(client: PoolClient, spec: RollupSpec, eligibleTo: Date): Promise<Date> {
    const current = await client.query<{ watermark: Date }>(
      "SELECT watermark FROM clickhouse_rollup_watermarks WHERE name = $1",
      [spec.name],
    );
    if (current.rows[0]) return current.rows[0].watermark;

    const firstBucket = await this.firstRollupBucket(spec);
    const watermark = firstBucket ?? eligibleTo;
    await client.query(
      `INSERT INTO clickhouse_rollup_watermarks (name, watermark)
       VALUES ($1, $2)
       ON CONFLICT (name) DO NOTHING`,
      [spec.name, watermark],
    );
    const saved = await client.query<{ watermark: Date }>(
      "SELECT watermark FROM clickhouse_rollup_watermarks WHERE name = $1",
      [spec.name],
    );
    return saved.rows[0]?.watermark ?? watermark;
  }

  private compactorSource(spec: RollupSpec): string {
    return spec.sourcePolicy === "canonical_final" ? "usage_events FINAL" : this.usageEventsSource;
  }

  private async aggregateRollupBuckets(
    spec: RollupSpec,
    buckets: Date[],
    version: number,
  ): Promise<Rollup15mRow[]> {
    if (buckets.length === 0) return [];
    const sorted = [...buckets].sort((a, b) => a.getTime() - b.getTime());
    const from = sorted[0]!;
    const to = new Date(sorted.at(-1)!.getTime() + spec.intervalMs);
    const intervalMinutes = spec.intervalMs / 60_000;
    const v2 = spec.name === USAGE_15M_V2.name;
    const pricingColumns = v2 ? "\n              pricing_revision_id,\n              cost_status," : "";
    const costAggregate = v2
      ? "sumIf(cost_usd, cost_status != 'unpriced')"
      : "sum(cost_usd)";
    const pricingGroup = v2 ? ", pricing_revision_id, cost_status" : "";
    const source = this.compactorSource(spec);
    const rows = await this.queryJson<Rollup15mAggRow>(
      `SELECT toStartOfInterval(ts, INTERVAL ${intervalMinutes} minute, 'UTC') AS ${spec.bucketColumn},
              provider_key,
              user_id,
              team_id,
              session_id,
              model,
              host,${pricingColumns}
              count() AS event_count,
              sum(input_tokens) AS input_tokens,
              sum(output_tokens) AS output_tokens,
              sum(cache_read_tokens) AS cache_read_tokens,
              sum(cache_creation_tokens) AS cache_creation_tokens,
              ${costAggregate} AS cost_usd
       FROM ${source}
       WHERE ts >= {from:DateTime64(3)}
         AND ts < {to:DateTime64(3)}
         AND has(arrayMap(x -> toDateTime64(x, 3, 'UTC'), {buckets:Array(String)}), toStartOfInterval(ts, INTERVAL ${intervalMinutes} minute, 'UTC'))
       GROUP BY ${spec.bucketColumn}, provider_key, user_id, team_id, session_id, model, host${pricingGroup}`,
      { from: chTs(from), to: chTs(to), buckets: sorted.map(chTs) },
    );
    return rows.map((r) => ({
      bucket_15m: r.bucket_15m,
      provider_key: r.provider_key,
      user_id: r.user_id,
      team_id: r.team_id,
      session_id: r.session_id,
      model: r.model,
      host: r.host,
      ...(v2
        ? {
            pricing_revision_id: r.pricing_revision_id ?? "",
            cost_status: r.cost_status ?? "legacy",
          }
        : {}),
      event_count: n(r.event_count),
      input_tokens: n(r.input_tokens),
      output_tokens: n(r.output_tokens),
      cache_read_tokens: n(r.cache_read_tokens),
      cache_creation_tokens: n(r.cache_creation_tokens),
      cost_usd: r.cost_usd,
      version,
    }));
  }

  private async invalidateTimezoneRollupJobs(client: PoolClient, buckets: Date[]): Promise<void> {
    if (buckets.length === 0) return;
    await client.query(
      `WITH affected(bucket) AS (
         SELECT unnest($1::timestamptz[])
       ), requested(resolution, timezone, bucket) AS (
         SELECT DISTINCT resolution, timezone, date_trunc(resolution, affected.bucket, timezone)
         FROM affected
         CROSS JOIN clickhouse_rollup_timezones
         CROSS JOIN (VALUES ('hour'::text), ('day'::text)) AS resolutions(resolution)
       ), invalidated AS (
         DELETE FROM clickhouse_timezone_rollup_coverage AS coverage
         USING requested
         WHERE coverage.resolution = requested.resolution
           AND coverage.timezone = requested.timezone
           AND coverage.bucket = requested.bucket
       )
       INSERT INTO clickhouse_timezone_rollup_jobs (resolution, timezone, bucket)
       SELECT resolution, timezone, bucket
       FROM requested
       ON CONFLICT (resolution, timezone, bucket) DO UPDATE
       SET status = 'pending', updated_at = now()`,
      [buckets],
    );
  }

  private async compactUsageRollup(
    spec: RollupSpec,
    limitBuckets?: number,
  ): Promise<CompactUsage15mRollupResult> {
    await this.ensureSchema();
    const maxBuckets = Math.max(
      1,
      Math.min(256, Math.floor(limitBuckets ?? readPositiveIntEnv("CLICKHOUSE_ROLLUP_MAX_BUCKETS", CLICKHOUSE_ROLLUP_DEFAULT_MAX_BUCKETS))),
    );
    const delayMs = readPositiveIntEnv("CLICKHOUSE_ROLLUP_FINALIZE_DELAY_MS", CLICKHOUSE_ROLLUP_DEFAULT_FINALIZE_DELAY_MS);
    const eligibleTo = floorRollupDate(new Date(Date.now() - delayMs), spec.intervalMs);
    const client = await this.pg.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`rollup:${spec.name}`]);
      const watermark = await this.readOrInitWatermark(client, spec, eligibleTo);
      const dirtyLimit = Math.max(1, Math.ceil(maxBuckets / 2));
      const dirty = await client.query<{ bucket: Date }>(
        `SELECT bucket
         FROM clickhouse_rollup_dirty_buckets
         WHERE name = $1 AND bucket < $2
         ORDER BY bucket
         LIMIT $3`,
        [spec.name, eligibleTo, dirtyLimit],
      );
      const remaining = maxBuckets - dirty.rows.length;
      const contiguousCount = Math.min(
        remaining,
        Math.max(0, Math.floor((eligibleTo.getTime() - watermark.getTime()) / spec.intervalMs)),
      );
      const contiguousBuckets = Array.from(
        { length: contiguousCount },
        (_, i) => new Date(watermark.getTime() + i * spec.intervalMs),
      );
      const bucketsByMs = new Map<number, Date>();
      for (const bucket of contiguousBuckets) bucketsByMs.set(bucket.getTime(), bucket);
      for (const { bucket } of dirty.rows) bucketsByMs.set(bucket.getTime(), bucket);
      const buckets = [...bucketsByMs.values()].sort((a, b) => a.getTime() - b.getTime());

      if (buckets.length === 0) {
        await client.query("COMMIT");
        return { buckets: 0, rows: 0, watermark: watermark.toISOString() };
      }

      const version = Date.now();
      const rollupRows = await this.aggregateRollupBuckets(spec, buckets, version);
      if (rollupRows.length > 0) {
        await this.ch.insert({
          table: spec.table,
          values: rollupRows,
          format: "JSONEachRow",
        });
      }
      if (spec.name === USAGE_15M_V2.name) {
        await this.invalidateTimezoneRollupJobs(client, buckets);
      }

      const newWatermark = contiguousBuckets.length > 0
        ? new Date(watermark.getTime() + contiguousBuckets.length * spec.intervalMs)
        : watermark;
      await client.query(
        `UPDATE clickhouse_rollup_watermarks
         SET watermark = $2, updated_at = now()
         WHERE name = $1`,
        [spec.name, newWatermark],
      );
      await client.query(
        `DELETE FROM clickhouse_rollup_dirty_buckets
         WHERE name = $1 AND bucket = ANY($2::timestamptz[])`,
        [spec.name, buckets],
      );
      await client.query("COMMIT");
      return { buckets: buckets.length, rows: rollupRows.length, watermark: newWatermark.toISOString() };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async compactUsage15mRollup(limitBuckets?: number): Promise<CompactUsage15mRollupResult> {
    return this.compactUsageRollup(USAGE_15M, limitBuckets);
  }

  async compactUsage15mV2(limitBuckets?: number): Promise<CompactUsage15mV2Result> {
    return this.compactUsageRollup(USAGE_15M_V2, limitBuckets);
  }

  async supportsTimezone(timezoneInput: string): Promise<boolean> {
    const timezone = canonicalTimezoneId(timezoneInput);
    if (!timezone) return false;
    const rows = await this.queryJson<{ supported?: string }>(
      `SELECT count() AS supported
       FROM system.time_zones
       WHERE time_zone = {timezone:String}`,
      { timezone },
    );
    return n(rows[0]?.supported) > 0;
  }

  async compactTimezoneRollup(
    resolution: "hour" | "day",
    timezone: string,
    bucket: Date,
  ): Promise<number> {
    const tz = canonicalTimezoneId(timezone);
    if (!tz) throw new Error(`invalid IANA timezone: ${timezone}`);
    const bucketExpression = resolution === "hour"
      ? `toStartOfInterval(bucket_15m, INTERVAL 1 HOUR, '${tz}')`
      : `toStartOfDay(bucket_15m, '${tz}')`;
    const to = resolution === "hour"
      ? new Date(bucket.getTime() + 60 * 60 * 1000)
      : nextTimezoneDayStart(bucket, tz);
    const rows = await this.queryJson<TimezoneRollupAggRow>(
      `SELECT ${bucketExpression} AS bucket_start,
              provider_key,
              user_id,
              team_id,
              session_id,
              model,
              host,
              pricing_revision_id,
              cost_status,
              sum(event_count) AS event_count,
              sum(input_tokens) AS input_tokens,
              sum(output_tokens) AS output_tokens,
              sum(cache_read_tokens) AS cache_read_tokens,
              sum(cache_creation_tokens) AS cache_creation_tokens,
              sum(cost_usd) AS cost_usd
       FROM usage_15m_rollup_v2 FINAL
       WHERE bucket_15m >= {bucket:DateTime64(3)}
         AND bucket_15m < {to:DateTime64(3)}
         AND ${bucketExpression} = {bucket:DateTime64(3)}
       GROUP BY bucket_start, provider_key, user_id, team_id, session_id, model, host,
                pricing_revision_id, cost_status`,
      { bucket: chTs(bucket), to: chTs(to) },
    );
    if (rows.length === 0) return 0;

    const version = Date.now();
    await this.ch.insert({
      table: resolution === "hour" ? "usage_hourly_timezone_rollup" : "usage_daily_timezone_rollup",
      values: rows.map((row) => ({
        timezone: tz,
        bucket_start: chTs(bucket),
        user_id: row.user_id,
        team_id: row.team_id,
        provider_key: row.provider_key,
        model: row.model,
        host: row.host,
        session_id: row.session_id,
        pricing_revision_id: row.pricing_revision_id,
        cost_status: row.cost_status,
        event_count: n(row.event_count),
        input_tokens: n(row.input_tokens),
        output_tokens: n(row.output_tokens),
        cache_read_tokens: n(row.cache_read_tokens),
        cache_creation_tokens: n(row.cache_creation_tokens),
        cost_usd: row.cost_usd,
        version,
      })),
      format: "JSONEachRow",
    });
    return rows.length;
  }

  private async teamMap(client: PoolClient, userIds: string[]): Promise<Map<string, string>> {
    if (userIds.length === 0) return new Map();
    const uniq = [...new Set(userIds)];
    const rs = await client.query<{ id: string; team_id: string | null }>(
      "SELECT id, team_id FROM users WHERE id = ANY($1)",
      [uniq],
    );
    const m = new Map<string, string>();
    for (const r of rs.rows) if (r.team_id) m.set(r.id, r.team_id);
    return m;
  }

  // ClickHouse 는 읽기 시점 집계(FINAL) — 별도 Mart 재계산 불필요.
  async recomputeDaily(): Promise<void> {}

  // ── 읽기 ──
  private async overviewQuery(q: ScopedQuery & Partial<BucketOptions>): Promise<OverviewStats> {
    const timezone = safeTimezone(q.timezone, this.tz);
    const source = await this.resolveTimeseriesSource(q, q.bucket, timezone);
    const rows = await this.queryJson<AggRow>(
      `SELECT uniqExactIf(session_id, session_id != '') AS sessions,
              uniqExactIf(user_id, user_id != '')       AS active_users,
              sum(cost_usd)     AS cost,
              sum(input_tokens) AS input,
              sum(output_tokens) AS output,
              sum(cache_read_tokens)     AS cache_read,
              sum(cache_creation_tokens) AS cache_creation
       FROM ${source.source}`,
      source.params,
    );
    const r = rows[0];
    return {
      totalSessions: n(r?.sessions),
      activeUsers: n(r?.active_users),
      totalCostUsd: n(r?.cost),
      totalInputTokens: n(r?.input),
      totalOutputTokens: n(r?.output),
      totalCacheReadTokens: n(r?.cache_read),
      totalCacheCreationTokens: n(r?.cache_creation),
    };
  }

  private async dailyQuery(q: ScopedQuery & BucketOptions): Promise<DailyPoint[]> {
    // 버킷 타임존 — 요청(뷰어) 타임존 우선, 없으면 조직 타임존 (ADR-008 개정). 리터럴 삽입이라 재검증 필수.
    const tz = safeTimezone(q.timezone, this.tz);
    const source = await this.resolveTimeseriesSource(q, q.bucket, tz);
    // 하루 안 버킷은 'YYYY-MM-DD HH:mm', 일 버킷은 'YYYY-MM-DD' (storage 계약 참조)
    const bucketExpr = this.sourceBucketExpr(q.bucket, source, tz);
    const rows = await this.queryJson<{ day: string } & AggRow>(
      `SELECT ${bucketExpr}                                   AS day,
              uniqExactIf(session_id, session_id != '')       AS sessions,
              uniqExactIf(user_id, user_id != '')             AS active_users,
              sum(cost_usd)     AS cost,
              sum(input_tokens) AS input,
              sum(output_tokens) AS output,
              sum(cache_read_tokens)     AS cache_read,
              sum(cache_creation_tokens) AS cache_creation
       FROM ${source.source}
       GROUP BY day ORDER BY day`,
      source.params,
    );
    return rows.map((r) => ({
      day: r.day,
      sessions: n(r.sessions),
      activeUsers: n(r.active_users),
      costUsd: n(r.cost),
      inputTokens: n(r.input),
      outputTokens: n(r.output),
      cacheReadTokens: n(r.cache_read),
      cacheCreationTokens: n(r.cache_creation),
    }));
  }

  private async modelBreakdown(q: ScopedQuery & Partial<BucketOptions>): Promise<ModelBreakdown[]> {
    const timezone = safeTimezone(q.timezone, this.tz);
    const source = await this.resolveTimeseriesSource(q, q.bucket, timezone);
    const rows = await this.queryJson<{ model: string; cost?: string; tokens?: string; sessions?: string }>(
      `SELECT if(model = '', '(unknown)', model)               AS model,
              sum(cost_usd)                                     AS cost,
              sum(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens) AS tokens,
              uniqExactIf(session_id, session_id != '')         AS sessions
       FROM ${source.source}
       GROUP BY model ORDER BY cost DESC`,
      source.params,
    );
    return rows.map((r) => ({
      model: r.model,
      costUsd: n(r.cost),
      totalTokens: n(r.tokens),
      sessions: n(r.sessions),
    }));
  }

  // 버킷×모델 시계열 — dailyQuery 와 동일한 버킷 규약에 model 차원 추가 (스탯 뷰 스택 막대)
  async getUserModelTimeseries(userId: string, q: PeriodQuery & BucketOptions): Promise<ModelDailyPoint[]> {
    const scoped = { ...q, userId };
    const tz = safeTimezone(q.timezone, this.tz);
    const source = await this.resolveTimeseriesSource(scoped, q.bucket, tz);
    const bucketExpr = this.sourceBucketExpr(q.bucket, source, tz);
    const rows = await this.queryJson<{ day: string; model: string; cost?: string; tokens?: string }>(
      `SELECT ${bucketExpr}                                    AS day,
              if(model = '', '(unknown)', model)               AS model,
              sum(cost_usd)                                     AS cost,
              sum(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens) AS tokens
       FROM ${source.source}
       GROUP BY day, model ORDER BY day, cost DESC`,
      source.params,
    );
    return rows.map((r) => ({ day: r.day, model: r.model, costUsd: n(r.cost), totalTokens: n(r.tokens) }));
  }

  // 시간 버킷 고정 시계열 — 히트맵은 기간의 표시 버킷(day)과 무관하게 항상 hour 로 그린다
  getUserHourlyTimeseries(userId: string, q: PeriodQuery & { timezone?: string }): Promise<DailyPoint[]> {
    return this.dailyQuery({ ...q, userId, bucket: "hour" });
  }

  // 컴퓨터(호스트)별 분해 — modelBreakdown 동형. 빈 문자열('') 은 nullIf 로 NULL 정규화해
  // PG 의 NULL 과 동일하게 UI "(알 수 없음)" 버킷으로 접힌다.
  private async hostBreakdown(q: ScopedQuery & Partial<BucketOptions>): Promise<HostBreakdown[]> {
    const timezone = safeTimezone(q.timezone, this.tz);
    const source = await this.resolveTimeseriesSource(q, q.bucket, timezone);
    const rows = await this.queryJson<{ host: string | null; cost?: string; tokens?: string; sessions?: string }>(
      `SELECT nullIf(host, '')                                 AS host,
              sum(cost_usd)                                     AS cost,
              sum(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens) AS tokens,
              uniqExactIf(session_id, session_id != '')         AS sessions
       FROM ${source.source}
       GROUP BY host ORDER BY cost DESC`,
      source.params,
    );
    return rows.map((r) => ({
      host: r.host ?? null,
      costUsd: n(r.cost),
      totalTokens: n(r.tokens),
      sessions: n(r.sessions),
    }));
  }

  getOverview(q: PeriodQuery & { userId?: string; teamId?: string }): Promise<OverviewStats> {
    return this.overviewQuery(q);
  }

  getDailyTimeseries(
    q: PeriodQuery & BucketOptions & { scope?: TimeseriesScope; teamId?: string },
  ): Promise<DailyPoint[]> {
    return this.dailyQuery(q);
  }

  async getTeamMemberTimeseries(
    q: PeriodQuery & BucketOptions & { teamId: string; userIds: string[] },
  ): Promise<TeamMemberTimeseriesPoint[]> {
    if (q.userIds.length === 0) return [];
    const tz = safeTimezone(q.timezone, this.tz);
    const source = await this.resolveTimeseriesSource(q, q.bucket, tz);
    const bucketExpr = this.sourceBucketExpr(q.bucket, source, tz);
    const rows = await this.queryJson<{ day: string; user_id: string } & AggRow>(
      `SELECT ${bucketExpr}                                   AS day,
              user_id,
              uniqExactIf(session_id, session_id != '')       AS sessions,
              uniqExactIf(user_id, user_id != '')             AS active_users,
              sum(cost_usd)     AS cost,
              sum(input_tokens) AS input,
              sum(output_tokens) AS output,
              sum(cache_read_tokens)     AS cache_read,
              sum(cache_creation_tokens) AS cache_creation
       FROM ${source.source}
       GROUP BY day, user_id ORDER BY day, user_id`,
      source.params,
    );
    return rows.map((r) => ({
      userId: r.user_id,
      day: r.day,
      sessions: n(r.sessions),
      activeUsers: n(r.active_users),
      costUsd: n(r.cost),
      inputTokens: n(r.input),
      outputTokens: n(r.output),
      cacheReadTokens: n(r.cache_read),
      cacheCreationTokens: n(r.cache_creation),
    }));
  }

  async getUserUsage(userId: string, q: PeriodQuery & BucketOptions): Promise<UserUsage> {
    const scoped = { ...q, userId }; // bucket/timezone 은 dailyQuery 만 소비, 나머지 쿼리는 무시
    const overview = await this.overviewQuery(scoped);
    const daily = await this.dailyQuery(scoped);
    const byModel = await this.modelBreakdown(scoped);
    const byHost = await this.hostBreakdown(scoped);
    return { overview, daily, byModel, byHost };
  }

  async getUserInsightComparison(userId: string, q: InsightComparisonQuery): Promise<UserInsightComparison> {
    const source = await this.insightSource(q, userId);
    const tz = safeTimezone(q.timezone, this.tz);
    const [aggregateRows, compositionRows] = await Promise.all([
      this.queryJson<{
        kind: "summary" | "trend";
        period: "current" | "previous";
        position: string | null;
        cost?: string;
        sessions?: string;
        tokens?: string;
      }>(
        `WITH '/* user-insights */' AS query_tag,
         tagged AS (
           SELECT period,
                  if(period = 'current',
                     dateDiff('day', {current_from:DateTime64(3)}, ts, '${tz}'),
                     dateDiff('day', {previous_from:DateTime64(3)}, ts, '${tz}')) AS position,
                  session_id,
                  cost_usd,
                  input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens AS tokens
           FROM ${source.source}
         )
         SELECT 'summary' AS kind, period, CAST(NULL AS Nullable(Int64)) AS position,
                sum(cost_usd) AS cost,
                uniqExactIf(session_id, session_id != '') AS sessions,
                sum(tokens) AS tokens
         FROM tagged GROUP BY period
         UNION ALL
         SELECT 'trend' AS kind, period, position,
                sum(cost_usd) AS cost,
                uniqExactIf(session_id, session_id != '') AS sessions,
                sum(tokens) AS tokens
         FROM tagged GROUP BY period, position
         ORDER BY kind, position, period`,
        source.params,
      ),
      this.queryJson<{
        dimension: "model" | "provider";
        key: string;
        period: "current" | "previous";
        cost?: string;
        tokens?: string;
      }>(
        `WITH '/* user-insights */' AS query_tag,
         scoped AS (
           SELECT period,
                  if(model = '', '(unknown)', model) AS model,
                  provider_key,
                  cost_usd,
                  input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens AS tokens
           FROM ${source.source}
         )
         SELECT 'model' AS dimension, model AS key, period,
                sum(cost_usd) AS cost, sum(tokens) AS tokens
         FROM scoped GROUP BY model, period
         UNION ALL
         SELECT 'provider' AS dimension, provider_key AS key, period,
                sum(cost_usd) AS cost, sum(tokens) AS tokens
         FROM scoped GROUP BY provider_key, period`,
        source.params,
      ),
    ]);

    const aggregates: InsightAggregateRow[] = aggregateRows.map((r) => ({
      kind: r.kind,
      period: r.period,
      position: r.position == null ? null : n(r.position),
      costUsd: n(r.cost),
      sessions: n(r.sessions),
      totalTokens: n(r.tokens),
    }));
    const compositions: InsightCompositionRow[] = compositionRows.map((r) => ({
      dimension: r.dimension,
      key: r.key,
      period: r.period,
      costUsd: n(r.cost),
      totalTokens: n(r.tokens),
    }));
    return buildUserInsightComparison(aggregates, compositions);
  }

  // 내 기기 목록 — 기간·provider 무관 전체 이력(유휴 기기도 노출). '' → NULL 정규화.
  async getUserHosts(userId: string): Promise<DeviceInfo[]> {
    const rows = await this.queryJson<{ host: string | null; last_seen_at: string; event_count?: string }>(
      `SELECT nullIf(host, '')  AS host,
              max(ts)           AS last_seen_at,
              count()           AS event_count
       FROM ${this.usageEventsSource}
       WHERE user_id = {uid:String}
       GROUP BY host ORDER BY last_seen_at DESC`,
      { uid: userId },
    );
    return rows.map((r) => ({
      host: r.host ?? null,
      // CH DateTime64 'YYYY-MM-DD HH:mm:ss.SSS'(UTC) → 유효 ISO 로 변환
      lastSeenAt: new Date(`${r.last_seen_at.replace(" ", "T")}Z`),
      eventCount: n(r.event_count),
    }));
  }

  // 세션별 사용량 요약 — 히스토리 목록의 앱레벨 조인. user_id 동시 조건으로 타인 세션 차단.
  async getSessionUsageSummaries(userId: string, sessionIds: string[]): Promise<SessionUsageSummary[]> {
    if (sessionIds.length === 0) return [];
    const rows = await this.queryJson<{
      session_id: string;
      models: string[];
      hosts: string[];
      input?: string;
      output?: string;
      cache_read?: string;
      cache_creation?: string;
      cost?: string;
      events?: string;
    }>(
      `SELECT session_id,
              groupUniqArrayIf(model, model != '') AS models,
              groupUniqArrayIf(host,  host  != '') AS hosts,
              sum(input_tokens)          AS input,
              sum(output_tokens)         AS output,
              sum(cache_read_tokens)     AS cache_read,
              sum(cache_creation_tokens) AS cache_creation,
              sum(cost_usd)              AS cost,
              count()                    AS events
       FROM ${this.usageEventsSource}
       WHERE user_id = {uid:String} AND session_id IN {sids:Array(String)}
       GROUP BY session_id`,
      { uid: userId, sids: sessionIds },
    );
    return rows.map((r) => ({
      sessionId: r.session_id,
      models: r.models,
      hosts: r.hosts,
      inputTokens: n(r.input),
      outputTokens: n(r.output),
      cacheReadTokens: n(r.cache_read),
      cacheCreationTokens: n(r.cache_creation),
      costUsd: n(r.cost),
      eventCount: n(r.events),
    }));
  }

  // 한 세션의 사용 이벤트(ts ASC) — 히스토리 상세의 턴별 매칭용.
  async getSessionUsageEvents(userId: string, sessionId: string): Promise<SessionUsageEventRow[]> {
    const rows = await this.queryJson<{
      ts: string;
      model: string | null;
      input?: string;
      output?: string;
      cache_read?: string;
      cache_creation?: string;
      cost?: string;
    }>(
      `SELECT ts,
              nullIf(model, '')          AS model,
              input_tokens               AS input,
              output_tokens              AS output,
              cache_read_tokens          AS cache_read,
              cache_creation_tokens      AS cache_creation,
              cost_usd                   AS cost
       FROM ${this.usageEventsSource}
       WHERE user_id = {uid:String} AND session_id = {sid:String}
       ORDER BY ts ASC`,
      { uid: userId, sid: sessionId },
    );
    return rows.map((r) => ({
      // CH DateTime64 'YYYY-MM-DD HH:mm:ss.SSS'(UTC) → 유효 ISO 로 변환
      ts: new Date(`${r.ts.replace(" ", "T")}Z`),
      model: r.model ?? null,
      inputTokens: n(r.input),
      outputTokens: n(r.output),
      cacheReadTokens: n(r.cache_read),
      cacheCreationTokens: n(r.cache_creation),
      costUsd: n(r.cost),
    }));
  }

  async getLeaderboard(q: PeriodQuery & { scope: LeaderScope; teamId?: string; orderBy?: "cost" | "tokens" }): Promise<LeaderRow[]> {
    const dashboardQuery = q as ScopedQuery & Partial<BucketOptions>;
    const timezone = safeTimezone(dashboardQuery.timezone, this.tz);
    const source = await this.resolveTimeseriesSource(dashboardQuery, dashboardQuery.bucket, timezone);
    const col = q.scope === "user" ? "user_id" : "team_id";
    const orderColumn = q.orderBy === "tokens" ? "tokens" : "cost";
    const rows = await this.queryJson<{ key: string; cost?: string; tokens?: string; sessions?: string }>(
      `SELECT ${col} AS key,
              sum(cost_usd)                             AS cost,
              sum(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens) AS tokens,
              uniqExactIf(session_id, session_id != '') AS sessions
       FROM ${source.source} WHERE ${col} != ''
       GROUP BY key ORDER BY ${orderColumn} DESC LIMIT 100`,
      source.params,
    );
    const labels = await this.labelMap(
      q.scope,
      rows.map((r) => r.key),
    );
    return rows.map((r) => ({
      key: r.key,
      label: labels.get(r.key) ?? r.key,
      costUsd: n(r.cost),
      totalTokens: n(r.tokens),
      sessions: n(r.sessions),
    }));
  }

  async getProviderBreakdown(q: PeriodQuery & { teamId?: string }): Promise<ProviderBreakdown[]> {
    const dashboardQuery = q as ScopedQuery & Partial<BucketOptions>;
    const timezone = safeTimezone(dashboardQuery.timezone, this.tz);
    const source = await this.resolveTimeseriesSource(dashboardQuery, dashboardQuery.bucket, timezone);
    const rows = await this.queryJson<{ provider_key: string; cost?: string; tokens?: string; sessions?: string }>(
      `SELECT provider_key,
              sum(cost_usd) AS cost,
              sum(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens) AS tokens,
              uniqExactIf(session_id, session_id != '') AS sessions
       FROM ${source.source}
       GROUP BY provider_key ORDER BY tokens DESC`,
      source.params,
    );
    return rows.map((r) => ({
      providerKey: r.provider_key,
      costUsd: n(r.cost),
      totalTokens: n(r.tokens),
      sessions: n(r.sessions),
    }));
  }

  private async labelMap(scope: LeaderScope, ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const sql =
      scope === "user"
        ? "SELECT id::text AS id, COALESCE(name, email) AS label FROM users WHERE id = ANY($1)"
        : "SELECT id::text AS id, name AS label FROM teams WHERE id = ANY($1)";
    const rs = await this.pg.query<{ id: string; label: string }>(sql, [ids]);
    return new Map(rs.rows.map((r) => [r.id, r.label]));
  }
}

function createClickHouseClient(): ClickHouseClient {
  return createClient({
    url: process.env.CLICKHOUSE_URL ?? "http://localhost:8123",
    username: process.env.CLICKHOUSE_USER ?? "toard",
    password: process.env.CLICKHOUSE_PASSWORD ?? "toard",
    database: process.env.CLICKHOUSE_DB ?? "toard",
  });
}

function readEnvFlag(name: string, defaultValue = false): boolean {
  const value = process.env[name];
  if (value == null || value === "") return defaultValue;
  return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "on";
}

/** 환경변수로 CH 클라이언트를 구성해 스토리지를 만든다 (메타용 PG 풀은 주입). */
export function createClickHouseStorage(pg: Pool, opts: ClickHouseStorageOptions = {}): ClickHouseStorage {
  return new ClickHouseStorage(createClickHouseClient(), pg, {
    readFinal: readEnvFlag("CLICKHOUSE_READ_FINAL", false),
    readRollup: readEnvFlag("CLICKHOUSE_READ_TIMEZONE_ROLLUP", false),
    read15mRollup: readEnvFlag("CLICKHOUSE_READ_15M_ROLLUP", false),
    read15mV2Rollup: readEnvFlag("CLICKHOUSE_READ_15M_V2_ROLLUP", false),
    enforceRetentionTtl: readEnvFlag("CLICKHOUSE_ENFORCE_RETENTION_TTL", false),
    ...opts,
  });
}

export async function pingClickHouse(): Promise<void> {
  await retryTransientClickHouseError(async () => {
    const ch = createClickHouseClient();
    try {
      const result = await ch.ping({ select: true });
      if (!result.success) throw result.error;
    } finally {
      await ch.close();
    }
  });
}

async function retryTransientClickHouseError<T>(op: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < CLICKHOUSE_TRANSIENT_RETRY_ATTEMPTS; attempt++) {
    try {
      return await op();
    } catch (err) {
      lastError = err;
      if (attempt === CLICKHOUSE_TRANSIENT_RETRY_ATTEMPTS - 1 || !isTransientClickHouseError(err)) throw err;
      await sleep(CLICKHOUSE_TRANSIENT_RETRY_BASE_MS * 2 ** attempt);
    }
  }
  throw lastError;
}

function isTransientClickHouseError(err: unknown): boolean {
  const codes = errorCodes(err);
  if (codes.some((code) => TRANSIENT_CLICKHOUSE_ERROR_CODES.has(code))) return true;
  const message = String(err instanceof Error ? err.message : err);
  return [...TRANSIENT_CLICKHOUSE_ERROR_CODES].some((code) => message.includes(code));
}

function readPositiveIntEnv(name: string, defaultValue: number): number {
  const value = process.env[name];
  if (value == null || value === "") return defaultValue;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : defaultValue;
}

function errorCodes(err: unknown): string[] {
  if (!err || typeof err !== "object") return [];
  const e = err as { code?: unknown; cause?: unknown };
  const own = typeof e.code === "string" ? [e.code] : [];
  return [...own, ...errorCodes(e.cause)];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
