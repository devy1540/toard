import {
  type ClickHouseClient,
  type ClickHouseSettings,
  createClient,
} from "@clickhouse/client";
import { createHash } from "node:crypto";
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
  OrganizationDashboardData,
  OrganizationDashboardQuery,
  OverviewStats,
  PeriodQuery,
  PricingRecoveryBatchResult,
  PricingRepairRequest,
  PricingRepairResolver,
  ProviderBreakdown,
  SaveResult,
  SessionUsageEventRow,
  SessionUsageSummary,
  ModelDailyPoint,
  StorageBackend,
  TeamAttributionBatchRequest,
  TeamAttributionBatchResult,
  TeamAttributionPreview,
  TeamAttributionRange,
  TeamMemberTimeseriesPoint,
  TimeBucket,
  TimeseriesScope,
  UsageEvent,
  UsageCostCoverage,
  UsageEventReconciliationRequest,
  UsageEventReconciliationResult,
  UsageReplayReconciliationRequest,
  UsageReplayReconciliationResult,
  PricingRecoveryModelDiagnostic,
  UserUsage,
  UserInsightComparison,
  UtilizationUsageDay,
  UtilizationUsageQuery,
} from "@toard/core";
import {
  addLocalCalendarDays,
  buildUserInsightComparison,
  CACHE_SIGNAL_PROVIDER_KEYS,
  canonicalTimezoneId,
  firstInstantOfLocalDate,
  localDateKey,
  CLICKHOUSE_RAW_RETENTION_DAYS,
} from "@toard/core";
import { Pool, type PoolClient } from "pg";
import {
  defaultClickHouseOperationController,
  type ClickHouseOperationRunner,
} from "./operation-controller";

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
const V2_ROLLUP_RETENTION_MS = 400 * 24 * 60 * 60 * 1_000;
const ROLLUP_VALIDATION_SETTINGS = {
  max_threads: 2,
  max_execution_time: 30,
} as const satisfies ClickHouseSettings;

function fifteenMinuteBucket(ts: Date | string): string {
  const d = new Date(ts);
  const minute = Math.floor(d.getUTCMinutes() / 15) * 15;
  d.setUTCMinutes(minute, 0, 0);
  return chTs(d);
}

function floorRollupDate(ts: Date, intervalMs: number): Date {
  return new Date(Math.floor(ts.getTime() / intervalMs) * intervalMs);
}

export function clampV2RollupStart(firstBucket: Date, eligibleTo: Date): Date {
  const minimum = new Date(eligibleTo.getTime() - V2_ROLLUP_RETENTION_MS);
  return firstBucket > minimum ? firstBucket : minimum;
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
  readRollup?: RollupReadMode;
  /** finalized 15분 rollup + 최근 raw tail hybrid 시계열 조회를 사용할지 여부. 기본 false. */
  read15mRollup?: boolean;
  /** 가격 provenance를 보존한 v2 15분 rollup 조회를 사용할지 여부. 기본 false. */
  read15mV2Rollup?: RollupReadMode;
  /** 원본 usage_events의 90일 논리 기간 + 7일 safety grace TTL을 적용할지 여부. */
  enforceRetentionTtl?: boolean;
  /** ClickHouse 요청 admission과 transient retry를 제어한다. */
  operationRunner?: ClickHouseOperationRunner;
}

export const ROLLUP_STORAGE_TABLES = [
  "raw_events",
  "usage_events",
  "usage_hourly_rollup",
  "usage_15m_rollup_v2",
  "usage_hourly_timezone_rollup",
  "usage_daily_timezone_rollup",
] as const;

export type RollupStorageTable = (typeof ROLLUP_STORAGE_TABLES)[number];
export type RollupReadMode = boolean | "auto";

export type RollupDataValidationResult = {
  ok: boolean;
  detail: string | null;
};

type RollupValidationSummary = {
  rows?: string | number;
  events?: string | number;
  input_tokens?: string | number;
  output_tokens?: string | number;
  cache_read_tokens?: string | number;
  cache_creation_tokens?: string | number;
  cost_usd?: string | number;
  fingerprint?: string | number;
};

function validationSummarySelect(bucketColumn: "bucket_15m" | "bucket_start"): string {
  const source = "validation_source";
  return `SELECT count() AS rows,
              sum(${source}.event_count) AS events,
              sum(${source}.input_tokens) AS input_tokens,
              sum(${source}.output_tokens) AS output_tokens,
              sum(${source}.cache_read_tokens) AS cache_read_tokens,
              sum(${source}.cache_creation_tokens) AS cache_creation_tokens,
              sum(${source}.cost_usd) AS cost_usd,
              groupBitXor(cityHash64(
                CAST(${source}.${bucketColumn} AS DateTime64(3, 'UTC')), ${source}.provider_key, ${source}.user_id,
                ${source}.team_id, ${source}.session_id, ${source}.model, ${source}.host,
                ${source}.pricing_revision_id, ${source}.cost_status, ${source}.event_count,
                ${source}.input_tokens, ${source}.output_tokens, ${source}.cache_read_tokens,
                ${source}.cache_creation_tokens, CAST(${source}.cost_usd AS Decimal(18, 8))
              )) AS fingerprint`;
}

export type RollupStorageStats = {
  collectedAt: string;
  rawRange: { from: string | null; to: string | null };
  tables: Record<RollupStorageTable, { rows: number; bytes: number }>;
};

/** CH 쿼리에 리터럴로 들어가므로 IANA 형식만 허용(주입 방지). 무효 시 fallback. */
function safeTimezone(tz: string | undefined, fallback = "UTC"): string {
  if (!tz || !/^[A-Za-z0-9_+/-]+$/.test(tz)) return fallback;
  return tz;
}

function clickHouseTimestampToIso(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  }
  if (typeof value !== "string") return null;
  const normalized = /(?:Z|[+-]\d\d(?::?\d\d)?)$/.test(value)
    ? value
    : `${value.replace(" ", "T")}Z`;
  const parsed = new Date(normalized);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

interface CostCoverageRow {
  priced_events?: string | number;
  unpriced_events?: string | number;
  legacy_events?: string | number;
}

interface AggRow extends CostCoverageRow {
  sessions?: string;
  active_users?: string;
  cost?: string;
  input?: string;
  output?: string;
  cache_read?: string;
  cache_creation?: string;
}

type OrganizationUsageBundleKind = "current_overview" | "previous_overview" | "daily";
type OrganizationBreakdownBundleKind = "user_leader" | "team_leader" | "provider";
type OrganizationDashboardNumeric = string | number;

interface OrganizationUsageBundleRow {
  result_kind: OrganizationUsageBundleKind;
  day: string | null;
  sessions: OrganizationDashboardNumeric;
  active_users: OrganizationDashboardNumeric;
  cost: OrganizationDashboardNumeric;
  input: OrganizationDashboardNumeric;
  output: OrganizationDashboardNumeric;
  cache_read: OrganizationDashboardNumeric;
  cache_creation: OrganizationDashboardNumeric;
  priced_events: OrganizationDashboardNumeric;
  unpriced_events: OrganizationDashboardNumeric;
  legacy_events: OrganizationDashboardNumeric;
}

interface OrganizationBreakdownBundleRow {
  result_kind: OrganizationBreakdownBundleKind;
  key: string;
  cost: OrganizationDashboardNumeric;
  tokens: OrganizationDashboardNumeric;
  sessions: OrganizationDashboardNumeric;
  priced_events: OrganizationDashboardNumeric;
  unpriced_events: OrganizationDashboardNumeric;
  legacy_events: OrganizationDashboardNumeric;
}

function organizationDashboardParsingError(
  bundle: "usage" | "breakdown",
  kind: string,
  field: string,
): Error {
  return new Error(`Organization dashboard ${bundle} row parsing error: ${kind}.${field}`);
}

function organizationDashboardRow(
  value: unknown,
  bundle: "usage" | "breakdown",
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw organizationDashboardParsingError(bundle, "unknown", "row");
  }
  return value as Record<string, unknown>;
}

function organizationDashboardNumeric(
  row: Record<string, unknown>,
  bundle: "usage" | "breakdown",
  kind: string,
  field: string,
): OrganizationDashboardNumeric {
  const value = row[field];
  const valid = typeof value === "number"
    ? Number.isFinite(value)
    : typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value));
  if (!valid) {
    throw organizationDashboardParsingError(bundle, kind, field);
  }
  return value as OrganizationDashboardNumeric;
}

function parseOrganizationUsageBundleRow(value: unknown): OrganizationUsageBundleRow {
  const row = organizationDashboardRow(value, "usage");
  const rawKind = row.result_kind;
  if (typeof rawKind !== "string") {
    throw organizationDashboardParsingError("usage", "unknown", "result_kind");
  }
  if (rawKind !== "current_overview" && rawKind !== "previous_overview" && rawKind !== "daily") {
    throw new Error("Unknown organization dashboard usage row kind");
  }
  const day = row.day;
  if (rawKind === "daily") {
    if (day == null) throw new Error("Organization dashboard daily row is missing its bucket");
    if (typeof day !== "string") {
      throw organizationDashboardParsingError("usage", rawKind, "day");
    }
  } else if (day !== null) {
    throw organizationDashboardParsingError("usage", rawKind, "day");
  }
  return {
    result_kind: rawKind,
    day,
    sessions: organizationDashboardNumeric(row, "usage", rawKind, "sessions"),
    active_users: organizationDashboardNumeric(row, "usage", rawKind, "active_users"),
    cost: organizationDashboardNumeric(row, "usage", rawKind, "cost"),
    input: organizationDashboardNumeric(row, "usage", rawKind, "input"),
    output: organizationDashboardNumeric(row, "usage", rawKind, "output"),
    cache_read: organizationDashboardNumeric(row, "usage", rawKind, "cache_read"),
    cache_creation: organizationDashboardNumeric(row, "usage", rawKind, "cache_creation"),
    priced_events: organizationDashboardNumeric(row, "usage", rawKind, "priced_events"),
    unpriced_events: organizationDashboardNumeric(row, "usage", rawKind, "unpriced_events"),
    legacy_events: organizationDashboardNumeric(row, "usage", rawKind, "legacy_events"),
  };
}

function parseOrganizationBreakdownBundleRow(value: unknown): OrganizationBreakdownBundleRow {
  const row = organizationDashboardRow(value, "breakdown");
  const rawKind = row.result_kind;
  if (typeof rawKind !== "string") {
    throw organizationDashboardParsingError("breakdown", "unknown", "result_kind");
  }
  if (rawKind !== "user_leader" && rawKind !== "team_leader" && rawKind !== "provider") {
    throw new Error("Unknown organization dashboard breakdown row kind");
  }
  if (typeof row.key !== "string") {
    throw organizationDashboardParsingError("breakdown", rawKind, "key");
  }
  return {
    result_kind: rawKind,
    key: row.key,
    cost: organizationDashboardNumeric(row, "breakdown", rawKind, "cost"),
    tokens: organizationDashboardNumeric(row, "breakdown", rawKind, "tokens"),
    sessions: organizationDashboardNumeric(row, "breakdown", rawKind, "sessions"),
    priced_events: organizationDashboardNumeric(row, "breakdown", rawKind, "priced_events"),
    unpriced_events: organizationDashboardNumeric(row, "breakdown", rawKind, "unpriced_events"),
    legacy_events: organizationDashboardNumeric(row, "breakdown", rawKind, "legacy_events"),
  };
}

const costCoverage = (row: CostCoverageRow | undefined): UsageCostCoverage => ({
  pricedEvents: n(row?.priced_events),
  unpricedEvents: n(row?.unpriced_events),
  legacyEvents: n(row?.legacy_events),
});

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

type PricingRepairClickHouseRow = OutboxRow;

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
  "ALTER TABLE raw_events MODIFY TTL toDateTime(received_at) + INTERVAL 7 DAY DELETE",
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
  "ALTER TABLE usage_hourly_rollup MODIFY TTL toDateTime(bucket_hour) + INTERVAL 400 DAY DELETE",
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
  `CREATE TABLE IF NOT EXISTS team_attribution_rollup_staging
   (
     job_id                 String,
     layer                  LowCardinality(String),
     bucket_start           DateTime64(3, 'UTC'),
     provider_key           LowCardinality(String),
     user_id                String,
     session_id             String,
     model                  LowCardinality(String),
     host                   LowCardinality(String),
     pricing_revision_id    String,
     cost_status            LowCardinality(String),
     event_count            UInt64,
     input_tokens           UInt64,
     output_tokens          UInt64,
     cache_read_tokens      UInt64,
     cache_creation_tokens  UInt64,
     cost_usd               Decimal(18, 8),
     version                UInt64,
     created_at             DateTime64(3, 'UTC') DEFAULT now64(3)
   )
   ENGINE = ReplacingMergeTree(version)
   PARTITION BY toYYYYMM(bucket_start)
   ORDER BY (job_id, layer, bucket_start, provider_key, user_id, session_id, model, host, pricing_revision_id, cost_status)
   TTL toDateTime(created_at) + INTERVAL 7 DAY DELETE`,
] as const;

