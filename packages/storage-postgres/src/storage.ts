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
  PricingRepairBatchResult,
  PricingRepairRequest,
  PricingRepairResolver,
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
  UsageCostCoverage,
  UsageReplayReconciliationRequest,
  UsageReplayReconciliationResult,
  UnpricedUsageModelDiagnostic,
  UserUsage,
  UserInsightComparison,
} from "@toard/core";
import { buildUserInsightComparison } from "@toard/core";
import { Pool, type PoolClient } from "pg";

/** pg 는 NUMERIC/BIGINT 를 string 으로 반환 → number 변환 */
const n = (v: unknown): number => (v == null ? 0 : Number(v));

type CostCoverageRow = {
  priced_events?: string | number;
  unpriced_events?: string | number;
  legacy_events?: string | number;
};

const costCoverage = (row: CostCoverageRow): UsageCostCoverage => ({
  pricedEvents: n(row.priced_events),
  unpricedEvents: n(row.unpriced_events),
  legacyEvents: n(row.legacy_events),
});

type ScopedQuery = PeriodQuery & { userId?: string; userIds?: string[]; teamId?: string };

export interface PostgresStorageOptions {
  /** 조직 타임존 (IANA, ADR-008) — Mart 물질화 경계이자, 쿼리에 timezone 미지정 시 버킷 폴백. 기본 UTC. */
  timezone?: string;
}

export class PostgresStorage implements StorageBackend {
  private readonly tz: string;

  constructor(
    private readonly pool: Pool,
    opts: PostgresStorageOptions = {},
  ) {
    this.tz = opts.timezone ?? "UTC";
  }

  // ── 공통 WHERE 빌더 ──
  private periodWhere(q: ScopedQuery): { where: string; params: unknown[] } {
    const conds = ["ts >= $1", "ts < $2"];
    const params: unknown[] = [q.from, q.to];
    if (q.providerKey) {
      params.push(q.providerKey);
      conds.push(`provider_key = $${params.length}`);
    }
    if (q.userId) {
      params.push(q.userId);
      conds.push(`user_id = $${params.length}`);
    }
    if (q.teamId) {
      params.push(q.teamId);
      conds.push(`team_id = $${params.length}`);
    }
    if (q.userIds?.length) {
      params.push(q.userIds);
      conds.push(`user_id = ANY($${params.length})`);
    }
    return { where: `WHERE ${conds.join(" AND ")}`, params };
  }

  private bucketExpr(bucket: TimeBucket | undefined, tzParam: string): string {
    if (bucket === "hour") return `to_char(ts AT TIME ZONE ${tzParam}, 'YYYY-MM-DD HH24:00')`;
    if (bucket === "30m") {
      return `to_char(date_bin('30 minutes', ts AT TIME ZONE ${tzParam}, TIMESTAMP '1970-01-01 00:00:00'), 'YYYY-MM-DD HH24:MI')`;
    }
    if (bucket === "15m") {
      return `to_char(date_bin('15 minutes', ts AT TIME ZONE ${tzParam}, TIMESTAMP '1970-01-01 00:00:00'), 'YYYY-MM-DD HH24:MI')`;
    }
    return `to_char((ts AT TIME ZONE ${tzParam})::date, 'YYYY-MM-DD')`;
  }

  // ── 쓰기 ──
  async saveRawEvent(providerKey: string, payload: unknown): Promise<number> {
    const res = await this.pool.query<{ id: string }>(
      "INSERT INTO raw_events (provider_key, payload) VALUES ($1, $2) RETURNING id",
      [providerKey, JSON.stringify(payload)],
    );
    return Number(res.rows[0]!.id);
  }

