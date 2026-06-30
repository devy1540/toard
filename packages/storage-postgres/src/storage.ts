import type {
  DailyPoint,
  LeaderRow,
  LeaderScope,
  ModelBreakdown,
  OverviewStats,
  PeriodQuery,
  SaveResult,
  StorageBackend,
  TimeseriesScope,
  UsageEvent,
  UserUsage,
} from "@toard/core";
import { Pool, type PoolClient } from "pg";

const KST = "Asia/Seoul";

/** pg 는 NUMERIC/BIGINT 를 string 으로 반환 → number 변환 */
const n = (v: unknown): number => (v == null ? 0 : Number(v));

type ScopedQuery = PeriodQuery & { userId?: string };

export class PostgresStorage implements StorageBackend {
  constructor(private readonly pool: Pool) {}

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
    return { where: `WHERE ${conds.join(" AND ")}`, params };
  }

  // ── 쓰기 ──
  async saveRawEvent(providerKey: string, payload: unknown): Promise<number> {
    const res = await this.pool.query<{ id: string }>(
      "INSERT INTO raw_events (provider_key, payload) VALUES ($1, $2) RETURNING id",
      [providerKey, JSON.stringify(payload)],
    );
    return Number(res.rows[0]!.id);
  }

  async saveUsageEvents(events: UsageEvent[]): Promise<SaveResult> {
    if (events.length === 0) return { inserted: 0, deduped: 0 };
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      let inserted = 0;
      for (const e of events) {
        const r = await client.query(
          `INSERT INTO usage_events
             (dedup_key, provider_key, user_id, session_id, model, ts,
              input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (dedup_key) DO NOTHING`,
          [
            e.dedupKey, e.providerKey, e.userId, e.sessionId, e.model, e.ts,
            e.inputTokens, e.outputTokens, e.cacheReadTokens, e.cacheCreationTokens, e.costUsd,
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

  /** 당일 SUM 지표 증분 (sessions 등 DISTINCT 는 recomputeDaily 가 채움 — 설계 §4.4) */
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
      [e.userId, e.ts, KST, e.providerKey,
       e.inputTokens, e.outputTokens, e.cacheReadTokens, e.cacheCreationTokens, e.costUsd],
    );
  }

  /** 마감 재계산 (DELETE 후 usage_events 에서 SUM+DISTINCT 재INSERT — 설계 §4.4) */
  async recomputeDaily(days: Array<{ day: string }>): Promise<void> {
    for (const { day } of days) {
      await this.pool.query("DELETE FROM usage_daily_user WHERE day = $1::date", [day]);
      await this.pool.query(
        `INSERT INTO usage_daily_user
           (user_id, day, provider_key, request_count, sessions,
            input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd)
         SELECT user_id, $1::date, provider_key,
                COUNT(*), COUNT(DISTINCT session_id),
                SUM(input_tokens), SUM(output_tokens), SUM(cache_read_tokens),
                SUM(cache_creation_tokens), SUM(cost_usd)
         FROM usage_events
         WHERE user_id IS NOT NULL
           AND (ts AT TIME ZONE 'Asia/Seoul')::date = $1::date
         GROUP BY user_id, provider_key`,
        [day],
      );
      // TODO(1차): usage_daily_department 도 동일 패턴으로 재계산.
    }
  }

  // ── 읽기 ──
  private async overviewQuery(q: ScopedQuery): Promise<OverviewStats> {
    const { where, params } = this.periodWhere(q);
    const res = await this.pool.query(
      `SELECT COUNT(DISTINCT session_id) AS sessions,
              COUNT(DISTINCT user_id)    AS active_users,
              COALESCE(SUM(cost_usd),0)  AS cost,
              COALESCE(SUM(input_tokens),0)  AS input,
              COALESCE(SUM(output_tokens),0) AS output
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
    };
  }

  private async dailyQuery(q: ScopedQuery): Promise<DailyPoint[]> {
    const { where, params } = this.periodWhere(q);
    const res = await this.pool.query(
      `SELECT to_char((ts AT TIME ZONE 'Asia/Seoul')::date, 'YYYY-MM-DD') AS day,
              COUNT(DISTINCT session_id) AS sessions,
              COALESCE(SUM(cost_usd),0)  AS cost,
              COALESCE(SUM(input_tokens),0)  AS input,
              COALESCE(SUM(output_tokens),0) AS output
       FROM usage_events ${where}
       GROUP BY 1 ORDER BY 1`,
      params,
    );
    return res.rows.map((r) => ({
      day: r.day, sessions: n(r.sessions), costUsd: n(r.cost),
      inputTokens: n(r.input), outputTokens: n(r.output),
    }));
  }

  private async modelBreakdown(q: ScopedQuery): Promise<ModelBreakdown[]> {
    const { where, params } = this.periodWhere(q);
    const res = await this.pool.query(
      `SELECT COALESCE(model,'(unknown)') AS model,
              COALESCE(SUM(cost_usd),0)   AS cost,
              COALESCE(SUM(input_tokens + output_tokens),0) AS tokens,
              COUNT(DISTINCT session_id)  AS sessions
       FROM usage_events ${where}
       GROUP BY 1 ORDER BY cost DESC`,
      params,
    );
    return res.rows.map((r) => ({
      model: r.model, costUsd: n(r.cost), totalTokens: n(r.tokens), sessions: n(r.sessions),
    }));
  }

  getOverview(q: PeriodQuery): Promise<OverviewStats> {
    return this.overviewQuery(q);
  }

  // 부서 필터(scope='department')는 user_id ∈ 부서 소속으로 좁힌다 — 1차는 전체/사용자 경로 우선.
  getDailyTimeseries(
    q: PeriodQuery & { scope?: TimeseriesScope; departmentId?: string },
  ): Promise<DailyPoint[]> {
    return this.dailyQuery(q);
  }

  async getUserUsage(userId: string, q: PeriodQuery): Promise<UserUsage> {
    const scoped: ScopedQuery = { ...q, userId };
    const [overview, daily, byModel] = await Promise.all([
      this.overviewQuery(scoped),
      this.dailyQuery(scoped),
      this.modelBreakdown(scoped),
    ]);
    return { overview, daily, byModel };
  }

  async getLeaderboard(q: PeriodQuery & { scope: LeaderScope }): Promise<LeaderRow[]> {
    const { where, params } = this.periodWhere(q);
    const sql =
      q.scope === "user"
        ? `SELECT u.id AS key, COALESCE(u.name, u.email) AS label,
                  COALESCE(SUM(e.cost_usd),0) AS cost,
                  COALESCE(SUM(e.input_tokens + e.output_tokens),0) AS tokens,
                  COUNT(DISTINCT e.session_id) AS sessions
           FROM usage_events e JOIN users u ON u.id = e.user_id
           ${where.replace(/ts /g, "e.ts ").replace(/provider_key /g, "e.provider_key ").replace(/user_id /g, "e.user_id ")}
           GROUP BY u.id, label ORDER BY cost DESC LIMIT 100`
        : `SELECT d.id AS key, d.name AS label,
                  COALESCE(SUM(e.cost_usd),0) AS cost,
                  COALESCE(SUM(e.input_tokens + e.output_tokens),0) AS tokens,
                  COUNT(DISTINCT e.session_id) AS sessions
           FROM usage_events e
             JOIN users u ON u.id = e.user_id
             JOIN departments d ON d.id = u.department_id
           ${where.replace(/ts /g, "e.ts ").replace(/provider_key /g, "e.provider_key ").replace(/user_id /g, "e.user_id ")}
           GROUP BY d.id, d.name ORDER BY cost DESC LIMIT 100`;
    const res = await this.pool.query(sql, params);
    return res.rows.map((r) => ({
      key: String(r.key), label: r.label, costUsd: n(r.cost),
      totalTokens: n(r.tokens), sessions: n(r.sessions),
    }));
  }
}