const CLICKHOUSE_RAW_RETENTION_DDL =
  `ALTER TABLE usage_events MODIFY TTL toDateTime(ts) + INTERVAL ${CLICKHOUSE_RAW_RETENTION_DAYS} DAY DELETE`;

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
/**
 * ClickHouse 저장 백엔드 (설계 §4.3, ADR-003 옵트인).
 * 이벤트·집계는 CH(ReplacingMergeTree, 읽기 시 FINAL), 메타(이름)는 PG 에서 머지.
 * 팀 귀속은 이벤트 발생 시각의 소속 team_id 를 비정규화해 CH 단독 GROUP BY 로 성립.
 */
export class ClickHouseStorage implements StorageBackend {
  private readonly tz: string;
  private readonly usageEventsSource: string;
  private readonly readRollup: RollupReadMode;
  private readonly read15mRollup: boolean;
  private readonly read15mV2Rollup: RollupReadMode;
  private readonly enforceRetentionTtl: boolean;
  private readonly operationRunner: ClickHouseOperationRunner;
  private readonly cacheReadyInFlight = new Map<string, Promise<CacheWindow | null>>();
  private readonly timezoneBucketPlans = new Map<string, CacheBucket[]>();
  private runtimeReadStateCache:
    | { expiresAt: number; states: Map<"usage_15m_v2" | "timezone", string> }
    | undefined;
  private runtimeReadStateInFlight:
    | Promise<Map<"usage_15m_v2" | "timezone", string>>
    | undefined;
  private schemaReady: Promise<void> | undefined;

  constructor(
    private readonly ch: ClickHouseClient,
    private readonly pg: Pool,
    opts: ClickHouseStorageOptions = {},
  ) {
    this.operationRunner = opts.operationRunner ?? defaultClickHouseOperationController;
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

  private async runtimeReadStates(): Promise<Map<"usage_15m_v2" | "timezone", string>> {
    const now = Date.now();
    if (this.runtimeReadStateCache && now < this.runtimeReadStateCache.expiresAt) {
      return this.runtimeReadStateCache.states;
    }
    if (this.runtimeReadStateInFlight) return this.runtimeReadStateInFlight;
    let inFlight: Promise<Map<"usage_15m_v2" | "timezone", string>>;
    inFlight = this.pg.query<{ layer: "usage_15m_v2" | "timezone"; state: string }>(
      `SELECT layer, state
       FROM clickhouse_rollup_cutover_status
       WHERE layer IN ('usage_15m_v2', 'timezone')`,
    ).then(
      (result) => {
        const states = new Map(result.rows.map(({ layer, state }) => [layer, state]));
        this.runtimeReadStateCache = { expiresAt: Date.now() + 10_000, states };
        return states;
      },
      (error: unknown) => {
        this.runtimeReadStateCache = undefined;
        throw error;
      },
    ).finally(() => {
      if (this.runtimeReadStateInFlight === inFlight) this.runtimeReadStateInFlight = undefined;
    });
    this.runtimeReadStateInFlight = inFlight;
    return inFlight;
  }

  private async readLayerEnabled(
    layer: "usage_15m_v2" | "timezone",
    mode: RollupReadMode,
  ): Promise<boolean> {
    if (mode !== "auto") return mode;
    try {
      return (await this.runtimeReadStates()).get(layer) === "active";
    } catch {
      return false;
    }
  }

  async getRollupStorageStats(): Promise<RollupStorageStats> {
    type PartRow = { table: string; rows: string | number; bytes: string | number };
    type RangeRow = { from: string | Date | null; to: string | Date | null };
    const settings = { max_execution_time: 2 } as const;
    const [partRows, rangeRows] = await Promise.all([
      this.operationRunner.run("get_rollup_storage_stats_parts", () => this.ch.query({
        query: `SELECT table, sum(rows) AS rows, sum(bytes_on_disk) AS bytes
                FROM system.parts
                WHERE active = 1
                  AND database = currentDatabase()
                  AND table IN {tables:Array(String)}
                GROUP BY table`,
        query_params: { tables: [...ROLLUP_STORAGE_TABLES] },
        clickhouse_settings: settings,
        format: "JSONEachRow",
      }).then((result) => result.json<PartRow>())),
      this.operationRunner.run("get_rollup_storage_stats_range", () => this.ch.query({
        query: `SELECT if(count() = 0, NULL, min(ts)) AS from,
                       if(count() = 0, NULL, max(ts)) AS to
                FROM usage_events`,
        clickhouse_settings: settings,
        format: "JSONEachRow",
      }).then((result) => result.json<RangeRow>())),
    ]);

    const tables = Object.fromEntries(
      ROLLUP_STORAGE_TABLES.map((table) => [table, { rows: 0, bytes: 0 }]),
    ) as RollupStorageStats["tables"];
    for (const row of partRows) {
      if (!ROLLUP_STORAGE_TABLES.includes(row.table as RollupStorageTable)) continue;
      tables[row.table as RollupStorageTable] = {
        rows: n(row.rows),
        bytes: n(row.bytes),
      };
    }
    const range = rangeRows[0];
    return {
      collectedAt: new Date().toISOString(),
      rawRange: {
        from: clickHouseTimestampToIso(range?.from),
        to: clickHouseTimestampToIso(range?.to),
      },
      tables,
    };
  }

  async validateUsage15mV2(
    targetTo: Date,
    lookbackMs = 400 * 24 * 60 * 60 * 1_000,
  ): Promise<RollupDataValidationResult> {
    if (!Number.isFinite(targetTo.getTime())) throw new Error("invalid rollup validation target");
    const boundedLookback = Number.isFinite(lookbackMs) && lookbackMs > 0
      ? lookbackMs
      : 24 * 60 * 60 * 1_000;
    const requestedFrom = new Date(targetTo.getTime() - boundedLookback);
    const rawRange = await this.queryJson<{ from?: string | Date | null }>(
      `SELECT if(count() = 0, NULL, min(ts)) AS from
       FROM usage_events FINAL
       WHERE ts >= {from:DateTime64(3)}
         AND ts < {to:DateTime64(3)}`,
      { from: chTs(requestedFrom), to: chTs(targetTo) },
      ROLLUP_VALIDATION_SETTINGS,
    );
    const rawFrom = rawRange[0]?.from;
    const parsedRawFrom = rawFrom instanceof Date
      ? rawFrom
      : typeof rawFrom === "string" && rawFrom !== ""
        ? chDate(rawFrom)
        : null;
    const from = parsedRawFrom && Number.isFinite(parsedRawFrom.getTime())
      ? new Date(Math.floor(parsedRawFrom.getTime() / FIFTEEN_MINUTES_MS) * FIFTEEN_MINUTES_MS)
      : requestedFrom;
    const summarySelect = validationSummarySelect("bucket_15m");
    const raw = await this.queryJson<RollupValidationSummary>(
      `${summarySelect}
       FROM (
         SELECT toStartOfInterval(ts, INTERVAL 15 minute, 'UTC') AS bucket_15m,
                provider_key, user_id, team_id, session_id, model, host,
                pricing_revision_id, cost_status,
                count() AS event_count,
                sum(input_tokens) AS input_tokens,
                sum(output_tokens) AS output_tokens,
                sum(cache_read_tokens) AS cache_read_tokens,
                sum(cache_creation_tokens) AS cache_creation_tokens,
                sumIf(cost_usd, cost_status != 'unpriced') AS cost_usd
         FROM usage_events FINAL
         WHERE ts >= {from:DateTime64(3)}
           AND ts < {to:DateTime64(3)}
         GROUP BY bucket_15m, provider_key, user_id, team_id, session_id, model, host,
                  pricing_revision_id, cost_status
       ) AS validation_source`,
      { from: chTs(from), to: chTs(targetTo) },
      ROLLUP_VALIDATION_SETTINGS,
    );
    const rollup = await this.queryJson<RollupValidationSummary>(
      `${summarySelect}
       FROM usage_15m_rollup_v2 AS validation_source FINAL
       WHERE validation_source.bucket_15m >= {from:DateTime64(3)}
         AND validation_source.bucket_15m < {to:DateTime64(3)}`,
      { from: chTs(from), to: chTs(targetTo) },
      ROLLUP_VALIDATION_SETTINGS,
    );
    const fields = [
      "rows",
      "events",
      "input_tokens",
      "output_tokens",
      "cache_read_tokens",
      "cache_creation_tokens",
      "cost_usd",
      "fingerprint",
    ] as const;
    const rawSummary = raw[0] ?? {};
    const rollupSummary = rollup[0] ?? {};
    const mismatches = fields.filter(
      (field) => String(rawSummary[field] ?? 0) !== String(rollupSummary[field] ?? 0),
    );
    return mismatches.length === 0
      ? { ok: true, detail: null }
      : { ok: false, detail: `15m validation mismatch: ${mismatches.join(",")}` };
  }

  async validateTimezoneRollups(
    timezones: readonly string[],
    now = new Date(),
  ): Promise<RollupDataValidationResult> {
    if (!Number.isFinite(now.getTime())) throw new Error("invalid timezone rollup validation time");
    const fields = [
      "rows",
      "events",
      "input_tokens",
      "output_tokens",
      "cache_read_tokens",
      "cache_creation_tokens",
      "cost_usd",
      "fingerprint",
    ] as const;
    const summarySelect = validationSummarySelect("bucket_start");

    for (const timezoneInput of new Set(timezones)) {
      const timezone = canonicalTimezoneId(timezoneInput);
      if (!timezone) {
        return { ok: false, detail: `timezone validation rejected: ${timezoneInput}` };
      }
      const today = localDateKey(now, timezone);
      const todayStart = firstInstantOfLocalDate(today, timezone);
      const previousDayStart = firstInstantOfLocalDate(addLocalCalendarDays(today, -1), timezone);
      const currentHourIndex = Math.floor(
        Math.max(0, now.getTime() - todayStart.getTime()) / (60 * 60 * 1_000),
      );
      const currentHourStart = new Date(todayStart.getTime() + currentHourIndex * 60 * 60 * 1_000);
      const ranges = [
        {
          resolution: "hour" as const,
          from: new Date(currentHourStart.getTime() - 60 * 60 * 1_000),
          to: currentHourStart,
          expression: `toStartOfInterval(bucket_15m, INTERVAL 1 HOUR, '${timezone}')`,
          table: "usage_hourly_timezone_rollup",
        },
        {
          resolution: "day" as const,
          from: previousDayStart,
          to: todayStart,
          expression: `toStartOfDay(bucket_15m, '${timezone}')`,
          table: "usage_daily_timezone_rollup",
        },
      ];

      for (const range of ranges) {
        const params = {
          timezone,
          from: chTs(range.from),
          to: chTs(range.to),
        };
        const source = await this.queryJson<RollupValidationSummary>(
          `${summarySelect}
           FROM (
             SELECT ${range.expression} AS bucket_start,
                    provider_key, user_id, team_id, session_id, model, host,
                    pricing_revision_id, cost_status,
                    sum(event_count) AS event_count,
                    sum(input_tokens) AS input_tokens,
                    sum(output_tokens) AS output_tokens,
                    sum(cache_read_tokens) AS cache_read_tokens,
                    sum(cache_creation_tokens) AS cache_creation_tokens,
                    sum(cost_usd) AS cost_usd
             FROM usage_15m_rollup_v2 FINAL
             WHERE bucket_15m >= {from:DateTime64(3)}
               AND bucket_15m < {to:DateTime64(3)}
             GROUP BY bucket_start, provider_key, user_id, team_id, session_id, model, host,
                      pricing_revision_id, cost_status
           ) AS validation_source`,
          params,
          ROLLUP_VALIDATION_SETTINGS,
        );
        const rollup = await this.queryJson<RollupValidationSummary>(
          `${summarySelect}
           FROM ${range.table} AS validation_source FINAL
           WHERE validation_source.timezone = {timezone:String}
             AND validation_source.bucket_start >= {from:DateTime64(3)}
             AND validation_source.bucket_start < {to:DateTime64(3)}`,
          params,
          ROLLUP_VALIDATION_SETTINGS,
        );
        const sourceSummary = source[0] ?? {};
        const rollupSummary = rollup[0] ?? {};
        const mismatches = fields.filter(
          (field) => String(sourceSummary[field] ?? 0) !== String(rollupSummary[field] ?? 0),
        );
        if (mismatches.length > 0) {
          return {
            ok: false,
            detail: `${timezone} ${range.resolution} validation mismatch: ${mismatches.join(",")}`,
          };
        }
      }
    }
    return { ok: true, detail: null };
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
                       input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd,
                       cost_status, 1 AS event_count
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
                     input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd,
                     cost_status, event_count`;
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
    const planKey = [resolution, timezone, q.from.toISOString(), q.to.toISOString()].join("|");
    const cached = resolution === "day" ? this.timezoneBucketPlans.get(planKey) : undefined;
    if (cached) return cached;
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
    if (resolution === "day" && this.timezoneBucketPlans.size >= 64) {
      const oldest = this.timezoneBucketPlans.keys().next().value;
      if (oldest) this.timezoneBucketPlans.delete(oldest);
    }
    if (resolution === "day") this.timezoneBucketPlans.set(planKey, buckets);
    return buckets;
  }

  private async readCacheReadySnapshot(
    resolution: "hour" | "day",
    timezone: string,
    q: ScopedQuery,
  ): Promise<CacheWindow | null> {
    const expected = this.timezoneCacheBuckets(resolution, timezone, q);
    if (expected.length === 0) return null;
    const registry = await this.pg.query(
      `SELECT timezone
       FROM clickhouse_rollup_timezones
       WHERE timezone = $1
         AND validated_at IS NOT NULL`,
      [timezone],
    );
    if (registry.rowCount !== 1) return null;

    const [watermark, dirty, jobs, coverage] = await Promise.all([
      this.pg.query<{ watermark: Date }>(
        "SELECT watermark FROM clickhouse_rollup_watermarks WHERE name = $1",
        [USAGE_15M_V2.name],
      ),
      this.pg.query<{ bucket: Date }>(
        `SELECT min(bucket) AS bucket
         FROM clickhouse_rollup_dirty_buckets
         WHERE name = $1
           AND bucket >= $2
           AND bucket < $3`,
        [USAGE_15M_V2.name, expected[0]!.from, expected.at(-1)!.to],
      ),
      this.pg.query<{ bucket: Date; status: "pending" | "inflight" | "done" }>(
        `SELECT bucket, status
         FROM clickhouse_timezone_rollup_jobs
         WHERE resolution = $1
           AND timezone = $2
           AND bucket >= $3
           AND bucket < $4
         ORDER BY bucket`,
        [resolution, timezone, expected[0]!.from, expected.at(-1)!.to],
      ),
      this.pg.query<{ bucket: Date }>(
        `SELECT bucket
         FROM clickhouse_timezone_rollup_coverage
         WHERE resolution = $1
           AND timezone = $2
           AND bucket >= $3
           AND bucket < $4
         ORDER BY bucket`,
        [resolution, timezone, expected[0]!.from, expected.at(-1)!.to],
      ),
    ]);
    const coveredTo = watermark.rows[0]?.watermark;
    if (!coveredTo) return null;
    const dirtyBucket = dirty.rows[0]?.bucket;
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
  }

  private async cacheReady(
    resolution: "hour" | "day",
    timezoneInput: string,
    q: ScopedQuery,
  ): Promise<CacheWindow | null> {
    if (!(await this.readLayerEnabled("timezone", this.readRollup))) return null;
    const timezone = canonicalTimezoneId(timezoneInput);
    if (!timezone) return null;
    const key = [
      resolution,
      timezone,
      q.from.toISOString(),
      q.to.toISOString(),
      "rollup",
    ].join("|");
    let snapshot = this.cacheReadyInFlight.get(key);
    if (!snapshot) {
      snapshot = this.readCacheReadySnapshot(resolution, timezone, q);
      this.cacheReadyInFlight.set(key, snapshot);
      const settled = (): void => {
        if (this.cacheReadyInFlight.get(key) === snapshot) this.cacheReadyInFlight.delete(key);
      };
      void snapshot.then(settled, settled);
    }
    try {
      return await snapshot;
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
                       input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd,
                       cost_status, event_count
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
    const costStatusSelect = spec.name === USAGE_15M_V2.name
      ? "cost_status"
      : "'legacy' AS cost_status";
    const params = {
      from: chTs(q.from),
      rollupFrom: chTs(window.rollupFrom),
      rollupTo: chTs(window.rollupTo),
      to: chTs(q.to),
      ...filter.params,
    };
    const source = `(
      SELECT ts, provider_key, user_id, team_id, session_id, model, host,
             input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd,
             cost_status, 1 AS event_count
      FROM ${this.usageEventsSource}
      WHERE ts >= {from:DateTime64(3)}
        AND ts < {rollupFrom:DateTime64(3)}
        ${filter.sql}
      UNION ALL
      SELECT ts, provider_key, user_id, team_id, session_id, model, host,
             input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd,
             cost_status, event_count
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
               argMax(cost_usd, version) AS cost_usd,
               ${costStatusSelect},
               argMax(event_count, version) AS event_count
        FROM ${spec.table}
        WHERE ${spec.bucketColumn} >= {rollupFrom:DateTime64(3)}
          AND ${spec.bucketColumn} < {rollupTo:DateTime64(3)}
          ${filter.sql}
        GROUP BY ${spec.bucketColumn}, provider_key, user_id, team_id, session_id, model, host${v2Dimensions}
      )
      UNION ALL
      SELECT ts, provider_key, user_id, team_id, session_id, model, host,
             input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd,
             cost_status, 1 AS event_count
      FROM ${this.usageEventsSource}
      WHERE ts >= {rollupTo:DateTime64(3)}
        AND ts < {to:DateTime64(3)}
        ${filter.sql}
    )`;
    return { source, params, resolution: "15m", from: window.rollupFrom, to: window.rollupTo };
  }

  private async rollup15mV2Source(q: ScopedQuery): Promise<RollupSource | null> {
    if (!(await this.readLayerEnabled("usage_15m_v2", this.read15mV2Rollup))) return null;
    return this.rollupSource(q, USAGE_15M_V2);
  }

  private async rollup15mTimeseriesSource(q: ScopedQuery): Promise<RollupSource | null> {
    const v2 = await this.rollup15mV2Source(q);
    if (v2) return v2;
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
                     input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd,
                     cost_status, event_count`;
    return {
      source: `(
        SELECT 'previous' AS period, ${columns}
        FROM ${previous.source} ${previous.where}
        UNION ALL
        SELECT 'current' AS period, ${columns}
        FROM ${current.source} ${current.where}
      )`,
      params: {
        ...previous.params,
        ...current.params,
        previous_from: chTs(q.previous.from),
        current_from: chTs(q.current.from),
      },
    };
  }

