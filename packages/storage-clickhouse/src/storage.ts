import { type ClickHouseClient, createClient } from "@clickhouse/client";
import type {
  BucketOptions,
  DailyPoint,
  DeviceInfo,
  HostBreakdown,
  LeaderRow,
  LeaderScope,
  ModelBreakdown,
  OverviewStats,
  PeriodQuery,
  SaveResult,
  SessionUsageEventRow,
  SessionUsageSummary,
  StorageBackend,
  TimeseriesScope,
  UsageEvent,
  UserUsage,
} from "@toard/core";
import { Pool } from "pg";

/** CH/PG 는 큰 수·Decimal 을 string 으로 반환 → number 변환 */
const n = (v: unknown): number => (v == null ? 0 : Number(v));

/** UTC Date → ClickHouse DateTime64 문자열 'YYYY-MM-DD HH:mm:ss.SSS' */
const chTs = (d: Date): string => d.toISOString().replace("T", " ").replace("Z", "");

type ScopedQuery = PeriodQuery & { userId?: string; teamId?: string };
type Params = Record<string, unknown>;

export interface ClickHouseStorageOptions {
  /** 조직 타임존 (IANA, ADR-008) — 쿼리에 timezone 미지정 시 버킷 폴백. 기본 UTC. */
  timezone?: string;
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

/**
 * ClickHouse 저장 백엔드 (설계 §4.3, ADR-003 옵트인).
 * 이벤트·집계는 CH(ReplacingMergeTree, 읽기 시 FINAL), 메타(이름)는 PG 에서 머지.
 * 팀 귀속은 수집 시점 team_id 를 이벤트에 비정규화해 CH 단독 GROUP BY 로 성립.
 */
export class ClickHouseStorage implements StorageBackend {
  private readonly tz: string;