  async saveUsageEvents(events: FinalizedUsageEvent[]): Promise<SaveResult> {
    if (events.length === 0) return { inserted: 0, deduped: 0 };
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // user_id → 현재 team_id 를 이벤트에 비정규화(수집 시점 스냅샷, 설계 §4.3)
      const deptMap = await this.teamMap(
        client,
        events.map((e) => e.userId).filter((x): x is string => !!x),
      );
      let inserted = 0;
      for (const e of events) {
        const r = await client.query(
          `INSERT INTO usage_events
             (dedup_key, provider_key, user_id, team_id, session_id, model, ts,
              input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd,
              log_adapter, host, pricing_revision_id, cost_status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
           ON CONFLICT (dedup_key) DO NOTHING`,
          [
            e.dedupKey, e.providerKey, e.userId,
            e.userId ? (deptMap.get(e.userId) ?? null) : null,
            e.sessionId, e.model, e.ts,
            e.inputTokens, e.outputTokens, e.cacheReadTokens, e.cacheCreationTokens, e.costUsd,
            e.logAdapter ?? null, e.host ?? null,
            e.pricingRevisionId, e.costStatus,
          ],
        );
        if (r.rowCount === 1) {
          inserted++;
          if (e.userId) await this.bumpDailyUser(client, e);
        }
      }
      await client.query("COMMIT");
      return { inserted, deduped: events.length - inserted };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /** user_id → 현재 team_id (없으면 제외) */
  private async teamMap(client: PoolClient, userIds: string[]): Promise<Map<string, string>> {
    if (userIds.length === 0) return new Map();
    const uniq = [...new Set(userIds)];
    const r = await client.query<{ id: string; team_id: string | null }>(
      "SELECT id, team_id FROM users WHERE id = ANY($1)",
      [uniq],
    );
    const m = new Map<string, string>();
    for (const row of r.rows) if (row.team_id) m.set(row.id, row.team_id);
    return m;
  }

  /** 당일 SUM 지표 증분 (sessions 등 DISTINCT 는 recomputeDaily 가 채움 — 설계 §4.4).
   *  ⚠ Mart(usage_daily_*)는 1차 서빙에 미사용 — 대시보드는 usage_events 를 직접 집계한다(§4.4 구현 한계).
   *  Mart 를 서빙으로 전환하기 전까지 이 증분은 쓰기 오버헤드. */
  private async bumpDailyUser(client: PoolClient, e: UsageEvent): Promise<void> {
    await client.query(
      `INSERT INTO usage_daily_user
         (user_id, day, provider_key, request_count,
          input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd)
       VALUES ($1, ($2 AT TIME ZONE $3)::date, $4, 1, $5,$6,$7,$8,$9)
       ON CONFLICT (user_id, day, provider_key) DO UPDATE SET
         request_count         = usage_daily_user.request_count + 1,
         input_tokens          = usage_daily_user.input_tokens + EXCLUDED.input_tokens,
         output_tokens         = usage_daily_user.output_tokens + EXCLUDED.output_tokens,
         cache_read_tokens     = usage_daily_user.cache_read_tokens + EXCLUDED.cache_read_tokens,
         cache_creation_tokens = usage_daily_user.cache_creation_tokens + EXCLUDED.cache_creation_tokens,
         cost_usd              = usage_daily_user.cost_usd + EXCLUDED.cost_usd`,
      [e.userId, e.ts, this.tz, e.providerKey,
       e.inputTokens, e.outputTokens, e.cacheReadTokens, e.cacheCreationTokens, e.costUsd],
    );
  }

  /** 마감 재계산 (DELETE 후 usage_events 에서 SUM+DISTINCT 재INSERT — 설계 §4.4).
   *  day 단위 트랜잭션 + advisory lock 으로 cron 동시 실행 시 PK 위반·mart 소실을 방지. */
  async recomputeDaily(days: Array<{ day: string }>): Promise<void> {
    const client = await this.pool.connect();
    try {
      for (const { day } of days) {
        await client.query("BEGIN");
        await this.recomputeDailyWithClient(client, day);
        await client.query("COMMIT");
      }
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  private async recomputeDailyWithClient(client: PoolClient, day: string): Promise<void> {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`recompute:${day}`]);
    await client.query("DELETE FROM usage_daily_user WHERE day = $1::date", [day]);
    await client.query(
      `INSERT INTO usage_daily_user
         (user_id, day, provider_key, request_count, sessions,
          input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd)
       SELECT user_id, $1::date, provider_key,
              COUNT(*), COUNT(DISTINCT session_id),
              SUM(input_tokens), SUM(output_tokens), SUM(cache_read_tokens),
              SUM(cache_creation_tokens), SUM(cost_usd)
       FROM usage_events
       WHERE user_id IS NOT NULL
         AND (ts AT TIME ZONE $2)::date = $1::date
       GROUP BY user_id, provider_key`,
      [day, this.tz],
    );
    await client.query("DELETE FROM usage_daily_team WHERE day = $1::date", [day]);
    await client.query(
      `INSERT INTO usage_daily_team
         (team_id, day, provider_key, request_count, active_users, sessions,
          input_tokens, output_tokens, cost_usd)
       SELECT team_id, $1::date, provider_key,
              COUNT(*), COUNT(DISTINCT user_id), COUNT(DISTINCT session_id),
              SUM(input_tokens), SUM(output_tokens), SUM(cost_usd)
       FROM usage_events
       WHERE team_id IS NOT NULL
         AND (ts AT TIME ZONE $2)::date = $1::date
       GROUP BY team_id, provider_key`,
      [day, this.tz],
    );
  }

  async getUnpricedUsageModels(from: Date, to: Date): Promise<UnpricedUsageModelDiagnostic[]> {
    const result = await this.pool.query<{
      model: string | null;
      events: string | number;
      first_at: Date;
      last_at: Date;
    }>(
      `SELECT model, count(*) AS events, min(ts) AS first_at, max(ts) AS last_at
       FROM usage_events
       WHERE ts >= $1 AND ts < $2
         AND cost_status = 'unpriced'
       GROUP BY model
       ORDER BY events DESC, model NULLS LAST`,
      [from, to],
    );
    return result.rows.map((row) => ({
      model: row.model,
      events: n(row.events),
      firstAt: row.first_at,
      lastAt: row.last_at,
    }));
  }

  async reconcileCodexReplayUsage(
    request: UsageReplayReconciliationRequest,
  ): Promise<UsageReplayReconciliationResult> {
    if (request.limit <= 0) {
      return { scanned: 0, reconciled: 0, affectedBuckets: [], hasMore: false };
    }
    const limit = Math.min(Math.max(Math.trunc(request.limit), 1), 1_000);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query<{
        dedup_key: string;
        ts: Date;
        local_day: string;
      }>(
        `SELECT bad.dedup_key, bad.ts,
                to_char((bad.ts AT TIME ZONE $4)::date, 'YYYY-MM-DD') AS local_day
         FROM usage_events bad
         WHERE bad.ts >= $1 AND bad.ts < $2
           AND bad.provider_key = 'codex'
           AND bad.cost_status = 'unpriced'
           AND COALESCE(bad.model, '') = ''
           AND COALESCE(bad.session_id, '') <> ''
           AND COALESCE(bad.log_adapter, '') = 'codex'
           AND EXISTS (
             SELECT 1
             FROM usage_events good
             WHERE good.provider_key = 'codex'
               AND COALESCE(good.model, '') <> ''
               AND good.session_id = bad.session_id
               AND good.user_id IS NOT DISTINCT FROM bad.user_id
               AND good.host IS NOT DISTINCT FROM bad.host
               AND good.log_adapter IS NOT DISTINCT FROM bad.log_adapter
               AND good.input_tokens = bad.input_tokens
               AND good.output_tokens = bad.output_tokens
               AND good.cache_read_tokens = bad.cache_read_tokens
               AND good.cache_creation_tokens = bad.cache_creation_tokens
           )
         ORDER BY bad.ts, bad.dedup_key
         FOR UPDATE OF bad SKIP LOCKED
         LIMIT $3`,
        [request.from, request.to, limit + 1, this.tz],
      );
      const candidates = selected.rows.slice(0, limit);
      const keys = candidates.map((row) => row.dedup_key);
      let reconciled = 0;
      if (keys.length > 0) {
        const deletion = await client.query(
          `DELETE FROM usage_events
           WHERE dedup_key = ANY($1::text[])
             AND provider_key = 'codex'
             AND cost_status = 'unpriced'
             AND COALESCE(model, '') = ''`,
          [keys],
        );
        reconciled = deletion.rowCount ?? 0;
      }
      const days = [...new Set(candidates.map((row) => row.local_day))].sort();
      for (const day of days) {
        await this.recomputeDailyWithClient(client, day);
      }
      await client.query("COMMIT");
      return {
        scanned: candidates.length,
        reconciled,
        affectedBuckets: days.map((day) => new Date(`${day}T00:00:00.000Z`)),
        hasMore: selected.rows.length > limit,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async repairUnpricedUsage(
    request: PricingRepairRequest,
    resolver: PricingRepairResolver,
  ): Promise<PricingRepairBatchResult> {
    if (request.models.length === 0 || request.limit <= 0) {
      return { scanned: 0, recovered: 0, affectedBuckets: [], hasMore: false };
    }
    const limit = Math.min(Math.max(Math.trunc(request.limit), 1), 1_000);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query<{
        dedup_key: string;
        provider_key: string;
        user_id: string | null;
        session_id: string | null;
        model: string | null;
        ts: Date;
        input_tokens: string | number;
        output_tokens: string | number;
        cache_read_tokens: string | number;
        cache_creation_tokens: string | number;
        cost_usd: string | number;
        log_adapter: string | null;
        host: string | null;
        local_day: string;
      }>(
        `SELECT dedup_key, provider_key, user_id, session_id, model, ts,
                input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
                cost_usd, log_adapter, host,
                to_char((ts AT TIME ZONE $5)::date, 'YYYY-MM-DD') AS local_day
         FROM usage_events
         WHERE ts >= $1 AND ts < $2
           AND cost_status = 'unpriced'
           AND model = ANY($3::text[])
         ORDER BY ts, dedup_key
         FOR UPDATE SKIP LOCKED
         LIMIT $4`,
        [request.from, request.to, request.models, limit, this.tz],
      );

      let recovered = 0;
      const days = new Set<string>();
      for (const row of selected.rows) {
        const resolved = resolver({
          dedupKey: row.dedup_key,
          providerKey: row.provider_key,
          userId: row.user_id,
          sessionId: row.session_id,
          model: row.model,
          ts: row.ts,
          inputTokens: n(row.input_tokens),
          outputTokens: n(row.output_tokens),
          cacheReadTokens: n(row.cache_read_tokens),
          cacheCreationTokens: n(row.cache_creation_tokens),
          costUsd: n(row.cost_usd),
          logAdapter: row.log_adapter,
          host: row.host,
        });
        if (!resolved) continue;
        const update = await client.query(
          `UPDATE usage_events
           SET cost_usd = $2,
               pricing_revision_id = $3,
               cost_status = 'priced'
           WHERE dedup_key = $1 AND cost_status = 'unpriced'`,
          [row.dedup_key, resolved.costUsd, resolved.pricingRevisionId],
        );
        if (update.rowCount === 1) {
          recovered += 1;
          days.add(row.local_day);
        }
      }

      for (const day of [...days].sort()) {
        await this.recomputeDailyWithClient(client, day);
      }
      await client.query("COMMIT");
      return {
        scanned: selected.rows.length,
        recovered,
        affectedBuckets: [...days].sort().map((day) => new Date(`${day}T00:00:00.000Z`)),
        hasMore: selected.rows.length >= limit,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  // ── 읽기 ──
  private async overviewQuery(q: ScopedQuery): Promise<OverviewStats> {
    const { where, params } = this.periodWhere(q);
    const res = await this.pool.query(
      `SELECT COUNT(DISTINCT session_id) AS sessions,
              COUNT(DISTINCT user_id)    AS active_users,
              COALESCE(SUM(cost_usd) FILTER (WHERE cost_status <> 'unpriced'),0) AS cost,
              COALESCE(SUM(input_tokens),0)  AS input,
              COALESCE(SUM(output_tokens),0) AS output,
              COALESCE(SUM(cache_read_tokens),0)     AS cache_read,
              COALESCE(SUM(cache_creation_tokens),0) AS cache_creation,
              COUNT(*) FILTER (WHERE cost_status = 'priced') AS priced_events,
              COUNT(*) FILTER (WHERE cost_status = 'unpriced') AS unpriced_events,
              COUNT(*) FILTER (WHERE cost_status = 'legacy') AS legacy_events
       FROM usage_events ${where}`,
      params,
    );
    const r = res.rows[0];
    return {
      totalSessions: n(r.sessions),
      activeUsers: n(r.active_users),
      totalCostUsd: n(r.cost),
      totalInputTokens: n(r.input),
      totalOutputTokens: n(r.output),
      totalCacheReadTokens: n(r.cache_read),
      totalCacheCreationTokens: n(r.cache_creation),
      costCoverage: costCoverage(r),
    };
  }

  private async dailyQuery(q: ScopedQuery & BucketOptions): Promise<DailyPoint[]> {
    const { where, params } = this.periodWhere(q);
    // 버킷 타임존 — 요청(뷰어) 타임존 우선, 없으면 조직 타임존 (ADR-008 개정)
    params.push(q.timezone ?? this.tz);
    // 하루 안 버킷은 'YYYY-MM-DD HH:mm', 일 버킷은 'YYYY-MM-DD' (storage 계약 참조)
    const bucketExpr = this.bucketExpr(q.bucket, `$${params.length}`);
    const res = await this.pool.query(
      `SELECT ${bucketExpr} AS day,
              COUNT(DISTINCT session_id) AS sessions,
              COUNT(DISTINCT user_id)    AS active_users,
              COALESCE(SUM(cost_usd) FILTER (WHERE cost_status <> 'unpriced'),0) AS cost,
              COALESCE(SUM(input_tokens),0)  AS input,
              COALESCE(SUM(output_tokens),0) AS output,
              COALESCE(SUM(cache_read_tokens),0)     AS cache_read,
              COALESCE(SUM(cache_creation_tokens),0) AS cache_creation
       FROM usage_events ${where}
       GROUP BY 1 ORDER BY 1`,
      params,
    );
    return res.rows.map((r) => ({
      day: r.day, sessions: n(r.sessions), activeUsers: n(r.active_users), costUsd: n(r.cost),
      inputTokens: n(r.input), outputTokens: n(r.output),
      cacheReadTokens: n(r.cache_read), cacheCreationTokens: n(r.cache_creation),
    }));
  }

  private async modelBreakdown(q: ScopedQuery): Promise<ModelBreakdown[]> {
    const { where, params } = this.periodWhere(q);
    const res = await this.pool.query(
      `SELECT COALESCE(model,'(unknown)') AS model,
              COALESCE(SUM(cost_usd) FILTER (WHERE cost_status <> 'unpriced'),0) AS cost,
              COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens),0) AS tokens,
              COUNT(DISTINCT session_id)  AS sessions,
              COUNT(*) FILTER (WHERE cost_status = 'priced') AS priced_events,
              COUNT(*) FILTER (WHERE cost_status = 'unpriced') AS unpriced_events,
              COUNT(*) FILTER (WHERE cost_status = 'legacy') AS legacy_events
       FROM usage_events ${where}
       GROUP BY 1 ORDER BY cost DESC`,
      params,
    );
    return res.rows.map((r) => ({
      model: r.model, costUsd: n(r.cost), totalTokens: n(r.tokens), sessions: n(r.sessions),
      costCoverage: costCoverage(r),
    }));
  }

  // 컴퓨터(호스트)별 분해 — modelBreakdown 과 동형(GROUP BY host). periodWhere 재사용으로
  // providerKey 필터 자동 미러. host 는 raw 반환(NULL 보존) — "(알 수 없음)" 라벨은 UI 몫.
  private async hostBreakdown(q: ScopedQuery): Promise<HostBreakdown[]> {
    const { where, params } = this.periodWhere(q);
    const res = await this.pool.query(
      `SELECT host,
              COALESCE(SUM(cost_usd) FILTER (WHERE cost_status <> 'unpriced'),0) AS cost,
              COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens),0) AS tokens,
              COUNT(DISTINCT session_id)  AS sessions,
              COUNT(*) FILTER (WHERE cost_status = 'priced') AS priced_events,
              COUNT(*) FILTER (WHERE cost_status = 'unpriced') AS unpriced_events,
              COUNT(*) FILTER (WHERE cost_status = 'legacy') AS legacy_events
       FROM usage_events ${where}
       GROUP BY host ORDER BY cost DESC`,
      params,
    );
    return res.rows.map((r) => ({
      host: r.host ?? null, costUsd: n(r.cost), totalTokens: n(r.tokens), sessions: n(r.sessions),
      costCoverage: costCoverage(r),
    }));
  }

  getOverview(q: PeriodQuery & { userId?: string; teamId?: string }): Promise<OverviewStats> {
    return this.overviewQuery(q);
  }

  // scope='team' + teamId 는 periodWhere 가 비정규화 team_id 로 필터.
  getDailyTimeseries(
    q: PeriodQuery & BucketOptions & { scope?: TimeseriesScope; teamId?: string },
  ): Promise<DailyPoint[]> {
    return this.dailyQuery(q);
  }

  async getTeamMemberTimeseries(
    q: PeriodQuery & BucketOptions & { teamId: string; userIds: string[] },
  ): Promise<TeamMemberTimeseriesPoint[]> {
    if (q.userIds.length === 0) return [];
    const { where, params } = this.periodWhere(q);
    params.push(q.timezone ?? this.tz);
    const bucketExpr = this.bucketExpr(q.bucket, `$${params.length}`);
    const res = await this.pool.query(
      `SELECT ${bucketExpr} AS day,
              user_id,
              COUNT(DISTINCT session_id) AS sessions,
              COUNT(DISTINCT user_id)    AS active_users,
              COALESCE(SUM(cost_usd) FILTER (WHERE cost_status <> 'unpriced'),0) AS cost,
              COALESCE(SUM(input_tokens),0)  AS input,
              COALESCE(SUM(output_tokens),0) AS output,
              COALESCE(SUM(cache_read_tokens),0)     AS cache_read,
              COALESCE(SUM(cache_creation_tokens),0) AS cache_creation
       FROM usage_events ${where}
       GROUP BY 1, 2 ORDER BY 1, 2`,
      params,
    );
    return res.rows.map((r) => ({
      userId: String(r.user_id),
      day: r.day, sessions: n(r.sessions), activeUsers: n(r.active_users), costUsd: n(r.cost),
      inputTokens: n(r.input), outputTokens: n(r.output),
      cacheReadTokens: n(r.cache_read), cacheCreationTokens: n(r.cache_creation),
    }));
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
    const params = [
      q.previous.from,
      q.previous.to,
      q.current.from,
      q.current.to,
      userId,
      q.providerKey ?? null,
    ];
    const aggregateParams = [...params, q.timezone];
    const [aggregateResult, compositionResult] = await Promise.all([
      this.pool.query<{
        kind: "summary" | "trend";
        period: "current" | "previous";
        position: number | null;
        cost: string;
        sessions: string;
        tokens: string;
      } & CostCoverageRow>(
        `WITH scoped AS MATERIALIZED (
           SELECT
             CASE WHEN ts >= $3 AND ts < $4 THEN 'current' ELSE 'previous' END AS period,
             ts,
             session_id,
             cost_usd,
             cost_status,
             input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens AS tokens
           FROM usage_events
           WHERE ts >= $1 AND ts < $4
             AND ((ts >= $1 AND ts < $2) OR (ts >= $3 AND ts < $4))
             AND user_id = $5
             AND ($6::text IS NULL OR provider_key = $6)
         ), tagged AS (
           SELECT *,
             CASE WHEN period = 'current'
               THEN ((ts AT TIME ZONE $7::text)::date - ($3 AT TIME ZONE $7::text)::date)::int
               ELSE ((ts AT TIME ZONE $7::text)::date - ($1 AT TIME ZONE $7::text)::date)::int
             END AS position
           FROM scoped
         )
         SELECT 'summary' AS kind, period, NULL::int AS position,
                COALESCE(SUM(cost_usd) FILTER (WHERE cost_status <> 'unpriced'), 0) AS cost,
                COUNT(DISTINCT session_id) AS sessions,
                COALESCE(SUM(tokens), 0) AS tokens,
                COUNT(*) FILTER (WHERE cost_status = 'priced') AS priced_events,
                COUNT(*) FILTER (WHERE cost_status = 'unpriced') AS unpriced_events,
                COUNT(*) FILTER (WHERE cost_status = 'legacy') AS legacy_events
         FROM tagged GROUP BY period
         UNION ALL
         SELECT 'trend' AS kind, period, position,
                COALESCE(SUM(cost_usd) FILTER (WHERE cost_status <> 'unpriced'), 0),
                COUNT(DISTINCT session_id), COALESCE(SUM(tokens), 0),
                COUNT(*) FILTER (WHERE cost_status = 'priced'),
                COUNT(*) FILTER (WHERE cost_status = 'unpriced'),
                COUNT(*) FILTER (WHERE cost_status = 'legacy')
         FROM tagged GROUP BY period, position
         ORDER BY kind, position, period`,
        aggregateParams,
      ),
      this.pool.query<{
        dimension: "model" | "provider";
        key: string;
        period: "current" | "previous";
        cost: string;
        tokens: string;
      } & CostCoverageRow>(
        `WITH scoped AS MATERIALIZED (
           SELECT CASE WHEN ts >= $3 AND ts < $4 THEN 'current' ELSE 'previous' END AS period,
                  COALESCE(model, '(unknown)') AS model,
                  provider_key,
                  cost_usd,
                  cost_status,
                  input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens AS tokens
           FROM usage_events
           WHERE user_id = $5
             AND ((ts >= $1 AND ts < $2) OR (ts >= $3 AND ts < $4))
             AND ($6::text IS NULL OR provider_key = $6)
         )
         SELECT 'model' AS dimension, model AS key, period,
                COALESCE(SUM(cost_usd) FILTER (WHERE cost_status <> 'unpriced'), 0) AS cost,
                SUM(tokens) AS tokens,
                COUNT(*) FILTER (WHERE cost_status = 'priced') AS priced_events,
                COUNT(*) FILTER (WHERE cost_status = 'unpriced') AS unpriced_events,
                COUNT(*) FILTER (WHERE cost_status = 'legacy') AS legacy_events
         FROM scoped GROUP BY model, period
         UNION ALL
         SELECT 'provider' AS dimension, provider_key AS key, period,
                COALESCE(SUM(cost_usd) FILTER (WHERE cost_status <> 'unpriced'), 0),
                SUM(tokens),
                COUNT(*) FILTER (WHERE cost_status = 'priced'),
                COUNT(*) FILTER (WHERE cost_status = 'unpriced'),
                COUNT(*) FILTER (WHERE cost_status = 'legacy')
         FROM scoped GROUP BY provider_key, period`,
        params,
      ),
    ]);

    const aggregates: InsightAggregateRow[] = aggregateResult.rows.map((r) => ({
      kind: r.kind,
      period: r.period,
      position: r.position,
      costUsd: n(r.cost),
      sessions: n(r.sessions),
      totalTokens: n(r.tokens),
      costCoverage: costCoverage(r),
    }));
    const compositions: InsightCompositionRow[] = compositionResult.rows.map((r) => ({
      dimension: r.dimension,
      key: r.key,
      period: r.period,
      costUsd: n(r.cost),
      totalTokens: n(r.tokens),
      costCoverage: costCoverage(r),
    }));
    return buildUserInsightComparison(aggregates, compositions);
  }

  // 버킷×모델 시계열 — dailyQuery 와 동일한 버킷 규약에 model 차원 추가 (스탯 뷰 스택 막대)
  async getUserModelTimeseries(userId: string, q: PeriodQuery & BucketOptions): Promise<ModelDailyPoint[]> {
    const { where, params } = this.periodWhere({ ...q, userId });
    params.push(q.timezone ?? this.tz);
    const bucketExpr = this.bucketExpr(q.bucket, `$${params.length}`);
    const res = await this.pool.query(
      `SELECT ${bucketExpr} AS day,
              COALESCE(model,'(unknown)') AS model,
              COALESCE(SUM(cost_usd) FILTER (WHERE cost_status <> 'unpriced'),0) AS cost,
              COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens),0) AS tokens
       FROM usage_events ${where}
       GROUP BY 1, 2 ORDER BY 1, cost DESC`,
      params,
    );
    return res.rows.map((r) => ({ day: r.day, model: r.model, costUsd: n(r.cost), totalTokens: n(r.tokens) }));
  }

  // 시간 버킷 고정 시계열 — 히트맵은 기간의 표시 버킷(day)과 무관하게 항상 hour 로 그린다
  getUserHourlyTimeseries(userId: string, q: PeriodQuery & { timezone?: string }): Promise<DailyPoint[]> {
    return this.dailyQuery({ ...q, userId, bucket: "hour" });
  }

  // 내 기기 목록 — 기간·provider 무관 전체 이력(유휴 기기도 노출). host 는 raw(NULL 보존).
  async getUserHosts(userId: string): Promise<DeviceInfo[]> {
    const res = await this.pool.query(
      `SELECT host, MAX(ts) AS last_seen_at, COUNT(*) AS event_count
       FROM usage_events
       WHERE user_id = $1
       GROUP BY host ORDER BY last_seen_at DESC`,
      [userId],
    );
    return res.rows.map((r) => ({
      host: r.host ?? null,
      lastSeenAt: new Date(r.last_seen_at),
      eventCount: n(r.event_count),
    }));
  }

  // 세션별 사용량 요약 — 히스토리 목록의 앱레벨 조인(본문=PG 고정, 사용량=백엔드 가변).
  // user_id 를 함께 조건에 걸어 타인 세션 id 를 넘겨도 아무것도 새지 않는다.
  async getSessionUsageSummaries(userId: string, sessionIds: string[]): Promise<SessionUsageSummary[]> {
    if (sessionIds.length === 0) return [];
    const res = await this.pool.query(
      `SELECT session_id,
              COALESCE(array_agg(DISTINCT model) FILTER (WHERE model IS NOT NULL), '{}') AS models,
              COALESCE(array_agg(DISTINCT host)  FILTER (WHERE host  IS NOT NULL), '{}') AS hosts,
              COALESCE(SUM(input_tokens),0)          AS input,
              COALESCE(SUM(output_tokens),0)         AS output,
              COALESCE(SUM(cache_read_tokens),0)     AS cache_read,
              COALESCE(SUM(cache_creation_tokens),0) AS cache_creation,
              COALESCE(SUM(cost_usd) FILTER (WHERE cost_status <> 'unpriced'),0) AS cost,
              COUNT(*)                               AS events,
              COUNT(*) FILTER (WHERE cost_status = 'priced') AS priced_events,
              COUNT(*) FILTER (WHERE cost_status = 'unpriced') AS unpriced_events,
              COUNT(*) FILTER (WHERE cost_status = 'legacy') AS legacy_events
       FROM usage_events
       WHERE user_id = $1 AND session_id = ANY($2)
       GROUP BY session_id`,
      [userId, sessionIds],
    );
    return res.rows.map((r) => ({
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

  // 한 세션의 사용 이벤트(ts ASC) — 히스토리 상세에서 assistant 턴과 ts 근접 매칭.
  async getSessionUsageEvents(userId: string, sessionId: string): Promise<SessionUsageEventRow[]> {
    const res = await this.pool.query(
      `SELECT ts, model, input_tokens, output_tokens,
              cache_read_tokens, cache_creation_tokens, cost_usd, cost_status
       FROM usage_events
       WHERE user_id = $1 AND session_id = $2
       ORDER BY ts ASC`,
      [userId, sessionId],
    );
    return res.rows.map((r) => ({
      ts: new Date(r.ts),
      model: r.model ?? null,
      inputTokens: n(r.input_tokens),
      outputTokens: n(r.output_tokens),
      cacheReadTokens: n(r.cache_read_tokens),
      cacheCreationTokens: n(r.cache_creation_tokens),
      costUsd: n(r.cost_usd),
      costStatus: r.cost_status,
    }));
  }

  async getLeaderboard(q: PeriodQuery & { scope: LeaderScope; teamId?: string; orderBy?: "cost" | "tokens" }): Promise<LeaderRow[]> {
    const { where, params } = this.periodWhere(q);
    const ePrefixed = where
      .replace(/ts /g, "e.ts ")
      .replace(/provider_key /g, "e.provider_key ")
      .replace(/user_id /g, "e.user_id ")
      .replace(/team_id /g, "e.team_id ");
    const orderColumn = q.orderBy === "tokens" ? "tokens" : "cost";
    const sql =
      q.scope === "user"
        ? `SELECT u.id AS key, COALESCE(u.name, u.email) AS label,
                  COALESCE(SUM(e.cost_usd) FILTER (WHERE e.cost_status <> 'unpriced'),0) AS cost,
                  COALESCE(SUM(e.input_tokens + e.output_tokens + e.cache_read_tokens + e.cache_creation_tokens),0) AS tokens,
                  COUNT(DISTINCT e.session_id) AS sessions,
                  COUNT(*) FILTER (WHERE e.cost_status = 'priced') AS priced_events,
                  COUNT(*) FILTER (WHERE e.cost_status = 'unpriced') AS unpriced_events,
                  COUNT(*) FILTER (WHERE e.cost_status = 'legacy') AS legacy_events
           FROM usage_events e JOIN users u ON u.id = e.user_id
           ${ePrefixed}
           GROUP BY u.id, label ORDER BY ${orderColumn} DESC LIMIT 100`
        : `SELECT d.id AS key, d.name AS label,
                  COALESCE(SUM(e.cost_usd) FILTER (WHERE e.cost_status <> 'unpriced'),0) AS cost,
                  COALESCE(SUM(e.input_tokens + e.output_tokens + e.cache_read_tokens + e.cache_creation_tokens),0) AS tokens,
                  COUNT(DISTINCT e.session_id) AS sessions,
                  COUNT(*) FILTER (WHERE e.cost_status = 'priced') AS priced_events,
                  COUNT(*) FILTER (WHERE e.cost_status = 'unpriced') AS unpriced_events,
                  COUNT(*) FILTER (WHERE e.cost_status = 'legacy') AS legacy_events
           FROM usage_events e JOIN teams d ON d.id = e.team_id
           ${ePrefixed} AND e.team_id IS NOT NULL
           GROUP BY d.id, d.name ORDER BY ${orderColumn} DESC LIMIT 100`;
    const res = await this.pool.query(sql, params);
    return res.rows.map((r) => ({
      key: String(r.key), label: r.label, costUsd: n(r.cost),
      totalTokens: n(r.tokens), sessions: n(r.sessions),
      costCoverage: costCoverage(r),
    }));
  }

  async getProviderBreakdown(q: PeriodQuery & { teamId?: string }): Promise<ProviderBreakdown[]> {
    const { where, params } = this.periodWhere(q);
    const res = await this.pool.query(
      `SELECT provider_key,
              COALESCE(SUM(cost_usd) FILTER (WHERE cost_status <> 'unpriced'),0) AS cost,
              COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens),0) AS tokens,
              COUNT(DISTINCT session_id) AS sessions,
              COUNT(*) FILTER (WHERE cost_status = 'priced') AS priced_events,
              COUNT(*) FILTER (WHERE cost_status = 'unpriced') AS unpriced_events,
              COUNT(*) FILTER (WHERE cost_status = 'legacy') AS legacy_events
       FROM usage_events ${where}
       GROUP BY provider_key ORDER BY tokens DESC`,
      params,
    );
    return res.rows.map((r) => ({
      providerKey: r.provider_key,
      costUsd: n(r.cost),
      totalTokens: n(r.tokens),
      sessions: n(r.sessions),
      costCoverage: costCoverage(r),
    }));
  }
}
