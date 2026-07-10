import { type ClickHouseClient, createClient } from "@clickhouse/client";
import type {
  BucketOptions,
  DailyPoint,
  DeviceInfo,
  HostBreakdown,
  InsightAggregateRow,
  InsightComparisonQuery,
  InsightCompositionRow,
  LeaderRow,
  LeaderScope,
  ModelBreakdown,
  OverviewStats,
  PeriodQuery,
  SaveResult,
  SessionUsageEventRow,
  SessionUsageSummary,
  ModelDailyPoint,
  StorageBackend,
  TimeBucket,
  TimeseriesScope,
  UsageEvent,
  UserUsage,
  UserInsightComparison,
} from "@toard/core";
import { buildUserInsightComparison } from "@toard/core";
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

function floorFifteenMinuteDate(ts: Date): Date {
  return new Date(Math.floor(ts.getTime() / FIFTEEN_MINUTES_MS) * FIFTEEN_MINUTES_MS);
}

function ceilFifteenMinuteDate(ts: Date): Date {
  const floor = floorFifteenMinuteDate(ts);
  return floor.getTime() === ts.getTime() ? floor : new Date(floor.getTime() + FIFTEEN_MINUTES_MS);
}

function chDate(s: string): Date {
  return new Date(`${s.replace(" ", "T")}Z`);
}

type ScopedQuery = PeriodQuery & { userId?: string; teamId?: string };
type Params = Record<string, unknown>;
type InsightSourcePart =
  | { kind: "hybrid"; source: string; params: Params }
  | { kind: "raw"; source: string; where: string; params: Params };
type InsightSource = { source: string; params: Params };