  constructor(
    private readonly ch: ClickHouseClient,
    private readonly pg: Pool,
    opts: ClickHouseStorageOptions = {},
  ) {
    this.tz = safeTimezone(opts.timezone);
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

  private async queryJson<T>(query: string, query_params: Params): Promise<T[]> {
    const rs = await this.ch.query({ query, query_params, format: "JSONEachRow" });
    return rs.json<T>();
  }

  // ── 쓰기 ──
  private rawSeq = 0;

  async saveRawEvent(providerKey: string, payload: unknown): Promise<number> {
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

    // 1) 기존 dedup_key 확인 — ReplacingMergeTree 는 물리 중복을 허용하므로 inserted 카운트를
    //    위해 사전 조회한다. 단 사전조회+INSERT 가 원자적이지 않아 동시 요청이 같은 dedup_key 를
    //    보내면 카운트가 과대될 수 있다(읽기 FINAL 로 집계 정확성은 유지). CH 모드의 inserted 는 근사치.
    const existing = await this.existingKeys(events.map((e) => e.dedupKey));
    const fresh = events.filter((e) => !existing.has(e.dedupKey));
    if (fresh.length === 0) return { inserted: 0, deduped: events.length };

    // 2) user_id → team_id (PG, 수집 시점 스냅샷)
    const deptMap = await this.teamMap(
      fresh.map((e) => e.userId).filter((x): x is string => !!x),
    );

    // 3) INSERT
    await this.ch.insert({
      table: "usage_events",
      values: fresh.map((e) => ({
        dedup_key: e.dedupKey,
        provider_key: e.providerKey,
        user_id: e.userId ?? "",
        team_id: e.userId ? (deptMap.get(e.userId) ?? "") : "",
        session_id: e.sessionId ?? "",
        model: e.model ?? "",
        ts: chTs(e.ts),
        input_tokens: e.inputTokens,
        output_tokens: e.outputTokens,
        cache_read_tokens: e.cacheReadTokens,
        cache_creation_tokens: e.cacheCreationTokens,
        cost_usd: e.costUsd,
        log_adapter: e.logAdapter ?? "",
        host: e.host ?? "",
      })),
      format: "JSONEachRow",
    });
    return { inserted: fresh.length, deduped: events.length - fresh.length };
  }

  private async existingKeys(keys: string[]): Promise<Set<string>> {
    const rows = await this.queryJson<{ dedup_key: string }>(
      "SELECT DISTINCT dedup_key FROM usage_events WHERE dedup_key IN {keys:Array(String)}",
      { keys },
    );
    return new Set(rows.map((r) => r.dedup_key));
  }

  private async teamMap(userIds: string[]): Promise<Map<string, string>> {
    if (userIds.length === 0) return new Map();
    const uniq = [...new Set(userIds)];
    const rs = await this.pg.query<{ id: string; team_id: string | null }>(
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
    const { where, params } = this.periodWhere(q);
    const rows = await this.queryJson<AggRow>(
      `SELECT uniqExactIf(session_id, session_id != '') AS sessions,
              uniqExactIf(user_id, user_id != '')       AS active_users,
              sum(cost_usd)     AS cost,
              sum(input_tokens) AS input,
              sum(output_tokens) AS output,
              sum(cache_read_tokens)     AS cache_read,
              sum(cache_creation_tokens) AS cache_creation
       FROM usage_events FINAL ${where}`,
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
    const { where, params } = this.periodWhere(q);
    // 버킷 타임존 — 요청(뷰어) 타임존 우선, 없으면 조직 타임존 (ADR-008 개정). 리터럴 삽입이라 재검증 필수.
    const tz = safeTimezone(q.timezone, this.tz);
    // bucket='hour' 는 분 이하를 자른 포맷으로 그룹핑 — 키 'YYYY-MM-DD HH:00' (storage 계약 참조)
    const bucketExpr =
      q.bucket === "hour"
        ? `formatDateTime(ts, '%Y-%m-%d %H:00', '${tz}')`
        : `toString(toDate(ts, '${tz}'))`;
    const rows = await this.queryJson<{ day: string } & AggRow>(
      `SELECT ${bucketExpr}                                   AS day,
              uniqExactIf(session_id, session_id != '')       AS sessions,
              sum(cost_usd)     AS cost,
              sum(input_tokens) AS input,
              sum(output_tokens) AS output,
              sum(cache_read_tokens)     AS cache_read,
              sum(cache_creation_tokens) AS cache_creation
       FROM usage_events FINAL ${where}
       GROUP BY day ORDER BY day`,
      params,
    );
    return rows.map((r) => ({
      day: r.day,
      sessions: n(r.sessions),
      costUsd: n(r.cost),
      inputTokens: n(r.input),
      outputTokens: n(r.output),
      cacheReadTokens: n(r.cache_read),
      cacheCreationTokens: n(r.cache_creation),
    }));
  }

  private async modelBreakdown(q: ScopedQuery): Promise<ModelBreakdown[]> {
    const { where, params } = this.periodWhere(q);
    const rows = await this.queryJson<{ model: string; cost?: string; tokens?: string; sessions?: string }>(
      `SELECT if(model = '', '(unknown)', model)               AS model,
              sum(cost_usd)                                     AS cost,
              sum(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens) AS tokens,
              uniqExactIf(session_id, session_id != '')         AS sessions
       FROM usage_events FINAL ${where}
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

  // 컴퓨터(호스트)별 분해 — modelBreakdown 동형. 빈 문자열('') 은 nullIf 로 NULL 정규화해
  // PG 의 NULL 과 동일하게 UI "(알 수 없음)" 버킷으로 접힌다.
  private async hostBreakdown(q: ScopedQuery): Promise<HostBreakdown[]> {
    const { where, params } = this.periodWhere(q);
    const rows = await this.queryJson<{ host: string | null; cost?: string; tokens?: string; sessions?: string }>(
      `SELECT nullIf(host, '')                                 AS host,
              sum(cost_usd)                                     AS cost,
              sum(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens) AS tokens,
              uniqExactIf(session_id, session_id != '')         AS sessions
       FROM usage_events FINAL ${where}
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

  getOverview(q: PeriodQuery & { userId?: string }): Promise<OverviewStats> {
    return this.overviewQuery(q);
  }

  getDailyTimeseries(
    q: PeriodQuery & BucketOptions & { scope?: TimeseriesScope; teamId?: string },
  ): Promise<DailyPoint[]> {
    return this.dailyQuery(q);
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

  // 내 기기 목록 — 기간·provider 무관 전체 이력(유휴 기기도 노출). '' → NULL 정규화.
  async getUserHosts(userId: string): Promise<DeviceInfo[]> {
    const rows = await this.queryJson<{ host: string | null; last_seen_at: string; event_count?: string }>(
      `SELECT nullIf(host, '')  AS host,
              max(ts)           AS last_seen_at,
              count()           AS event_count
       FROM usage_events FINAL
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
       FROM usage_events FINAL
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
       FROM usage_events FINAL
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

  async getLeaderboard(q: PeriodQuery & { scope: LeaderScope }): Promise<LeaderRow[]> {
    const { where, params } = this.periodWhere(q);
    const col = q.scope === "user" ? "user_id" : "team_id";
    const rows = await this.queryJson<{ key: string; cost?: string; tokens?: string; sessions?: string }>(
      `SELECT ${col} AS key,
              sum(cost_usd)                             AS cost,
              sum(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens) AS tokens,
              uniqExactIf(session_id, session_id != '') AS sessions
       FROM usage_events FINAL ${where} AND ${col} != ''
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

/** 환경변수로 CH 클라이언트를 구성해 스토리지를 만든다 (메타용 PG 풀은 주입). */
export function createClickHouseStorage(pg: Pool, opts: ClickHouseStorageOptions = {}): ClickHouseStorage {
  const ch = createClient({
    url: process.env.CLICKHOUSE_URL ?? "http://localhost:8123",
    username: process.env.CLICKHOUSE_USER ?? "toard",
    password: process.env.CLICKHOUSE_PASSWORD ?? "toard",
    database: process.env.CLICKHOUSE_DB ?? "toard",
  });
  return new ClickHouseStorage(ch, pg, opts);
}