  private async ensureClickHouseSchema(): Promise<void> {
    for (const query of CLICKHOUSE_SCHEMA_DDL) {
      await this.runSchemaCommand(query);
    }
    if (this.enforceRetentionTtl) {
      await this.runSchemaCommand(CLICKHOUSE_RAW_RETENTION_DDL);
    }
  }

  private async runSchemaCommand(query: string): Promise<void> {
    await this.operationRunner.run(
      "ensure_schema",
      () => this.ch.command({ query }),
      { retryTransient: true },
    );
  }

  private ensureSchema(): Promise<void> {
    this.schemaReady ??= this.ensureClickHouseSchema().catch((err) => {
      this.schemaReady = undefined;
      throw err;
    });
    return this.schemaReady;
  }

  private async queryJson<T>(
    query: string,
    query_params: Params,
    clickhouse_settings?: ClickHouseSettings,
    operation = "clickhouse_query",
  ): Promise<T[]> {
    await this.ensureSchema();
    return this.operationRunner.run(operation, () => this.ch.query({
        query,
        query_params,
        clickhouse_settings,
        format: "JSONEachRow",
      }).then((rs) => rs.json<T>()), { retryTransient: true });
  }

  // ── 쓰기 ──
  private rawSeq = 0;

  async saveRawEvent(providerKey: string, payload: unknown): Promise<number> {
    await this.ensureSchema();
    // ms 내 단조 증가 시퀀스로 충돌 완화(난수보다 안정적; raw id 하류 의존 없음)
    const id = Date.now() * 1000 + (this.rawSeq++ % 1000);
    await this.operationRunner.run("save_raw_event", () => this.ch.insert({
      table: "raw_events",
      values: [{ id, provider_key: providerKey, payload: JSON.stringify(payload) }],
      format: "JSONEachRow",
    }));
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

  async previewUnassignedTeamAttribution(
    input: TeamAttributionRange,
  ): Promise<TeamAttributionPreview> {
    type PreviewRow = {
      events: string | number;
      from_ts: Date | string | null;
      to_ts: Date | string | null;
      total_tokens: string | number;
      cost_usd: string | number;
      dedup_keys?: string[] | null;
      raw_from?: Date | string | null;
    };
    const pendingResult = await this.pg.query<PreviewRow>(
      `SELECT COUNT(*) AS events,
              MIN(ts) AS from_ts,
              MAX(ts) AS to_ts,
              COALESCE(SUM(
                input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens
              ), 0) AS total_tokens,
              COALESCE(SUM(cost_usd) FILTER (WHERE cost_status <> 'unpriced'), 0) AS cost_usd,
              COALESCE(ARRAY_AGG(dedup_key) FILTER (WHERE dedup_key IS NOT NULL), '{}') AS dedup_keys
         FROM clickhouse_usage_outbox
        WHERE user_id = $1
          AND team_id IS NULL
          AND delivered_at IS NULL
          AND ($2::timestamptz IS NULL OR ts >= $2)
          AND ($3::timestamptz IS NULL OR ts < $3)`,
      [input.userId, input.from, input.to],
    );
    const pending = pendingResult.rows[0]!;
    const pendingKeys = pending.dedup_keys ?? [];
    const rawFullFrom = await this.clickHouseRawFullFrom();
    const rawRows = await this.queryJson<PreviewRow>(
      `SELECT count() AS events,
              if(count() = 0, NULL, min(ts)) AS from_ts,
              if(count() = 0, NULL, max(ts)) AS to_ts,
              coalesce(sum(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens), 0) AS total_tokens,
              coalesce(sumIf(cost_usd, cost_status != 'unpriced'), 0) AS cost_usd
         FROM usage_events FINAL
        WHERE user_id = {user_id:String}
          AND team_id = ''
          AND ts >= {raw_full_from:DateTime64(3)}
          AND ({from_nullable:UInt8} = 1 OR ts >= {from:DateTime64(3)})
          AND ({to_nullable:UInt8} = 1 OR ts < {to:DateTime64(3)})
          AND dedup_key NOT IN {pending_keys:Array(String)}`,
      {
        user_id: input.userId,
        raw_full_from: chTs(rawFullFrom),
        from_nullable: input.from ? 0 : 1,
        from: chTs(input.from ?? new Date(0)),
        to_nullable: input.to ? 0 : 1,
        to: chTs(input.to ?? new Date("2100-01-01T00:00:00.000Z")),
        pending_keys: pendingKeys,
      },
    );
    const raw = rawRows[0] ?? {
      events: 0,
      from_ts: null,
      to_ts: null,
      total_tokens: 0,
      cost_usd: 0,
      raw_from: null,
    };
    const rollupRows = await this.queryJson<PreviewRow>(
      `SELECT coalesce(sum(event_count), 0) AS events,
              if(sum(event_count) = 0, NULL, min(bucket_15m)) AS from_ts,
              if(sum(event_count) = 0, NULL, max(bucket_15m)) AS to_ts,
              coalesce(sum(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens), 0) AS total_tokens,
              coalesce(sum(cost_usd), 0) AS cost_usd
         FROM usage_15m_rollup_v2 FINAL
        WHERE user_id = {user_id:String}
          AND team_id = ''
          AND bucket_15m < {raw_full_from:DateTime64(3)}
          AND ({from_nullable:UInt8} = 1 OR bucket_15m >= {from:DateTime64(3)})
          AND ({to_nullable:UInt8} = 1 OR bucket_15m < {to:DateTime64(3)})`,
      {
        user_id: input.userId,
        raw_full_from: chTs(rawFullFrom),
        from_nullable: input.from ? 0 : 1,
        from: chTs(input.from ?? new Date(0)),
        to_nullable: input.to ? 0 : 1,
        to: chTs(input.to ?? new Date("2100-01-01T00:00:00.000Z")),
      },
    );
    const rollup = rollupRows[0] ?? {
      events: 0,
      from_ts: null,
      to_ts: null,
      total_tokens: 0,
      cost_usd: 0,
    };
    const parts = [pending, raw, rollup];
    const fromValues = parts.flatMap((part) => {
      const value = this.optionalClickHouseDate(part.from_ts);
      return value ? [value] : [];
    });
    const toValues = parts.flatMap((part) => {
      const value = this.optionalClickHouseDate(part.to_ts);
      return value ? [value] : [];
    });
    return {
      events: parts.reduce((sum, part) => sum + n(part.events), 0),
      from: fromValues.length > 0
        ? new Date(Math.min(...fromValues.map((value) => value.getTime())))
        : null,
      to: toValues.length > 0
        ? new Date(Math.max(...toValues.map((value) => value.getTime())))
        : null,
      totalTokens: parts.reduce((sum, part) => sum + n(part.total_tokens), 0),
      costUsd: parts.reduce((sum, part) => sum + n(part.cost_usd), 0),
    };
  }

  async backfillUnassignedTeamAttribution(
    input: TeamAttributionBatchRequest,
  ): Promise<TeamAttributionBatchResult> {
    if (input.limit <= 0) {
      return { processed: 0, updated: 0, affectedBuckets: [], hasMore: false };
    }
    const limit = Math.min(Math.max(Math.trunc(input.limit), 1), 1_000);
    const pending = await this.backfillPendingOutbox(input, limit);
    const affectedRows: Array<{ ts: Date | string }> = pending.affectedTs.map((ts) => ({ ts }));
    let processed = pending.processed;
    let updated = pending.updated;
    let remaining = Math.max(0, limit - processed);
    if (pending.hasMore || remaining === 0) {
      return {
        processed,
        updated,
        affectedBuckets: this.dirty15mBuckets(affectedRows),
        hasMore: true,
      };
    }

    const rawFullFrom = await this.clickHouseRawFullFrom();
    const rawRows = await this.queryJson<OutboxRow>(
      `SELECT dedup_key, provider_key, user_id, team_id, session_id, model, ts,
              input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
              cost_usd, pricing_revision_id, cost_status, log_adapter, host
         FROM usage_events FINAL
        WHERE user_id = {user_id:String}
          AND team_id = ''
          AND ts >= {raw_full_from:DateTime64(3)}
          AND ({from_nullable:UInt8} = 1 OR ts >= {from:DateTime64(3)})
          AND ({to_nullable:UInt8} = 1 OR ts < {to:DateTime64(3)})
        ORDER BY ts, dedup_key
        LIMIT {row_limit:UInt32}`,
      {
        user_id: input.userId,
        raw_full_from: chTs(rawFullFrom),
        from_nullable: input.from ? 0 : 1,
        from: chTs(input.from ?? new Date(0)),
        to_nullable: input.to ? 0 : 1,
        to: chTs(input.to ?? new Date("2100-01-01T00:00:00.000Z")),
        row_limit: remaining + 1,
      },
    );
    const rawCandidates = rawRows.slice(0, remaining);
    const rawHasMore = rawRows.length > rawCandidates.length;
    if (rawCandidates.length > 0) {
      const replacements = rawCandidates.map((row) => ({
        ...row,
        team_id: input.teamId,
        ts: row.ts instanceof Date ? row.ts : chDate(String(row.ts)),
      }));
      await this.markAttributionRowsDirty(replacements);
      const digest = createHash("sha256")
        .update(replacements.map((row) => row.dedup_key).sort().join("\n"))
        .digest("hex");
      await this.operationRunner.run("backfill_team_attribution_raw", () => this.ch.insert({
        table: "usage_events",
        values: replacements.map((row) => this.clickHouseUsageRow(row)),
        format: "JSONEachRow",
        clickhouse_settings: {
          insert_deduplication_token: `team-attribution:${input.jobId}:raw:${digest}`,
        },
      }));
      affectedRows.push(...replacements);
      processed += rawCandidates.length;
      updated += replacements.length;
      remaining -= rawCandidates.length;
    }
    if (rawHasMore || remaining === 0) {
      return {
        processed,
        updated,
        affectedBuckets: this.dirty15mBuckets(affectedRows),
        hasMore: true,
      };
    }

    const rollup = await this.backfillRollupOnly(input, Math.max(1, remaining), rawFullFrom);
    return {
      processed: processed + rollup.processed,
      updated: updated + rollup.updated,
      affectedBuckets: this.mergeBuckets(
        this.dirty15mBuckets(affectedRows),
        rollup.affectedBuckets,
      ),
      hasMore: rollup.hasMore,
    };
  }

  private optionalClickHouseDate(value: Date | string | null | undefined): Date | null {
    if (value instanceof Date) return value;
    if (typeof value !== "string" || value === "") return null;
    return chDate(value);
  }

  private async clickHouseRawFullFrom(): Promise<Date> {
    const rows = await this.queryJson<{ raw_from: Date | string | null }>(
      `SELECT if(count() = 0, NULL, min(ts)) AS raw_from
         FROM usage_events FINAL`,
      {},
    );
    const rawFrom = this.optionalClickHouseDate(rows[0]?.raw_from);
    return rawFrom
      ? new Date(Math.ceil(rawFrom.getTime() / FIFTEEN_MINUTES_MS) * FIFTEEN_MINUTES_MS)
      : new Date("2100-01-01T00:00:00.000Z");
  }

  private clickHouseUsageRow(row: OutboxRow): Record<string, unknown> {
    return {
      dedup_key: row.dedup_key,
      provider_key: row.provider_key,
      user_id: row.user_id ?? "",
      team_id: row.team_id ?? "",
      session_id: row.session_id ?? "",
      model: row.model ?? "",
      ts: chTs(new Date(row.ts)),
      input_tokens: n(row.input_tokens),
      output_tokens: n(row.output_tokens),
      cache_read_tokens: n(row.cache_read_tokens),
      cache_creation_tokens: n(row.cache_creation_tokens),
      cost_usd: row.cost_usd,
      pricing_revision_id: row.pricing_revision_id ?? "",
      cost_status: row.cost_status,
      log_adapter: row.log_adapter ?? "",
      host: row.host ?? "",
    };
  }

  private mergeBuckets(...groups: Date[][]): Date[] {
    const values = new Map<number, Date>();
    for (const bucket of groups.flat()) values.set(bucket.getTime(), bucket);
    return [...values.values()].sort((a, b) => a.getTime() - b.getTime());
  }

  private async markAttributionRowsDirty(rows: ReadonlyArray<{ ts: Date | string }>): Promise<void> {
    if (rows.length === 0) return;
    const client = await this.pg.connect();
    try {
      await client.query("BEGIN");
      await this.mark15mRollupDirty(client, rows);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async backfillPendingOutbox(
    input: TeamAttributionBatchRequest,
    limit: number,
  ): Promise<{ processed: number; updated: number; affectedTs: Date[]; hasMore: boolean }> {
    const client = await this.pg.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{
        processed: string | number;
        updated: string | number;
        affected_ts: Date[] | null;
        has_more: boolean;
      }>(
        `WITH candidate_probe AS (
           SELECT dedup_key
             FROM clickhouse_usage_outbox
            WHERE user_id = $1
              AND team_id IS NULL
              AND delivered_at IS NULL
              AND ($3::timestamptz IS NULL OR ts >= $3)
              AND ($4::timestamptz IS NULL OR ts < $4)
            ORDER BY created_at, dedup_key
            LIMIT ($5 + 1)
            FOR UPDATE SKIP LOCKED
         ), candidates AS (
           SELECT dedup_key FROM candidate_probe ORDER BY dedup_key LIMIT $5
         ), updated AS (
           UPDATE clickhouse_usage_outbox AS outbox
              SET team_id = $2
             FROM candidates
            WHERE outbox.dedup_key = candidates.dedup_key
              AND outbox.team_id IS NULL
              AND outbox.delivered_at IS NULL
           RETURNING outbox.ts
         )
         SELECT (SELECT COUNT(*) FROM candidates) AS processed,
                (SELECT COUNT(*) FROM updated) AS updated,
                (SELECT ARRAY_AGG(ts) FROM updated) AS affected_ts,
                (SELECT COUNT(*) > $5 FROM candidate_probe) AS has_more`,
        [input.userId, input.teamId, input.from, input.to, limit],
      );
      await client.query("COMMIT");
      const row = result.rows[0] ?? {
        processed: 0,
        updated: 0,
        affected_ts: [],
        has_more: false,
      };
      return {
        processed: n(row.processed),
        updated: n(row.updated),
        affectedTs: row.affected_ts ?? [],
        hasMore: row.has_more,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async backfillRollupOnly(
    input: TeamAttributionBatchRequest,
    limit: number,
    rawFullFrom: Date,
  ): Promise<TeamAttributionBatchResult> {
    const stagedBuckets = await this.queryJson<{ bucket_start: Date | string }>(
      `SELECT DISTINCT bucket_start
         FROM team_attribution_rollup_staging FINAL
        WHERE job_id = {job_id:String}
          AND layer = 'usage_15m_rollup_v2'
        ORDER BY bucket_start`,
      { job_id: input.jobId },
    );
    let buckets = stagedBuckets.map((row) =>
      row.bucket_start instanceof Date ? row.bucket_start : chDate(row.bucket_start)
    );
    if (buckets.length === 0) {
      const selected = await this.queryJson<{ bucket_start: Date | string }>(
        `SELECT DISTINCT bucket_15m AS bucket_start
           FROM usage_15m_rollup_v2 FINAL
          WHERE user_id = {user_id:String}
            AND team_id = ''
            AND bucket_15m < {raw_full_from:DateTime64(3)}
            AND ({from_nullable:UInt8} = 1 OR bucket_15m >= {from:DateTime64(3)})
            AND ({to_nullable:UInt8} = 1 OR bucket_15m < {to:DateTime64(3)})
          ORDER BY bucket_15m
          LIMIT {bucket_limit:UInt32}`,
        {
          user_id: input.userId,
          raw_full_from: chTs(rawFullFrom),
          from_nullable: input.from ? 0 : 1,
          from: chTs(input.from ?? new Date(0)),
          to_nullable: input.to ? 0 : 1,
          to: chTs(input.to ?? new Date("2100-01-01T00:00:00.000Z")),
          bucket_limit: Math.min(Math.max(limit, 1), 16),
        },
      );
      buckets = selected.map((row) =>
        row.bucket_start instanceof Date ? row.bucket_start : chDate(row.bucket_start)
      );
    }
    buckets = this.mergeBuckets(buckets);
    if (buckets.length === 0) {
      return { processed: 0, updated: 0, affectedBuckets: [], hasMore: false };
    }

    const bucketParams = buckets.map(chTs);
    const stageVersion = Date.now();
    const stageCommands = [
      `INSERT INTO team_attribution_rollup_staging
         (job_id, layer, bucket_start, provider_key, user_id, session_id, model, host,
          pricing_revision_id, cost_status, event_count, input_tokens, output_tokens,
          cache_read_tokens, cache_creation_tokens, cost_usd, version)
       SELECT {job_id:String}, 'usage_15m_rollup_v2', bucket_15m, provider_key, user_id,
              session_id, model, host, pricing_revision_id, cost_status, event_count,
              input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
              cost_usd, greatest(version, {stage_version:UInt64})
         FROM usage_15m_rollup_v2 FINAL
        WHERE user_id = {user_id:String}
          AND team_id = ''
          AND bucket_15m IN {buckets:Array(DateTime64(3))}`,
      `INSERT INTO team_attribution_rollup_staging
         (job_id, layer, bucket_start, provider_key, user_id, session_id, model, host,
          pricing_revision_id, cost_status, event_count, input_tokens, output_tokens,
          cache_read_tokens, cache_creation_tokens, cost_usd, version)
       SELECT {job_id:String}, 'usage_15m_rollup', bucket_15m, provider_key, user_id,
              session_id, model, host, '', 'legacy', event_count, input_tokens, output_tokens,
              cache_read_tokens, cache_creation_tokens, cost_usd,
              greatest(version, {stage_version:UInt64})
         FROM usage_15m_rollup FINAL
        WHERE user_id = {user_id:String}
          AND team_id = ''
          AND bucket_15m IN {buckets:Array(DateTime64(3))}`,
    ];
    for (const query of stageCommands) {
      await this.operationRunner.run("stage_team_attribution_rollup", () => this.ch.command({
        query,
        query_params: {
          job_id: input.jobId,
          user_id: input.userId,
          buckets: bucketParams,
          stage_version: stageVersion,
        },
      }));
    }

    const fenceFrom = new Date(Math.floor(buckets[0]!.getTime() / 3_600_000) * 3_600_000);
    const fenceTo = new Date(
      Math.floor(buckets.at(-1)!.getTime() / 3_600_000) * 3_600_000 + 3_600_000,
    );
    const fenceClient = await this.pg.connect();
    try {
      await fenceClient.query("BEGIN");
      await fenceClient.query(
        `INSERT INTO team_attribution_read_fences (job_id, from_ts, to_ts)
         VALUES ($1, $2, $3)
         ON CONFLICT (job_id) DO UPDATE
           SET from_ts = LEAST(team_attribution_read_fences.from_ts, EXCLUDED.from_ts),
               to_ts = GREATEST(team_attribution_read_fences.to_ts, EXCLUDED.to_ts),
               created_at = now()`,
        [input.jobId, fenceFrom, fenceTo],
      );
      await fenceClient.query("COMMIT");
    } catch (error) {
      await fenceClient.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      fenceClient.release();
    }

    const mutationSettings = { mutations_sync: "1", max_threads: 2 } as const;
    await this.operationRunner.run("delete_team_attribution_v2_rollup", () => this.ch.command({
      query: `ALTER TABLE usage_15m_rollup_v2
              DELETE WHERE user_id = {user_id:String}
                AND team_id = ''
                AND bucket_15m IN {buckets:Array(DateTime64(3))}`,
      query_params: { user_id: input.userId, buckets: bucketParams },
      clickhouse_settings: mutationSettings,
    }));
    await this.operationRunner.run("delete_team_attribution_legacy_rollup", () => this.ch.command({
      query: `ALTER TABLE usage_15m_rollup
              DELETE WHERE user_id = {user_id:String}
                AND team_id = ''
                AND bucket_15m IN {buckets:Array(DateTime64(3))}`,
      query_params: { user_id: input.userId, buckets: bucketParams },
      clickhouse_settings: mutationSettings,
    }));
    const replacementVersion = Date.now() + 1;
    await this.operationRunner.run("insert_team_attribution_v2_rollup", () => this.ch.command({
      query: `INSERT INTO usage_15m_rollup_v2
                (bucket_15m, provider_key, user_id, team_id, session_id, model, host,
                 pricing_revision_id, cost_status, event_count, input_tokens, output_tokens,
                 cache_read_tokens, cache_creation_tokens, cost_usd, version)
              SELECT bucket_start, provider_key, user_id, {team_id:String}, session_id, model,
                     host, pricing_revision_id, cost_status, event_count, input_tokens,
                     output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd,
                     greatest(version + 1, {replacement_version:UInt64})
                FROM team_attribution_rollup_staging FINAL
               WHERE job_id = {job_id:String}
                 AND layer = 'usage_15m_rollup_v2'`,
      query_params: {
        job_id: input.jobId,
        team_id: input.teamId,
        replacement_version: replacementVersion,
      },
    }));
    await this.operationRunner.run("insert_team_attribution_legacy_rollup", () => this.ch.command({
      query: `INSERT INTO usage_15m_rollup
                (bucket_15m, provider_key, user_id, team_id, session_id, model, host,
                 event_count, input_tokens, output_tokens, cache_read_tokens,
                 cache_creation_tokens, cost_usd, version)
              SELECT bucket_start, provider_key, user_id, {team_id:String}, session_id, model,
                     host, event_count, input_tokens, output_tokens, cache_read_tokens,
                     cache_creation_tokens, cost_usd,
                     greatest(version + 1, {replacement_version:UInt64})
                FROM team_attribution_rollup_staging FINAL
               WHERE job_id = {job_id:String}
                 AND layer = 'usage_15m_rollup'`,
      query_params: {
        job_id: input.jobId,
        team_id: input.teamId,
        replacement_version: replacementVersion,
      },
    }));
    const verificationRows = await this.queryJson<{
      remaining_old: string | number;
      staged_rows: string | number;
      replacement_rows: string | number;
    }>(
      `SELECT 'team-attribution-rollup-verification' AS marker,
              (SELECT count()
                 FROM usage_15m_rollup_v2 FINAL
                WHERE user_id = {user_id:String}
                  AND team_id = ''
                  AND bucket_15m IN {buckets:Array(DateTime64(3))}) AS remaining_old,
              (SELECT coalesce(sum(event_count), 0)
                 FROM team_attribution_rollup_staging FINAL
                WHERE job_id = {job_id:String}
                  AND layer = 'usage_15m_rollup_v2') AS staged_rows,
              (SELECT coalesce(sum(event_count), 0)
                 FROM usage_15m_rollup_v2 FINAL
                WHERE user_id = {user_id:String}
                  AND team_id = {team_id:String}
                  AND bucket_15m IN {buckets:Array(DateTime64(3))}) AS replacement_rows`,
      {
        user_id: input.userId,
        team_id: input.teamId,
        job_id: input.jobId,
        buckets: bucketParams,
      },
    );
    const verification = verificationRows[0];
    if (
      !verification
      || n(verification.remaining_old) !== 0
      || n(verification.replacement_rows) < n(verification.staged_rows)
    ) {
      throw new Error("team attribution rollup verification failed");
    }

    const completionClient = await this.pg.connect();
    try {
      await completionClient.query("BEGIN");
      await this.invalidateTimezoneRollupJobs(completionClient, buckets);
      await completionClient.query("SELECT complete_team_attribution_fence($1::uuid)", [input.jobId]);
      await completionClient.query("COMMIT");
    } catch (error) {
      await completionClient.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      completionClient.release();
    }

    try {
      await this.operationRunner.run("cleanup_team_attribution_staging", () => this.ch.command({
        query: `ALTER TABLE team_attribution_rollup_staging
                DELETE WHERE job_id = {job_id:String}`,
        query_params: { job_id: input.jobId },
        clickhouse_settings: mutationSettings,
      }));
    } catch {
      // Fence가 해제된 뒤의 TTL staging 정리는 best-effort다. 교체 결과는 이미 검증됐다.
    }
    const stagedEvents = n(verification.staged_rows);
    return {
      processed: stagedEvents,
      updated: stagedEvents,
      affectedBuckets: buckets,
      hasMore: true,
    };
  }

  async getPricingRecoveryModels(
    from: Date,
    to: Date,
    replaceRevisionIds: string[] = [],
  ): Promise<PricingRecoveryModelDiagnostic[]> {
    const rows = await this.queryJson<{
      provider_key: string;
      log_adapter: string;
      model: string | null;
      events: string | number;
      unpriced_events: string | number;
      legacy_events: string | number;
      first_at: string | Date;
      last_at: string | Date;
    }>(
      `SELECT provider_key,
              nullIf(log_adapter, '') AS log_adapter,
              nullIf(model, '') AS model,
              count() AS events,
              countIf(cost_status = 'unpriced') AS unpriced_events,
              countIf(cost_status = 'legacy') AS legacy_events,
              min(ts) AS first_at,
              max(ts) AS last_at
       FROM usage_events FINAL
       WHERE ts >= {from:DateTime64(3)}
         AND ts < {to:DateTime64(3)}
         AND (
           cost_status IN ('unpriced', 'legacy')
           OR pricing_revision_id IN {replace_revision_ids:Array(String)}
         )
       GROUP BY provider_key, log_adapter, model
       ORDER BY events DESC, model`,
      { from: chTs(from), to: chTs(to), replace_revision_ids: replaceRevisionIds },
    );
    return rows.map((row) => ({
      providerKey: row.provider_key,
      logAdapter: row.log_adapter || null,
      model: row.model || null,
      events: n(row.events),
      unpricedEvents: n(row.unpriced_events),
      legacyEvents: n(row.legacy_events),
      firstAt: row.first_at instanceof Date ? row.first_at : chDate(row.first_at),
      lastAt: row.last_at instanceof Date ? row.last_at : chDate(row.last_at),
    }));
  }

  async reconcileCodexReplayUsage(
    request: UsageReplayReconciliationRequest,
  ): Promise<UsageReplayReconciliationResult> {
    if (request.limit <= 0) {
      return { scanned: 0, reconciled: 0, remainingUnpriced: 0, affectedBuckets: [], hasMore: false };
    }
    const limit = Math.min(Math.max(Math.trunc(request.limit), 1), 1_000);
    const rows = await this.queryJson<{
      dedup_key: string;
      ts: string | Date;
      total_unpriced: string | number;
    }>(
      `SELECT bad.dedup_key, bad.ts,
              (SELECT count()
               FROM usage_events FINAL
               WHERE ts >= {from:DateTime64(3)}
                 AND ts < {to:DateTime64(3)}
                 AND cost_status = 'unpriced') AS total_unpriced
       FROM usage_events AS bad FINAL
       WHERE bad.ts >= {from:DateTime64(3)}
         AND bad.ts < {to:DateTime64(3)}
         AND bad.provider_key = 'codex'
         AND bad.model = ''
         AND bad.cost_status = 'unpriced'
         AND bad.session_id != ''
         AND bad.log_adapter = 'codex'
         AND tuple(
           bad.session_id, bad.user_id, bad.host, bad.log_adapter,
           bad.input_tokens, bad.output_tokens, bad.cache_read_tokens, bad.cache_creation_tokens
         ) IN (
           SELECT tuple(
             session_id, user_id, host, log_adapter,
             input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens
           )
           FROM usage_events FINAL
           WHERE provider_key = 'codex'
             AND model != ''
             AND session_id != ''
           GROUP BY session_id, user_id, host, log_adapter,
                    input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens
         )
       ORDER BY bad.ts, bad.dedup_key
       LIMIT {row_limit:UInt32}`,
      {
        from: chTs(request.from),
        to: chTs(request.to),
        row_limit: limit + 1,
      },
    );
    const candidates = rows.slice(0, limit).map((row) => ({
      dedup_key: row.dedup_key,
      ts: row.ts instanceof Date ? row.ts : chDate(row.ts),
    }));
    if (candidates.length === 0) {
      return { scanned: 0, reconciled: 0, remainingUnpriced: 0, affectedBuckets: [], hasMore: false };
    }

    const markDirty = async (): Promise<void> => {
      const client = await this.pg.connect();
      try {
        await client.query("BEGIN");
        await this.mark15mRollupDirty(client, candidates);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    };

    // 삭제 전 raw fallback을 활성화하고, 삭제 후 다시 표시해 compactor 경합에도 stale cache가 남지 않게 한다.
    await markDirty();
    await this.operationRunner.run("reconcile_codex_replay_usage", () => this.ch.command({
      query: `ALTER TABLE usage_events
              DELETE WHERE dedup_key IN {dedup_keys:Array(String)}`,
      query_params: { dedup_keys: candidates.map((row) => row.dedup_key) },
      clickhouse_settings: { mutations_sync: "1", max_threads: 2 },
    }));
    await markDirty();

    return {
      scanned: candidates.length,
      reconciled: candidates.length,
      remainingUnpriced: Math.max(0, n(rows[0]?.total_unpriced) - candidates.length),
      affectedBuckets: this.dirty15mBuckets(candidates),
      hasMore: rows.length > limit,
    };
  }

  async reconcileUsageEvents(
    request: UsageEventReconciliationRequest,
  ): Promise<UsageEventReconciliationResult> {
    const dedupKeys = [...new Set(request.dedupKeys)].slice(0, 1_000);
    if (dedupKeys.length === 0) {
      return { reconciled: 0, affectedBuckets: [] };
    }
    const outboxClient = await this.pg.connect();
    let outboxRows: Array<{ dedup_key: string; ts: Date }> = [];
    try {
      await outboxClient.query("BEGIN");
      const selectedOutbox = await outboxClient.query<{ dedup_key: string; ts: Date }>(
        `SELECT dedup_key, ts
         FROM clickhouse_usage_outbox
         WHERE user_id = $1
           AND provider_key = $2
           AND log_adapter = $3
           AND dedup_key = ANY($4::text[])
         FOR UPDATE`,
        [request.userId, request.providerKey, request.logAdapter, dedupKeys],
      );
      outboxRows = selectedOutbox.rows;
      if (outboxRows.length > 0) {
        await outboxClient.query(
          `DELETE FROM clickhouse_usage_outbox
           WHERE user_id = $1
             AND provider_key = $2
             AND log_adapter = $3
             AND dedup_key = ANY($4::text[])`,
          [request.userId, request.providerKey, request.logAdapter, dedupKeys],
        );
      }
      await outboxClient.query("COMMIT");
    } catch (error) {
      await outboxClient.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      outboxClient.release();
    }
    const rows = await this.queryJson<{ dedup_key: string; ts: string | Date }>(
      `SELECT dedup_key, ts
       FROM usage_events FINAL
       WHERE user_id = {user_id:String}
         AND provider_key = {provider_key:String}
         AND log_adapter = {log_adapter:String}
         AND dedup_key IN {dedup_keys:Array(String)}`,
      {
        user_id: request.userId,
        provider_key: request.providerKey,
        log_adapter: request.logAdapter,
        dedup_keys: dedupKeys,
      },
    );
    const candidateByKey = new Map<string, { dedup_key: string; ts: Date }>();
    for (const row of outboxRows) {
      candidateByKey.set(row.dedup_key, { dedup_key: row.dedup_key, ts: row.ts });
    }
    for (const row of rows) {
      candidateByKey.set(row.dedup_key, {
        dedup_key: row.dedup_key,
        ts: row.ts instanceof Date ? row.ts : chDate(row.ts),
      });
    }
    const candidates = [...candidateByKey.values()];
    if (candidates.length === 0) {
      return { reconciled: 0, affectedBuckets: [] };
    }

    const markDirty = async (): Promise<void> => {
      const client = await this.pg.connect();
      try {
        await client.query("BEGIN");
        await this.mark15mRollupDirty(client, candidates);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    };

    await markDirty();
    await this.operationRunner.run("reconcile_usage_events", () => this.ch.command({
      query: `ALTER TABLE usage_events
              DELETE WHERE user_id = {user_id:String}
                AND provider_key = {provider_key:String}
                AND log_adapter = {log_adapter:String}
                AND dedup_key IN {dedup_keys:Array(String)}`,
      query_params: {
        user_id: request.userId,
        provider_key: request.providerKey,
        log_adapter: request.logAdapter,
        dedup_keys: candidates.map((row) => row.dedup_key),
      },
      clickhouse_settings: { mutations_sync: "1", max_threads: 2 },
    }));
    await markDirty();

    return {
      reconciled: candidates.length,
      affectedBuckets: this.dirty15mBuckets(candidates),
    };
  }

  async repairPricingUsage(
    request: PricingRepairRequest,
    resolver: PricingRepairResolver,
  ): Promise<PricingRecoveryBatchResult> {
    if ((request.models.length === 0 && !request.includeCodexModelFallback) || request.limit <= 0) {
      return { scanned: 0, recovered: 0, repricedLegacy: 0, affectedBuckets: [], hasMore: false };
    }
    const limit = Math.min(Math.max(Math.trunc(request.limit), 1), 1_000);
    const rows = await this.queryJson<PricingRepairClickHouseRow>(
      `SELECT dedup_key, provider_key, user_id, team_id, session_id, model, ts,
              input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
              cost_usd, pricing_revision_id, cost_status, log_adapter, host
       FROM usage_events FINAL
       WHERE ts >= {from:DateTime64(3)}
         AND ts < {to:DateTime64(3)}
         AND (
           cost_status IN ('unpriced', 'legacy')
           OR pricing_revision_id IN {replace_revision_ids:Array(String)}
         )
         AND (
           model IN {models:Array(String)}
           OR (
             {include_codex_model_fallback:UInt8} = 1
             AND provider_key = 'codex'
             AND log_adapter = 'codex'
             AND model = ''
           )
         )
       ORDER BY ts, dedup_key
       LIMIT {row_limit:UInt32}`,
      {
        from: chTs(request.from),
        to: chTs(request.to),
        models: request.models,
        include_codex_model_fallback: request.includeCodexModelFallback ? 1 : 0,
        replace_revision_ids: request.replaceRevisionIds,
        row_limit: limit + 1,
      },
    );
    const candidates = rows.slice(0, limit);
    const replacements: OutboxRow[] = [];
    for (const row of candidates) {
      const ts = row.ts instanceof Date ? row.ts : chDate(String(row.ts));
      const resolved = resolver({
        dedupKey: row.dedup_key,
        providerKey: row.provider_key,
        userId: row.user_id || null,
        sessionId: row.session_id || null,
        model: row.model || null,
        ts,
        inputTokens: n(row.input_tokens),
        outputTokens: n(row.output_tokens),
        cacheReadTokens: n(row.cache_read_tokens),
        cacheCreationTokens: n(row.cache_creation_tokens),
        costUsd: n(row.cost_usd),
        logAdapter: row.log_adapter || null,
        host: row.host || null,
      });
      if (!resolved) continue;
      replacements.push({
        ...row,
        ts,
        cost_usd: String(resolved.costUsd),
        pricing_revision_id: resolved.pricingRevisionId,
        cost_status: "priced",
      });
    }

    if (replacements.length > 0) {
      const client = await this.pg.connect();
      try {
        await client.query("BEGIN");
        await this.mark15mRollupDirty(client, replacements);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }

      const sortedKeys = replacements.map((row) => row.dedup_key).sort().join("\n");
      const digest = createHash("sha256")
        .update(`${request.generation}:${sortedKeys}`)
        .digest("hex");
      await this.operationRunner.run("repair_pricing_usage", () => this.ch.insert({
        table: "usage_events",
        values: replacements.map((row) => ({
          dedup_key: row.dedup_key,
          provider_key: row.provider_key,
          user_id: row.user_id ?? "",
          team_id: row.team_id ?? "",
          session_id: row.session_id ?? "",
          model: row.model ?? "",
          ts: chTs(new Date(row.ts)),
          input_tokens: n(row.input_tokens),
          output_tokens: n(row.output_tokens),
          cache_read_tokens: n(row.cache_read_tokens),
          cache_creation_tokens: n(row.cache_creation_tokens),
          cost_usd: row.cost_usd,
          pricing_revision_id: row.pricing_revision_id ?? "",
          cost_status: row.cost_status,
          log_adapter: row.log_adapter ?? "",
          host: row.host ?? "",
        })),
        format: "JSONEachRow",
        clickhouse_settings: {
          insert_deduplication_token: `pricing-repair:${digest}`,
        },
      }));
    }

    const originalStatus = new Map(candidates.map((candidate) => [candidate.dedup_key, candidate.cost_status]));
    const repricedLegacy = replacements.filter(
      (replacement) => originalStatus.get(replacement.dedup_key) === "legacy",
    ).length;
    const recovered = replacements.filter(
      (replacement) => originalStatus.get(replacement.dedup_key) === "unpriced",
    ).length;
    return {
      scanned: candidates.length,
      recovered,
      repricedLegacy,
      affectedBuckets: this.dirty15mBuckets(replacements),
      hasMore: rows.length > limit,
    };
  }

  private async enqueueUsageEvents(events: FinalizedUsageEvent[]): Promise<EnqueueResult> {
    const client = await this.pg.connect();
    try {
      await client.query("BEGIN");
      const teamByEvent = await this.teamMapAtEventTime(client, events);
      const batch = await client.query<{ id: string }>(
        `INSERT INTO clickhouse_usage_batches (insert_token)
         VALUES ($1)
         RETURNING id`,
        [`toard-usage-${globalThis.crypto.randomUUID()}`],
      );
      const batchId = batch.rows[0]!.id;
      let inserted = 0;
      for (const e of events) {
        const teamId = e.userId ? (teamByEvent.get(e.dedupKey) ?? null) : null;
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
          if (batchRows.rows.some((row) => row.cost_status === "unpriced")) {
            await client.query("SELECT enqueue_pricing_repair(clock_timestamp())");
          }
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
    await this.operationRunner.run("flush_usage_outbox_raw", () => this.ch.insert({
      table: "usage_events",
      values: rawRows,
      format: "JSONEachRow",
      clickhouse_settings: {
        insert_deduplication_token: `${batch.insertToken}:raw`,
      },
    }));

    const rollupRows = this.rollupRows(rows);
    await this.operationRunner.run("flush_usage_outbox_rollup", () => this.ch.insert({
      table: "usage_hourly_rollup",
      values: rollupRows,
      format: "JSONEachRow",
      clickhouse_settings: {
        insert_deduplication_token: `${batch.insertToken}:rollup`,
      },
    }));
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

  private dirty15mBuckets(rows: ReadonlyArray<{ ts: Date | string }>): Date[] {
    const buckets = new Set(rows.map((r) => fifteenMinuteBucket(r.ts)));
    return [...buckets].map(chDate).sort((a, b) => a.getTime() - b.getTime());
  }

  private async mark15mRollupDirty(
    client: PoolClient,
    rows: ReadonlyArray<{ ts: Date | string }>,
  ): Promise<void> {
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
    if (current.rows[0]) {
      return spec.name === USAGE_15M_V2.name
        ? clampV2RollupStart(current.rows[0].watermark, eligibleTo)
        : current.rows[0].watermark;
    }

    const firstBucket = await this.firstRollupBucket(spec);
    const watermark = firstBucket
      ? spec.name === USAGE_15M_V2.name
        ? clampV2RollupStart(firstBucket, eligibleTo)
        : firstBucket
      : eligibleTo;
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
    const savedWatermark = saved.rows[0]?.watermark ?? watermark;
    return spec.name === USAGE_15M_V2.name
      ? clampV2RollupStart(savedWatermark, eligibleTo)
      : savedWatermark;
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

  private async deleteRollupBuckets(spec: RollupSpec, buckets: Date[]): Promise<void> {
    if (buckets.length === 0) return;
    await this.operationRunner.run("delete_rollup_buckets", () => this.ch.command({
      query: `ALTER TABLE ${spec.table}
              DELETE WHERE ${spec.bucketColumn} IN {buckets:Array(DateTime64(3))}`,
      query_params: { buckets: buckets.map(chTs) },
      clickhouse_settings: { mutations_sync: "1", max_threads: 2 },
    }));
  }

  private async invalidateTimezoneRollupJobs(client: PoolClient, buckets: Date[]): Promise<void> {
    if (buckets.length === 0) return;
    await client.query(
      `WITH affected(bucket) AS (
         SELECT unnest($1::timestamptz[])
       ), requested(resolution, timezone, bucket, source_to) AS (
         SELECT DISTINCT
           resolution,
           timezone,
           date_trunc(resolution, affected.bucket, timezone) AS bucket,
           CASE
             WHEN resolution = 'hour'
               THEN date_trunc(resolution, affected.bucket, timezone) + interval '1 hour'
             ELSE (
               ((date_trunc(resolution, affected.bucket, timezone) AT TIME ZONE timezone)::date + 1)::timestamp
               AT TIME ZONE timezone
             )
           END AS source_to
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
       INSERT INTO clickhouse_timezone_rollup_jobs (resolution, timezone, bucket, source_to)
       SELECT resolution, timezone, bucket, source_to
       FROM requested
       ON CONFLICT (resolution, timezone, bucket) DO UPDATE
       SET status = 'pending',
           source_to = EXCLUDED.source_to,
           generation = clickhouse_timezone_rollup_jobs.generation + 1,
           updated_at = now()`,
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
      const dirty = spec.name === USAGE_15M_V2.name
        ? await client.query<{ bucket: Date }>(
            `SELECT bucket
             FROM clickhouse_rollup_dirty_buckets
             WHERE name = $1 AND bucket >= $2 AND bucket < $3
             ORDER BY bucket
             LIMIT $4`,
            [
              spec.name,
              clampV2RollupStart(new Date(0), eligibleTo),
              eligibleTo,
              dirtyLimit,
            ],
          )
        : await client.query<{ bucket: Date }>(
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
      // dirty 재집계는 model/cost_status 차원이 바뀌거나 완전히 사라질 수 있다.
      // ReplacingMergeTree는 키가 바뀐 이전 행을 지우지 못하므로 해당 bucket을 먼저 비운다.
      await this.deleteRollupBuckets(spec, dirty.rows.map(({ bucket }) => bucket));
      if (rollupRows.length > 0) {
        await this.operationRunner.run("compact_usage_rollup", () => this.ch.insert({
          table: spec.table,
          values: rollupRows,
          format: "JSONEachRow",
        }));
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

    const table = resolution === "hour"
      ? "usage_hourly_timezone_rollup"
      : "usage_daily_timezone_rollup";
    // 재집계 결과가 0행이어도 이전 차원의 cache는 제거해야 한다.
    await this.operationRunner.run("compact_timezone_rollup_delete", () => this.ch.command({
      query: `ALTER TABLE ${table}
              DELETE WHERE timezone = {timezone:String}
                AND bucket_start = {bucket:DateTime64(3)}`,
      query_params: { timezone: tz, bucket: chTs(bucket) },
      clickhouse_settings: { mutations_sync: "1", max_threads: 2 },
    }));
    if (rows.length === 0) return 0;

    const version = Date.now();
    await this.operationRunner.run("compact_timezone_rollup_insert", () => this.ch.insert({
      table,
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
    }));
    return rows.length;
  }

  /** dedup_key → 이벤트 발생 시각에 유효한 team_id (멤버십 공백은 제외) */
  private async teamMapAtEventTime(
    client: PoolClient,
    events: FinalizedUsageEvent[],
  ): Promise<Map<string, string>> {
    const identified = events.filter(
      (event): event is FinalizedUsageEvent & { userId: string } => !!event.userId,
    );
    if (identified.length === 0) return new Map();

    const userIds = [...new Set(identified.map((event) => event.userId))].sort();
    for (const userId of userIds) {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 1540))", [userId]);
    }

    const rs = await client.query<{ dedup_key: string; team_id: string }>(
      `WITH requested(dedup_key, user_id, event_ts) AS (
         SELECT *
           FROM unnest($1::text[], $2::uuid[], $3::timestamptz[])
       )
       SELECT requested.dedup_key, assignment.team_id
         FROM user_team_assignments assignment
         JOIN requested
           ON requested.user_id = assignment.user_id
          AND assignment.effective_from <= requested.event_ts
          AND (assignment.effective_to IS NULL OR requested.event_ts < assignment.effective_to)`,
      [
        identified.map((event) => event.dedupKey),
        identified.map((event) => event.userId),
        identified.map((event) => event.ts),
      ],
    );
    const m = new Map<string, string>();
    for (const row of rs.rows) m.set(row.dedup_key, row.team_id);
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
              sumIf(cost_usd, cost_status != 'unpriced') AS cost,
              sum(input_tokens) AS input,
              sum(output_tokens) AS output,
              sum(cache_read_tokens)     AS cache_read,
              sum(cache_creation_tokens) AS cache_creation,
              sumIf(event_count, cost_status = 'priced') AS priced_events,
              sumIf(event_count, cost_status = 'unpriced') AS unpriced_events,
              sumIf(event_count, cost_status = 'legacy') AS legacy_events
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
      costCoverage: costCoverage(r),
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
              sumIf(cost_usd, cost_status != 'unpriced') AS cost,
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
    const rows = await this.queryJson<{ model: string; cost?: string; tokens?: string; sessions?: string } & CostCoverageRow>(
      `SELECT if(model = '', '(unknown)', model)               AS model,
              sumIf(cost_usd, cost_status != 'unpriced')        AS cost,
              sum(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens) AS tokens,
              uniqExactIf(session_id, session_id != '')         AS sessions,
              sumIf(event_count, cost_status = 'priced') AS priced_events,
              sumIf(event_count, cost_status = 'unpriced') AS unpriced_events,
              sumIf(event_count, cost_status = 'legacy') AS legacy_events
       FROM ${source.source}
       GROUP BY model ORDER BY cost DESC`,
      source.params,
    );
    return rows.map((r) => ({
      model: r.model,
      costUsd: n(r.cost),
      totalTokens: n(r.tokens),
      sessions: n(r.sessions),
      costCoverage: costCoverage(r),
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
              sumIf(cost_usd, cost_status != 'unpriced')        AS cost,
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
    const rows = await this.queryJson<{ host: string | null; cost?: string; tokens?: string; sessions?: string } & CostCoverageRow>(
      `SELECT nullIf(host, '')                                 AS host,
              sumIf(cost_usd, cost_status != 'unpriced')        AS cost,
              sum(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens) AS tokens,
              uniqExactIf(session_id, session_id != '')         AS sessions,
              sumIf(event_count, cost_status = 'priced') AS priced_events,
              sumIf(event_count, cost_status = 'unpriced') AS unpriced_events,
              sumIf(event_count, cost_status = 'legacy') AS legacy_events
       FROM ${source.source}
       GROUP BY host ORDER BY cost DESC`,
      source.params,
    );
    return rows.map((r) => ({
      host: r.host ?? null,
      costUsd: n(r.cost),
      totalTokens: n(r.tokens),
      sessions: n(r.sessions),
      costCoverage: costCoverage(r),
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
              sumIf(cost_usd, cost_status != 'unpriced') AS cost,
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

  private async utilizationUsageQuery(
    q: UtilizationUsageQuery,
    userId?: string,
  ): Promise<UtilizationUsageDay[]> {
    const scoped: ScopedQuery = userId ? { ...q, userId } : q;
    const timezone = safeTimezone(q.timezone, this.tz);
    const source = await this.resolveTimeseriesSource(scoped, "day", timezone);
    const dayExpr = this.sourceBucketExpr("day", source, timezone);
    const params = {
      ...source.params,
      cacheProviders: [...CACHE_SIGNAL_PROVIDER_KEYS],
    };
    const rows = await this.queryJson<{
      user_id: string;
      day: string;
      sessions?: string;
      input?: string;
      cache_read?: string;
      cache_creation?: string;
      cache_signal_events?: string;
      cache_unsupported_events?: string;
    }>(
      `SELECT user_id,
              ${dayExpr} AS day,
              uniqExactIf(session_id, session_id != '') AS sessions,
              sumIf(input_tokens, provider_key IN {cacheProviders:Array(String)}) AS input,
              sumIf(cache_read_tokens, provider_key IN {cacheProviders:Array(String)}) AS cache_read,
              sumIf(cache_creation_tokens, provider_key IN {cacheProviders:Array(String)}) AS cache_creation,
              sumIf(event_count, provider_key IN {cacheProviders:Array(String)}) AS cache_signal_events,
              sumIf(event_count, provider_key NOT IN {cacheProviders:Array(String)}) AS cache_unsupported_events
       FROM ${source.source}
       WHERE user_id != ''
       GROUP BY user_id, day
       ORDER BY day, user_id`,
      params,
    );
    return rows.map((row) => ({
      userId: row.user_id,
      day: row.day,
      sessions: n(row.sessions),
      inputTokens: n(row.input),
      cacheReadTokens: n(row.cache_read),
      cacheCreationTokens: n(row.cache_creation),
      cacheSignalEvents: n(row.cache_signal_events),
      cacheUnsupportedEvents: n(row.cache_unsupported_events),
    }));
  }

  getUserUtilizationUsage(userId: string, q: UtilizationUsageQuery): Promise<UtilizationUsageDay[]> {
    return this.utilizationUsageQuery(q, userId);
  }

  getOrganizationUtilizationUsage(q: UtilizationUsageQuery): Promise<UtilizationUsageDay[]> {
    return this.utilizationUsageQuery(q);
  }

  async getOrganizationDashboard(q: OrganizationDashboardQuery): Promise<OrganizationDashboardData> {
    const timezone = safeTimezone(q.current.timezone, this.tz);
    const [currentSourceRaw, previousSourceRaw] = await Promise.all([
      this.resolveTimeseriesSource(q.current, q.current.bucket, timezone),
      this.resolveTimeseriesSource(q.previous, undefined, this.tz),
    ]);
    const current = this.namespaceTimeseriesSource(currentSourceRaw, "dashboard_current");
    const previous = this.namespaceTimeseriesSource(previousSourceRaw, "dashboard_previous");
    const columns = `ts, provider_key, user_id, team_id, session_id, model, host,
                     input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
                     cost_usd, cost_status, event_count`;
    const tagged = `(
      SELECT 'previous' AS period, ${columns} FROM ${previous.source}
      UNION ALL
      SELECT 'current' AS period, ${columns} FROM ${current.source}
    )`;
    const params = { ...previous.params, ...current.params };
    const bucketExpr = this.bucketExpr(q.current.bucket, "ts", timezone);
    const orderColumn = q.leaderboardOrder === "tokens" ? "tokens" : "cost";

    const usageSql = `WITH '/* organization-dashboard-usage */' AS query_tag,
tagged AS ${tagged}
SELECT 'current_overview' AS result_kind, CAST(NULL AS Nullable(String)) AS day,
       uniqExactIf(session_id, session_id != '') AS sessions,
       uniqExactIf(user_id, user_id != '') AS active_users,
       sumIf(cost_usd, cost_status != 'unpriced') AS cost,
       sum(input_tokens) AS input, sum(output_tokens) AS output,
       sum(cache_read_tokens) AS cache_read, sum(cache_creation_tokens) AS cache_creation,
       sumIf(event_count, cost_status = 'priced') AS priced_events,
       sumIf(event_count, cost_status = 'unpriced') AS unpriced_events,
       sumIf(event_count, cost_status = 'legacy') AS legacy_events
FROM tagged WHERE period = 'current'
UNION ALL
SELECT 'previous_overview' AS result_kind, CAST(NULL AS Nullable(String)) AS day,
       uniqExactIf(session_id, session_id != '') AS sessions,
       uniqExactIf(user_id, user_id != '') AS active_users,
       sumIf(cost_usd, cost_status != 'unpriced') AS cost,
       sum(input_tokens) AS input, sum(output_tokens) AS output,
       sum(cache_read_tokens) AS cache_read, sum(cache_creation_tokens) AS cache_creation,
       sumIf(event_count, cost_status = 'priced') AS priced_events,
       sumIf(event_count, cost_status = 'unpriced') AS unpriced_events,
       sumIf(event_count, cost_status = 'legacy') AS legacy_events
FROM tagged WHERE period = 'previous'
UNION ALL
SELECT 'daily' AS result_kind, CAST(${bucketExpr} AS Nullable(String)) AS day,
       uniqExactIf(session_id, session_id != '') AS sessions,
       uniqExactIf(user_id, user_id != '') AS active_users,
       sumIf(cost_usd, cost_status != 'unpriced') AS cost,
       sum(input_tokens) AS input, sum(output_tokens) AS output,
       sum(cache_read_tokens) AS cache_read, sum(cache_creation_tokens) AS cache_creation,
       sumIf(event_count, cost_status = 'priced') AS priced_events,
       sumIf(event_count, cost_status = 'unpriced') AS unpriced_events,
       sumIf(event_count, cost_status = 'legacy') AS legacy_events
FROM tagged WHERE period = 'current'
GROUP BY day ORDER BY result_kind, day`;

    const teamBranch = q.includeTeamLeaderboard ? `
UNION ALL
SELECT 'team_leader' AS result_kind, key, cost, tokens, sessions,
       priced_events, unpriced_events, legacy_events
FROM (
  SELECT team_id AS key,
         sumIf(cost_usd, cost_status != 'unpriced') AS cost,
         sum(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens) AS tokens,
         uniqExactIf(session_id, session_id != '') AS sessions,
         sumIf(event_count, cost_status = 'priced') AS priced_events,
         sumIf(event_count, cost_status = 'unpriced') AS unpriced_events,
         sumIf(event_count, cost_status = 'legacy') AS legacy_events
  FROM ${current.source} WHERE team_id != ''
  GROUP BY key ORDER BY cost DESC LIMIT 100
)` : "";

    const breakdownSql = `WITH '/* organization-dashboard-breakdown */' AS query_tag
SELECT 'user_leader' AS result_kind, key, cost, tokens, sessions,
       priced_events, unpriced_events, legacy_events
FROM (
  SELECT user_id AS key,
         sumIf(cost_usd, cost_status != 'unpriced') AS cost,
         sum(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens) AS tokens,
         uniqExactIf(session_id, session_id != '') AS sessions,
         sumIf(event_count, cost_status = 'priced') AS priced_events,
         sumIf(event_count, cost_status = 'unpriced') AS unpriced_events,
         sumIf(event_count, cost_status = 'legacy') AS legacy_events
  FROM ${current.source} WHERE user_id != ''
  GROUP BY key ORDER BY ${orderColumn} DESC LIMIT 100
)
${teamBranch}
UNION ALL
SELECT 'provider' AS result_kind, provider_key AS key,
       sumIf(cost_usd, cost_status != 'unpriced') AS cost,
       sum(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens) AS tokens,
       uniqExactIf(session_id, session_id != '') AS sessions,
       sumIf(event_count, cost_status = 'priced') AS priced_events,
       sumIf(event_count, cost_status = 'unpriced') AS unpriced_events,
       sumIf(event_count, cost_status = 'legacy') AS legacy_events
FROM ${current.source}
GROUP BY provider_key ORDER BY tokens DESC`;

    const [usagePayload, breakdownPayload] = await Promise.all([
      this.queryJson<unknown>(
        usageSql,
        params,
        undefined,
        "organization_dashboard_usage",
      ),
      this.queryJson<unknown>(
        breakdownSql,
        current.params,
        undefined,
        "organization_dashboard_breakdown",
      ),
    ]);
    const usageRows = usagePayload.map(parseOrganizationUsageBundleRow);
    const breakdownRows = breakdownPayload.map(parseOrganizationBreakdownBundleRow);
    const currentRow = usageRows.find((row) => row.result_kind === "current_overview");
    const previousRow = usageRows.find((row) => row.result_kind === "previous_overview");
    if (!currentRow || !previousRow) {
      throw new Error("Organization dashboard overview row is missing");
    }

    const toOverview = (row: OrganizationUsageBundleRow): OverviewStats => ({
      totalSessions: n(row.sessions),
      activeUsers: n(row.active_users),
      totalCostUsd: n(row.cost),
      totalInputTokens: n(row.input),
      totalOutputTokens: n(row.output),
      totalCacheReadTokens: n(row.cache_read),
      totalCacheCreationTokens: n(row.cache_creation),
      costCoverage: costCoverage(row),
    });
    const daily = usageRows
      .filter((row) => row.result_kind === "daily")
      .map((row) => ({
        day: row.day!,
        sessions: n(row.sessions),
        activeUsers: n(row.active_users),
        costUsd: n(row.cost),
        inputTokens: n(row.input),
        outputTokens: n(row.output),
        cacheReadTokens: n(row.cache_read),
        cacheCreationTokens: n(row.cache_creation),
      }))
      .sort((a, b) => a.day.localeCompare(b.day));

    const userRows = breakdownRows.filter((row) => row.result_kind === "user_leader");
    const teamRows = breakdownRows.filter((row) => row.result_kind === "team_leader");
    const providerRows = breakdownRows.filter((row) => row.result_kind === "provider");
    const [userLabels, teamLabels] = await Promise.all([
      this.labelMap("user", userRows.map((row) => row.key)),
      q.includeTeamLeaderboard
        ? this.labelMap("team", teamRows.map((row) => row.key))
        : Promise.resolve(new Map<string, string>()),
    ]);
    const toLeader = (
      row: OrganizationBreakdownBundleRow,
      labels: Map<string, string>,
    ): LeaderRow => ({
      key: row.key,
      label: labels.get(row.key) ?? row.key,
      costUsd: n(row.cost),
      totalTokens: n(row.tokens),
      sessions: n(row.sessions),
      costCoverage: costCoverage(row),
    });

    return {
      overview: toOverview(currentRow),
      previousOverview: toOverview(previousRow),
      daily,
      topUsers: userRows.map((row) => toLeader(row, userLabels)),
      topTeams: teamRows.map((row) => toLeader(row, teamLabels)),
      providerBreakdown: providerRows.map((row) => ({
        providerKey: row.key,
        costUsd: n(row.cost),
        totalTokens: n(row.tokens),
        sessions: n(row.sessions),
        costCoverage: costCoverage(row),
      })),
    };
  }

  async getUserUsage(userId: string, q: PeriodQuery & BucketOptions): Promise<UserUsage> {
    const scoped = { ...q, userId }; // bucket/timezone 은 dailyQuery 만 소비, 나머지 쿼리는 무시
    const [overview, daily, byModel, byHost] = await Promise.all([
      this.overviewQuery(scoped),
      this.dailyQuery(scoped),
      this.modelBreakdown(scoped),
      this.hostBreakdown(scoped),
    ]);
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
      } & CostCoverageRow>(
        `WITH '/* user-insights */' AS query_tag,
         tagged AS (
           SELECT period,
                  if(period = 'current',
                     dateDiff('day', {current_from:DateTime64(3)}, ts, '${tz}'),
                     dateDiff('day', {previous_from:DateTime64(3)}, ts, '${tz}')) AS position,
                  session_id,
                  cost_usd,
                  cost_status,
                  event_count,
                  input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens AS tokens
           FROM ${source.source}
         )
         SELECT 'summary' AS kind, period, CAST(NULL AS Nullable(Int64)) AS position,
                sumIf(cost_usd, cost_status != 'unpriced') AS cost,
                uniqExactIf(session_id, session_id != '') AS sessions,
                sum(tokens) AS tokens,
                sumIf(event_count, cost_status = 'priced') AS priced_events,
                sumIf(event_count, cost_status = 'unpriced') AS unpriced_events,
                sumIf(event_count, cost_status = 'legacy') AS legacy_events
         FROM tagged GROUP BY period
         UNION ALL
         SELECT 'trend' AS kind, period, position,
                sumIf(cost_usd, cost_status != 'unpriced') AS cost,
                uniqExactIf(session_id, session_id != '') AS sessions,
                sum(tokens) AS tokens,
                sumIf(event_count, cost_status = 'priced') AS priced_events,
                sumIf(event_count, cost_status = 'unpriced') AS unpriced_events,
                sumIf(event_count, cost_status = 'legacy') AS legacy_events
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
      } & CostCoverageRow>(
        `WITH '/* user-insights */' AS query_tag,
         scoped AS (
           SELECT period,
                  if(model = '', '(unknown)', model) AS model,
                  provider_key,
                  cost_usd,
                  cost_status,
                  event_count,
                  input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens AS tokens
           FROM ${source.source}
         )
         SELECT 'model' AS dimension, model AS key, period,
                sumIf(cost_usd, cost_status != 'unpriced') AS cost, sum(tokens) AS tokens,
                sumIf(event_count, cost_status = 'priced') AS priced_events,
                sumIf(event_count, cost_status = 'unpriced') AS unpriced_events,
                sumIf(event_count, cost_status = 'legacy') AS legacy_events
         FROM scoped GROUP BY model, period
         UNION ALL
         SELECT 'provider' AS dimension, provider_key AS key, period,
                sumIf(cost_usd, cost_status != 'unpriced') AS cost, sum(tokens) AS tokens,
                sumIf(event_count, cost_status = 'priced') AS priced_events,
                sumIf(event_count, cost_status = 'unpriced') AS unpriced_events,
                sumIf(event_count, cost_status = 'legacy') AS legacy_events
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
      costCoverage: costCoverage(r),
    }));
    const compositions: InsightCompositionRow[] = compositionRows.map((r) => ({
      dimension: r.dimension,
      key: r.key,
      period: r.period,
      costUsd: n(r.cost),
      totalTokens: n(r.tokens),
      costCoverage: costCoverage(r),
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
    } & CostCoverageRow>(
      `SELECT session_id,
              groupUniqArrayIf(model, model != '') AS models,
              groupUniqArrayIf(host,  host  != '') AS hosts,
              sum(input_tokens)          AS input,
              sum(output_tokens)         AS output,
              sum(cache_read_tokens)     AS cache_read,
              sum(cache_creation_tokens) AS cache_creation,
              sumIf(cost_usd, cost_status != 'unpriced') AS cost,
              count()                    AS events,
              countIf(cost_status = 'priced')   AS priced_events,
              countIf(cost_status = 'unpriced') AS unpriced_events,
              countIf(cost_status = 'legacy')   AS legacy_events
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
      costCoverage: costCoverage(r),
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
      cost_status: SessionUsageEventRow["costStatus"];
    }>(
      `SELECT ts,
              nullIf(model, '')          AS model,
              input_tokens               AS input,
              output_tokens              AS output,
              cache_read_tokens          AS cache_read,
              cache_creation_tokens      AS cache_creation,
              cost_usd                   AS cost,
              cost_status
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
      costStatus: r.cost_status,
    }));
  }

  async getLeaderboard(q: PeriodQuery & { scope: LeaderScope; teamId?: string; orderBy?: "cost" | "tokens" }): Promise<LeaderRow[]> {
    const dashboardQuery = q as ScopedQuery & Partial<BucketOptions>;
    const timezone = safeTimezone(dashboardQuery.timezone, this.tz);
    const source = await this.resolveTimeseriesSource(dashboardQuery, dashboardQuery.bucket, timezone);
    const col = q.scope === "user" ? "user_id" : "team_id";
    const orderColumn = q.orderBy === "tokens" ? "tokens" : "cost";
    const rows = await this.queryJson<{ key: string; cost?: string; tokens?: string; sessions?: string } & CostCoverageRow>(
      `SELECT ${col} AS key,
              sumIf(cost_usd, cost_status != 'unpriced') AS cost,
              sum(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens) AS tokens,
              uniqExactIf(session_id, session_id != '') AS sessions,
              sumIf(event_count, cost_status = 'priced') AS priced_events,
              sumIf(event_count, cost_status = 'unpriced') AS unpriced_events,
              sumIf(event_count, cost_status = 'legacy') AS legacy_events
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
      costCoverage: costCoverage(r),
    }));
  }

  async getProviderBreakdown(q: PeriodQuery & { teamId?: string }): Promise<ProviderBreakdown[]> {
    const dashboardQuery = q as ScopedQuery & Partial<BucketOptions>;
    const timezone = safeTimezone(dashboardQuery.timezone, this.tz);
    const source = await this.resolveTimeseriesSource(dashboardQuery, dashboardQuery.bucket, timezone);
    const rows = await this.queryJson<{ provider_key: string; cost?: string; tokens?: string; sessions?: string } & CostCoverageRow>(
      `SELECT provider_key,
              sumIf(cost_usd, cost_status != 'unpriced') AS cost,
              sum(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens) AS tokens,
              uniqExactIf(session_id, session_id != '') AS sessions,
              sumIf(event_count, cost_status = 'priced') AS priced_events,
              sumIf(event_count, cost_status = 'unpriced') AS unpriced_events,
              sumIf(event_count, cost_status = 'legacy') AS legacy_events
       FROM ${source.source}
       GROUP BY provider_key ORDER BY tokens DESC`,
      source.params,
    );
    return rows.map((r) => ({
      providerKey: r.provider_key,
      costUsd: n(r.cost),
      totalTokens: n(r.tokens),
      sessions: n(r.sessions),
      costCoverage: costCoverage(r),
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

type RollupReadEnvironment = Record<string, string | undefined>;

export type ClickHouseRollupReadFlag = {
  enabled: boolean;
  legacyFlagMigration: "deprecated_alias" | null;
};

let legacyRollupWarningEmitted = false;

function envFlagValue(value: string | undefined, defaultValue = false): boolean {
  if (value == null || value.trim() === "") return defaultValue;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "on";
}

export function resolveRollupReadMode(value: string | undefined): RollupReadMode {
  if (value == null || value.trim() === "") return "auto";
  return envFlagValue(value);
}

function resolveTimezoneRollupReadMode(env: RollupReadEnvironment): RollupReadMode {
  const current = env.CLICKHOUSE_READ_TIMEZONE_ROLLUP;
  if (current != null && current.trim() !== "") return resolveRollupReadMode(current);
  const legacy = env.CLICKHOUSE_READ_ROLLUP;
  if (legacy != null && legacy.trim() !== "") return resolveRollupReadMode(legacy);
  return "auto";
}

/**
 * 예전 hourly read 플래그는 새 timezone cache read 요청의 deprecated alias다.
 * source 선택 자체는 ClickHouseStorage의 registry/coverage/dirty guard가 결정한다.
 */
export function resolveClickHouseRollupReadFlag(
  env: RollupReadEnvironment = process.env,
): ClickHouseRollupReadFlag {
  const legacyValue = env.CLICKHOUSE_READ_ROLLUP?.trim();
  const newValue = env.CLICKHOUSE_READ_TIMEZONE_ROLLUP?.trim();
  const legacyPresent = legacyValue != null && legacyValue !== "";
  const newExplicit = newValue != null && newValue !== "";

  if (legacyPresent && !legacyRollupWarningEmitted) {
    legacyRollupWarningEmitted = true;
    console.warn(JSON.stringify({
      level: "warn",
      event: "clickhouse_read_rollup_deprecated",
      legacyFlag: "CLICKHOUSE_READ_ROLLUP",
      replacementFlag: "CLICKHOUSE_READ_TIMEZONE_ROLLUP",
      message: "Legacy hourly rollup source was removed; the legacy flag now aliases guarded timezone cache reads with exact fallback.",
      action: "Deploy schema, run pnpm rollup:activate-timezones, verify v2/timezone shadow worker coverage and benchmark, set CLICKHOUSE_READ_TIMEZONE_ROLLUP, then unset CLICKHOUSE_READ_ROLLUP.",
    }));
  }

  return {
    enabled: newExplicit
      ? envFlagValue(newValue)
      : envFlagValue(legacyValue),
    legacyFlagMigration: legacyPresent ? "deprecated_alias" : null,
  };
}

/** 환경변수로 CH 클라이언트를 구성해 스토리지를 만든다 (메타용 PG 풀은 주입). */
export function createClickHouseStorage(pg: Pool, opts: ClickHouseStorageOptions = {}): ClickHouseStorage {
  resolveClickHouseRollupReadFlag();
  return new ClickHouseStorage(createClickHouseClient(), pg, {
    readFinal: readEnvFlag("CLICKHOUSE_READ_FINAL", false),
    readRollup: resolveTimezoneRollupReadMode(process.env),
    read15mRollup: readEnvFlag("CLICKHOUSE_READ_15M_ROLLUP", false),
    read15mV2Rollup: resolveRollupReadMode(process.env.CLICKHOUSE_READ_15M_V2_ROLLUP),
    enforceRetentionTtl: readEnvFlag("CLICKHOUSE_ENFORCE_RETENTION_TTL", false),
    ...opts,
  });
}

export async function pingClickHouse(): Promise<void> {
  await defaultClickHouseOperationController.run("readiness_ping", async () => {
    const ch = createClickHouseClient();
    try {
      const result = await ch.ping({ select: true });
      if (!result.success) throw result.error;
    } finally {
      await ch.close();
    }
  }, { retryTransient: true });
}

function readPositiveIntEnv(name: string, defaultValue: number): number {
  const value = process.env[name];
  if (value == null || value === "") return defaultValue;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : defaultValue;
}