export interface ClickHouseStorageOptions {
  /** 조직 타임존 (IANA, ADR-008) — 쿼리에 timezone 미지정 시 버킷 폴백. 기본 UTC. */
  timezone?: string;
  /** ReplacingMergeTree 중복 제거를 읽기 시점에 강제할지 여부. 기본 false. */
  readFinal?: boolean;
  /** 대시보드 집계 읽기를 hourly rollup 테이블로 보낼지 여부. 기본 false. */
  readRollup?: boolean;
  /** finalized 15분 rollup + 최근 raw tail hybrid 시계열 조회를 사용할지 여부. 기본 false. */
  read15mRollup?: boolean;
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

const CLICKHOUSE_SCHEMA_DDL = [
  "ALTER TABLE usage_events MODIFY SETTING non_replicated_deduplication_window = 10000",
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
] as const;

const CLICKHOUSE_TRANSIENT_RETRY_ATTEMPTS = 5;
const CLICKHOUSE_TRANSIENT_RETRY_BASE_MS = 150;
const CLICKHOUSE_15M_ROLLUP_NAME = "usage_15m";
const CLICKHOUSE_ROLLUP_DEFAULT_FINALIZE_DELAY_MS = 30 * 60 * 1000;
const CLICKHOUSE_ROLLUP_DEFAULT_MAX_BUCKETS = 16;
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
    return { where: `WHERE ${conds.join(" AND ")}`, params };
  }

  private rollupWhere(q: ScopedQuery): { where: string; params: Params } {
    const conds = ["bucket_hour >= {from:DateTime64(3)}", "bucket_hour < {to:DateTime64(3)}"];
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
    return { sql: conds.length > 0 ? ` AND ${conds.join(" AND ")}` : "", params };
  }

  private canUseRollup(bucket?: TimeBucket): boolean {
    return this.readRollup && bucket !== "30m" && bucket !== "15m";
  }

  private bucketExpr(bucket: TimeBucket | undefined, timeCol: string, tz: string): string {
    if (bucket === "hour") return `formatDateTime(${timeCol}, '%Y-%m-%d %H:00', '${tz}')`;
    if (bucket === "30m") {
      return `formatDateTime(toStartOfInterval(${timeCol}, INTERVAL 30 minute, '${tz}'), '%Y-%m-%d %H:%i', '${tz}')`;
    }
    if (bucket === "15m") {
      return `formatDateTime(toStartOfInterval(${timeCol}, INTERVAL 15 minute, '${tz}'), '%Y-%m-%d %H:%i', '${tz}')`;
    }
    return `toString(toDate(${timeCol}, '${tz}'))`;
  }

  private async rollup15mWindow(q: ScopedQuery): Promise<{ rollupFrom: Date; rollupTo: Date } | null> {
    if (!this.read15mRollup) return null;
    if (q.to <= q.from) return null;
    const rollupFrom = ceilFifteenMinuteDate(q.from);
    let rollupTo = floorFifteenMinuteDate(q.to);
    if (rollupTo <= rollupFrom) return null;
    const watermark = await this.pg.query<{ watermark: Date }>(
      "SELECT watermark FROM clickhouse_rollup_watermarks WHERE name = $1",
      [CLICKHOUSE_15M_ROLLUP_NAME],
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
      [CLICKHOUSE_15M_ROLLUP_NAME, rollupFrom, rollupTo],
    );
    const dirtyBucket = dirty.rows[0]?.bucket;
    if (dirtyBucket && dirtyBucket < rollupTo) rollupTo = dirtyBucket;
    return rollupTo > rollupFrom ? { rollupFrom, rollupTo } : null;
  }

  private async rollup15mTimeseriesSource(q: ScopedQuery): Promise<{ source: string; params: Params } | null> {
    const window = await this.rollup15mWindow(q);
    if (!window) return null;
    const filter = this.scopedAndFilter(q);
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
        FROM usage_15m_rollup
        WHERE bucket_15m >= {rollupFrom:DateTime64(3)}
          AND bucket_15m < {rollupTo:DateTime64(3)}
          ${filter.sql}
        GROUP BY bucket_15m, provider_key, user_id, team_id, session_id, model, host
      )
      UNION ALL
      SELECT ts, provider_key, user_id, team_id, session_id, model, host,
             input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd
      FROM ${this.usageEventsSource}
      WHERE ts >= {rollupTo:DateTime64(3)}
        AND ts < {to:DateTime64(3)}
        ${filter.sql}
    )`;
    return { source, params };
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
  ): Promise<{ source: string; where: string; params: Params }> {
    const hybrid = await this.rollup15mTimeseriesSource(q);
    if (hybrid) {
      return this.namespaceInsightSource(
        { kind: "hybrid", source: hybrid.source, params: hybrid.params },
        prefix,
      );
    }
    const raw = this.periodWhere(q);
    return this.namespaceInsightSource(
      { kind: "raw", source: this.usageEventsSource, where: raw.where, params: raw.params },
      prefix,
    );
  }

  private async insightSource(q: InsightComparisonQuery, userId: string): Promise<InsightSource> {
    const [previous, current] = await Promise.all([
      this.insightPeriodSource({ ...q.previous, providerKey: q.providerKey, userId }, "previous"),
      this.insightPeriodSource({ ...q.current, providerKey: q.providerKey, userId }, "current"),
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

  async saveUsageEvents(events: UsageEvent[]): Promise<SaveResult> {
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

  private async enqueueUsageEvents(events: UsageEvent[]): Promise<EnqueueResult> {
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
              log_adapter, host)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
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
                  cache_creation_tokens::text, cost_usd::text, log_adapter, host
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
    await client.query(
      `INSERT INTO clickhouse_rollup_dirty_buckets (name, bucket)
       SELECT $1, unnest($2::timestamptz[])
       ON CONFLICT (name, bucket) DO UPDATE
         SET updated_at = now()`,
      [CLICKHOUSE_15M_ROLLUP_NAME, buckets],
    );
  }

  private async firstUsage15mBucket(): Promise<Date | null> {
    const rows = await this.queryJson<{ events?: string; first_bucket?: string }>(
      `SELECT count() AS events,
              min(toStartOfInterval(ts, INTERVAL 15 minute, 'UTC')) AS first_bucket
       FROM ${this.usageEventsSource}`,
      {},
    );
    const row = rows[0];
    if (!row || n(row.events) === 0 || !row.first_bucket) return null;
    return chDate(row.first_bucket);
  }

  private async readOrInit15mWatermark(client: PoolClient, eligibleTo: Date): Promise<Date> {
    const current = await client.query<{ watermark: Date }>(
      "SELECT watermark FROM clickhouse_rollup_watermarks WHERE name = $1",
      [CLICKHOUSE_15M_ROLLUP_NAME],
    );
    if (current.rows[0]) return current.rows[0].watermark;

    const firstBucket = await this.firstUsage15mBucket();
    const watermark = firstBucket ?? eligibleTo;
    await client.query(
      `INSERT INTO clickhouse_rollup_watermarks (name, watermark)
       VALUES ($1, $2)
       ON CONFLICT (name) DO NOTHING`,
      [CLICKHOUSE_15M_ROLLUP_NAME, watermark],
    );
    const saved = await client.query<{ watermark: Date }>(
      "SELECT watermark FROM clickhouse_rollup_watermarks WHERE name = $1",
      [CLICKHOUSE_15M_ROLLUP_NAME],
    );
    return saved.rows[0]?.watermark ?? watermark;
  }

  private async aggregate15mBuckets(buckets: Date[], version: number): Promise<Rollup15mRow[]> {
    if (buckets.length === 0) return [];
    const sorted = [...buckets].sort((a, b) => a.getTime() - b.getTime());
    const from = sorted[0]!;
    const to = new Date(sorted.at(-1)!.getTime() + FIFTEEN_MINUTES_MS);
    const rows = await this.queryJson<Rollup15mAggRow>(
      `SELECT toStartOfInterval(ts, INTERVAL 15 minute, 'UTC') AS bucket_15m,
              provider_key,
              user_id,
              team_id,
              session_id,
              model,
              host,
              count() AS event_count,
              sum(input_tokens) AS input_tokens,
              sum(output_tokens) AS output_tokens,
              sum(cache_read_tokens) AS cache_read_tokens,
              sum(cache_creation_tokens) AS cache_creation_tokens,
              sum(cost_usd) AS cost_usd
       FROM ${this.usageEventsSource}
       WHERE ts >= {from:DateTime64(3)}
         AND ts < {to:DateTime64(3)}
         AND has(arrayMap(x -> toDateTime64(x, 3, 'UTC'), {buckets:Array(String)}), toStartOfInterval(ts, INTERVAL 15 minute, 'UTC'))
       GROUP BY bucket_15m, provider_key, user_id, team_id, session_id, model, host`,
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
      event_count: n(r.event_count),
      input_tokens: n(r.input_tokens),
      output_tokens: n(r.output_tokens),
      cache_read_tokens: n(r.cache_read_tokens),
      cache_creation_tokens: n(r.cache_creation_tokens),
      cost_usd: r.cost_usd,
      version,
    }));
  }

  async compactUsage15mRollup(limitBuckets?: number): Promise<CompactUsage15mRollupResult> {
    await this.ensureSchema();
    const maxBuckets = Math.max(
      1,
      Math.min(256, Math.floor(limitBuckets ?? readPositiveIntEnv("CLICKHOUSE_ROLLUP_MAX_BUCKETS", CLICKHOUSE_ROLLUP_DEFAULT_MAX_BUCKETS))),
    );
    const delayMs = readPositiveIntEnv("CLICKHOUSE_ROLLUP_FINALIZE_DELAY_MS", CLICKHOUSE_ROLLUP_DEFAULT_FINALIZE_DELAY_MS);
    const eligibleTo = floorFifteenMinuteDate(new Date(Date.now() - delayMs));
    const client = await this.pg.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`rollup:${CLICKHOUSE_15M_ROLLUP_NAME}`]);
      const watermark = await this.readOrInit15mWatermark(client, eligibleTo);
      const dirtyLimit = Math.max(1, Math.ceil(maxBuckets / 2));
      const dirty = await client.query<{ bucket: Date }>(
        `SELECT bucket
         FROM clickhouse_rollup_dirty_buckets
         WHERE name = $1 AND bucket < $2
         ORDER BY bucket
         LIMIT $3`,
        [CLICKHOUSE_15M_ROLLUP_NAME, eligibleTo, dirtyLimit],
      );
      const remaining = maxBuckets - dirty.rows.length;
      const contiguousCount = Math.min(
        remaining,
        Math.max(0, Math.floor((eligibleTo.getTime() - watermark.getTime()) / FIFTEEN_MINUTES_MS)),
      );
      const contiguousBuckets = Array.from(
        { length: contiguousCount },
        (_, i) => new Date(watermark.getTime() + i * FIFTEEN_MINUTES_MS),
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
      const rollupRows = await this.aggregate15mBuckets(buckets, version);
      if (rollupRows.length > 0) {
        await this.ch.insert({
          table: "usage_15m_rollup",
          values: rollupRows,
          format: "JSONEachRow",
        });
      }

      const newWatermark = contiguousBuckets.length > 0
        ? new Date(watermark.getTime() + contiguousBuckets.length * FIFTEEN_MINUTES_MS)
        : watermark;
      await client.query(
        `UPDATE clickhouse_rollup_watermarks
         SET watermark = $2, updated_at = now()
         WHERE name = $1`,
        [CLICKHOUSE_15M_ROLLUP_NAME, newWatermark],
      );
      await client.query(
        `DELETE FROM clickhouse_rollup_dirty_buckets
         WHERE name = $1 AND bucket = ANY($2::timestamptz[])`,
        [CLICKHOUSE_15M_ROLLUP_NAME, buckets],
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
  private async overviewQuery(q: ScopedQuery): Promise<OverviewStats> {
    const { where, params } = this.readRollup ? this.rollupWhere(q) : this.periodWhere(q);
    const rows = await this.queryJson<AggRow>(
      `SELECT uniqExactIf(session_id, session_id != '') AS sessions,
              uniqExactIf(user_id, user_id != '')       AS active_users,
              sum(cost_usd)     AS cost,
              sum(input_tokens) AS input,
              sum(output_tokens) AS output,
              sum(cache_read_tokens)     AS cache_read,
              sum(cache_creation_tokens) AS cache_creation
       FROM ${this.readRollup ? "usage_hourly_rollup" : this.usageEventsSource} ${where}`,
      params,
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
    const hybrid = await this.rollup15mTimeseriesSource(q);
    const readRollup = !hybrid && this.canUseRollup(q.bucket);
    const { where, params } = hybrid ? { where: "", params: hybrid.params } : readRollup ? this.rollupWhere(q) : this.periodWhere(q);
    // 버킷 타임존 — 요청(뷰어) 타임존 우선, 없으면 조직 타임존 (ADR-008 개정). 리터럴 삽입이라 재검증 필수.
    const tz = safeTimezone(q.timezone, this.tz);
    const timeCol = hybrid || !readRollup ? "ts" : "bucket_hour";
    const source = hybrid?.source ?? (readRollup ? "usage_hourly_rollup" : this.usageEventsSource);
    // 하루 안 버킷은 'YYYY-MM-DD HH:mm', 일 버킷은 'YYYY-MM-DD' (storage 계약 참조)
    const bucketExpr = this.bucketExpr(q.bucket, timeCol, tz);
    const rows = await this.queryJson<{ day: string } & AggRow>(
      `SELECT ${bucketExpr}                                   AS day,
              uniqExactIf(session_id, session_id != '')       AS sessions,
              uniqExactIf(user_id, user_id != '')             AS active_users,
              sum(cost_usd)     AS cost,
              sum(input_tokens) AS input,
              sum(output_tokens) AS output,
              sum(cache_read_tokens)     AS cache_read,
              sum(cache_creation_tokens) AS cache_creation
       FROM ${source} ${where}
       GROUP BY day ORDER BY day`,
      params,
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

  private async modelBreakdown(q: ScopedQuery): Promise<ModelBreakdown[]> {
    const { where, params } = this.readRollup ? this.rollupWhere(q) : this.periodWhere(q);
    const rows = await this.queryJson<{ model: string; cost?: string; tokens?: string; sessions?: string }>(
      `SELECT if(model = '', '(unknown)', model)               AS model,
              sum(cost_usd)                                     AS cost,
              sum(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens) AS tokens,
              uniqExactIf(session_id, session_id != '')         AS sessions
       FROM ${this.readRollup ? "usage_hourly_rollup" : this.usageEventsSource} ${where}
       GROUP BY model ORDER BY cost DESC`,
      params,
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
    const hybrid = await this.rollup15mTimeseriesSource(scoped);
    const readRollup = !hybrid && this.canUseRollup(q.bucket);
    const { where, params } = hybrid ? { where: "", params: hybrid.params } : readRollup ? this.rollupWhere(scoped) : this.periodWhere(scoped);
    const tz = safeTimezone(q.timezone, this.tz);
    const timeCol = hybrid || !readRollup ? "ts" : "bucket_hour";
    const source = hybrid?.source ?? (readRollup ? "usage_hourly_rollup" : this.usageEventsSource);
    const bucketExpr = this.bucketExpr(q.bucket, timeCol, tz);
    const rows = await this.queryJson<{ day: string; model: string; cost?: string; tokens?: string }>(
      `SELECT ${bucketExpr}                                    AS day,
              if(model = '', '(unknown)', model)               AS model,
              sum(cost_usd)                                     AS cost,
              sum(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens) AS tokens
       FROM ${source} ${where}
       GROUP BY day, model ORDER BY day, cost DESC`,
      params,
    );
    return rows.map((r) => ({ day: r.day, model: r.model, costUsd: n(r.cost), totalTokens: n(r.tokens) }));
  }

  // 시간 버킷 고정 시계열 — 히트맵은 기간의 표시 버킷(day)과 무관하게 항상 hour 로 그린다
  getUserHourlyTimeseries(userId: string, q: PeriodQuery & { timezone?: string }): Promise<DailyPoint[]> {
    return this.dailyQuery({ ...q, userId, bucket: "hour" });
  }

  // 컴퓨터(호스트)별 분해 — modelBreakdown 동형. 빈 문자열('') 은 nullIf 로 NULL 정규화해
  // PG 의 NULL 과 동일하게 UI "(알 수 없음)" 버킷으로 접힌다.
  private async hostBreakdown(q: ScopedQuery): Promise<HostBreakdown[]> {
    const { where, params } = this.readRollup ? this.rollupWhere(q) : this.periodWhere(q);
    const rows = await this.queryJson<{ host: string | null; cost?: string; tokens?: string; sessions?: string }>(
      `SELECT nullIf(host, '')                                 AS host,
              sum(cost_usd)                                     AS cost,
              sum(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens) AS tokens,
              uniqExactIf(session_id, session_id != '')         AS sessions
       FROM ${this.readRollup ? "usage_hourly_rollup" : this.usageEventsSource} ${where}
       GROUP BY host ORDER BY cost DESC`,
      params,
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

  async getLeaderboard(q: PeriodQuery & { scope: LeaderScope; teamId?: string }): Promise<LeaderRow[]> {
    const { where, params } = this.readRollup ? this.rollupWhere(q) : this.periodWhere(q);
    const col = q.scope === "user" ? "user_id" : "team_id";
    const rows = await this.queryJson<{ key: string; cost?: string; tokens?: string; sessions?: string }>(
      `SELECT ${col} AS key,
              sum(cost_usd)                             AS cost,
              sum(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens) AS tokens,
              uniqExactIf(session_id, session_id != '') AS sessions
       FROM ${this.readRollup ? "usage_hourly_rollup" : this.usageEventsSource} ${where} AND ${col} != ''
       GROUP BY key ORDER BY cost DESC LIMIT 100`,
      params,
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
    readRollup: readEnvFlag("CLICKHOUSE_READ_ROLLUP", false),
    read15mRollup: readEnvFlag("CLICKHOUSE_READ_15M_ROLLUP", false),
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
