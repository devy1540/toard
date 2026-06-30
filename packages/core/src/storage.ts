// StorageBackend — 수집·대시보드가 의존하는 유일한 데이터 액세스 계약 (설계 §4.1, ADR-003).
// 메타(users/departments) CRUD·인증은 인터페이스 밖(항상 PG). 여기는 "이벤트 저장 + 분석 쿼리"만.

export interface PeriodQuery {
  /** UTC, inclusive */
  from: Date;
  /** UTC, exclusive */
  to: Date;
  /** 미지정 = 전체 프로바이더 */
  providerKey?: string;
}

/**
 * 정규화된 사용 이벤트 — 모든 프로바이더가 이 형태로 수렴.
 *
 * 불변식: `inputTokens`는 항상 "캐시 제외 신규 입력 토큰".
 *  - Claude: cache_read/creation 이 input 과 별개(가산)
 *  - OpenAI/Codex: cached 가 input 의 부분집합 → Codex normalizer 가
 *    `inputTokens = input_token_count - cached_token_count` 로 보정한다.
 */
export interface UsageEvent {
  /** hash(request_id, model, tokens). request_id 없으면 hash(session.id, event.sequence, ts, in+out) */
  dedupKey: string;
  providerKey: string;
  /** 미식별 시 null (등록 후 소급 매핑) */
  userId: string | null;
  sessionId: string | null;
  model: string | null;
  /** 발생 시각 (UTC) */
  ts: Date;
  /** 캐시 제외 신규 입력 */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** pricing 엔진이 채움 */
  costUsd: number;
}

export interface OverviewStats {
  totalSessions: number;
  /** 기간 내 DISTINCT user */
  activeUsers: number;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

export interface DailyPoint {
  /** 'YYYY-MM-DD' (KST) */
  day: string;
  sessions: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

export interface ModelBreakdown {
  model: string;
  costUsd: number;
  totalTokens: number;
  sessions: number;
}

export interface LeaderRow {
  /** userId 또는 departmentId */
  key: string;
  /** 표시 이름 */
  label: string;
  costUsd: number;
  totalTokens: number;
  sessions: number;
}

export type LeaderScope = "user" | "department";
export type TimeseriesScope = "all" | "department";

export interface SaveResult {
  inserted: number;
  deduped: number;
}

export interface UserUsage {
  overview: OverviewStats;
  daily: DailyPoint[];
  byModel: ModelBreakdown[];
}

export interface StorageBackend {
  // ── 쓰기 (수집 파이프라인) ──
  /** OTLP 원형을 무손실 보존하고 raw id 반환 */
  saveRawEvent(providerKey: string, payload: unknown): Promise<number>;
  /** 멱등 저장(dedup) + 당일 Mart 증분(SUM 지표) — 동일 트랜잭션 */
  saveUsageEvents(events: UsageEvent[]): Promise<SaveResult>;
  /** 마감된 날짜의 Mart 전체 재계산(SUM+DISTINCT) — dirty 집합 대상 */
  recomputeDaily(days: Array<{ day: string }>): Promise<void>;

  // ── 읽기 (대시보드) ──
  getOverview(q: PeriodQuery): Promise<OverviewStats>;
  getDailyTimeseries(
    q: PeriodQuery & { scope?: TimeseriesScope; departmentId?: string },
  ): Promise<DailyPoint[]>;
  getUserUsage(userId: string, q: PeriodQuery): Promise<UserUsage>;
  getLeaderboard(q: PeriodQuery & { scope: LeaderScope }): Promise<LeaderRow[]>;
}
