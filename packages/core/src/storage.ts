// StorageBackend — 수집·대시보드가 의존하는 유일한 데이터 액세스 계약 (설계 §4.1, ADR-003).
// 메타(users/teams) CRUD·인증은 인터페이스 밖(항상 PG). 여기는 "이벤트 저장 + 분석 쿼리"만.

export interface PeriodQuery {
  /** UTC, inclusive */
  from: Date;
  /** UTC, exclusive */
  to: Date;
  /** 미지정 = 전체 프로바이더 */
  providerKey?: string;
}

export interface InsightComparisonQuery {
  current: { from: Date; to: Date };
  previous: { from: Date; to: Date };
  providerKey?: string;
  timezone: string;
}

export interface InsightMetricSummary {
  costUsd: number;
  sessions: number;
  totalTokens: number;
  costCoverage: UsageCostCoverage;
}

export interface InsightTrendPoint {
  position: number;
  current: InsightMetricSummary;
  previous: InsightMetricSummary;
}

export interface InsightCompositionChange {
  key: string;
  current: { costUsd: number; totalTokens: number; costCoverage: UsageCostCoverage };
  previous: { costUsd: number; totalTokens: number; costCoverage: UsageCostCoverage };
}

export interface UserInsightComparison {
  current: InsightMetricSummary;
  previous: InsightMetricSummary;
  trend: InsightTrendPoint[];
  byModel: InsightCompositionChange[];
  byProvider: InsightCompositionChange[];
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
  /** cacheCreationTokens 중 1시간 TTL 분량(subset). pricing 전용 힌트 — 서버가 1h=input×2,
   *  5m=input×1.25 로 차등 가격(§design-usage-pull 리스크 B). pull(claude) 경로만 채움,
   *  없으면 0(전량 5m 로 취급). DB 미영속(cost 는 인제스트 시 확정·저장). */
  cacheCreation1hTokens?: number;
  /** pricing 엔진이 채움 */
  costUsd: number;
  /** logfile 경로 전용(§5.6): shim 벤더 어댑터 식별자. otel 경로는 없음/ null */
  logAdapter?: string | null;
  /** 발생 컴퓨터(호스트) 라벨 — shim 이 채움(자동 hostname 또는 TOARD_HOST_LABEL).
   *  신뢰경계 밖 서술 메타데이터(검증 대상 아님). 미상/비활성 시 없음/null. */
  host?: string | null;
}

export type UsageCostStatus = "priced" | "unpriced" | "legacy";

/** 비용 합계가 어떤 가격 확정 상태의 이벤트로 구성됐는지 설명한다. */
export interface UsageCostCoverage {
  pricedEvents: number;
  unpricedEvents: number;
  legacyEvents: number;
}

/** 서버가 이벤트 시각 기준 가격 revision으로 비용을 확정한 저장 계약. */
export interface FinalizedUsageEvent extends UsageEvent {
  pricingRevisionId: string | null;
  costStatus: UsageCostStatus;
}

export interface OverviewStats {
  totalSessions: number;
  /** 기간 내 DISTINCT user */
  activeUsers: number;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  /** 캐시 토큰 — input/output 과 별개 합계. 토큰 카드의 "토큰 대비 비용" 힌트용. */
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  costCoverage: UsageCostCoverage;
}

/** 시계열 버킷 단위 — 하루짜리 기간은 분/시간 단위로 내려 점 하나 대신 곡선을 그린다. */
export type TimeBucket = "day" | "hour" | "30m" | "15m";

/**
 * 시계열 버킷 옵션 — 표출은 뷰어 타임존을 따른다 (ADR-008 개정).
 * `timezone`(IANA)을 넘기면 해당 벽시계로 일/시간 경계를 자르고, 미지정 시 백엔드
 * 생성자에 주입된 조직 타임존을 쓴다. 유효성 검증은 호출자(앱) 책임.
 */
export interface BucketOptions {
  bucket?: TimeBucket;
  timezone?: string;
}

export interface DailyPoint {
  /**
   * 버킷 키 — 쿼리의 `timezone`(미지정 시 백엔드 기본 = 조직 타임존) 벽시계 기준 (ADR-008).
   * bucket='day'(기본) 은 'YYYY-MM-DD', 나머지는 'YYYY-MM-DD HH:mm'.
   */
  day: string;
  sessions: number;
  activeUsers: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/** 팀 구성원별 버킷 시계열 포인트 — team 현황의 구성원별 추이용. */
export interface TeamMemberTimeseriesPoint extends DailyPoint {
  userId: string;
}

/** 버킷×모델 시계열 포인트 — 스탯 뷰의 모델별 스택 막대용. 키 규약은 DailyPoint.day 와 동일. */
export interface ModelDailyPoint {
  day: string;
  model: string;
  costUsd: number;
  /** 총 소모 토큰 = input+output+cache_read+cache_creation (과금 대상 전체) */
  totalTokens: number;
}

export interface ModelBreakdown {
  model: string;
  costUsd: number;
  /** 총 소모 토큰 = input+output+cache_read+cache_creation (과금 대상 전체) */
  totalTokens: number;
  sessions: number;
  costCoverage: UsageCostCoverage;
}

/** 프로바이더별 사용량 분해 — 워크스페이스 전체 기간 범위. */
export interface ProviderBreakdown {
  providerKey: string;
  costUsd: number;
  /** 총 소모 토큰 = input+output+cache_read+cache_creation */
  totalTokens: number;
  sessions: number;
  costCoverage: UsageCostCoverage;
}

/** 컴퓨터(호스트)별 사용량 분해 — 기간-스코프. host=null 은 "(알 수 없음)"(라벨링은 UI). */
export interface HostBreakdown {
  host: string | null;
  costUsd: number;
  /** 총 소모 토큰 = input+output+cache_read+cache_creation (과금 대상 전체) */
  totalTokens: number;
  sessions: number;
  costCoverage: UsageCostCoverage;
}

/** 내 기기 목록 1행 — 기간 무관(유휴 기기도 노출). host=null 은 "(알 수 없음)". */
export interface DeviceInfo {
  host: string | null;
  /** 마지막 수신 시각 (UTC) */
  lastSeenAt: Date;
  /** 전체 이력의 이벤트 수 */
  eventCount: number;
}

/** 세션별 사용량 요약 — 내 히스토리 목록의 앱레벨 조인용.
 *  본문(prompt_records)은 항상 PG, 사용량은 백엔드 가변(PG/CH)이라 SQL 조인 대신
 *  이 메서드로 세션 id 묶음을 조회해 앱에서 합친다(§design-prompt-content). */
export interface SessionUsageSummary {
  sessionId: string;
  /** DISTINCT 모델 (빈 값 제외) */
  models: string[];
  /** DISTINCT 호스트 (빈 값 제외) */
  hosts: string[];
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  eventCount: number;
  costCoverage: UsageCostCoverage;
}

/** 세션 내 개별 사용 이벤트 — 히스토리 상세의 턴별(ts 근접) 매칭용 최소 필드. */
export interface SessionUsageEventRow {
  ts: Date;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  costStatus: UsageCostStatus;
}

export interface LeaderRow {
  /** userId 또는 teamId */
  key: string;
  /** 표시 이름 */
  label: string;
  costUsd: number;
  /** 총 소모 토큰 = input+output+cache_read+cache_creation (과금 대상 전체) */
  totalTokens: number;
  sessions: number;
  costCoverage: UsageCostCoverage;
}

export type LeaderScope = "user" | "team";
export type TimeseriesScope = "all" | "team";
export type LeaderOrder = "cost" | "tokens";

export interface SaveResult {
  inserted: number;
  deduped: number;
}

export interface UnpricedUsageModelDiagnostic {
  model: string | null;
  events: number;
  firstAt: Date;
  lastAt: Date;
}

export type PricingRepairResolver = (
  event: UsageEvent,
) => { costUsd: number; pricingRevisionId: string } | null;

export interface PricingRepairRequest {
  from: Date;
  to: Date;
  models: string[];
  /** 근거 없는 과거 revision으로 계산되어 authoritative revision으로 교체할 대상. */
  replaceRevisionIds: string[];
  limit: number;
  generation: string;
}

export interface PricingRepairBatchResult {
  scanned: number;
  recovered: number;
  affectedBuckets: Date[];
  hasMore: boolean;
}

export interface UsageReplayReconciliationRequest {
  from: Date;
  to: Date;
  limit: number;
}

export interface UsageReplayReconciliationResult {
  scanned: number;
  reconciled: number;
  /** 이번 삭제가 반영된 뒤 보존 범위에 남은 전체 unpriced 이벤트 수. */
  remainingUnpriced: number;
  affectedBuckets: Date[];
  hasMore: boolean;
}

export interface UserUsage {
  overview: OverviewStats;
  daily: DailyPoint[];
  byModel: ModelBreakdown[];
  /** 컴퓨터(호스트)별 분해 — 기간-스코프 (§design-host-breakdown) */
  byHost: HostBreakdown[];
}

export interface StorageBackend {
  // ── 쓰기 (수집 파이프라인) ──
  /** OTLP 원형을 무손실 보존하고 raw id 반환 */
  saveRawEvent(providerKey: string, payload: unknown): Promise<number>;
  /** 멱등 저장(dedup) + 당일 Mart 증분(SUM 지표) — 동일 트랜잭션 */
  saveUsageEvents(events: FinalizedUsageEvent[]): Promise<SaveResult>;
  /** 마감된 날짜의 Mart 전체 재계산(SUM+DISTINCT) — dirty 집합 대상 */
  recomputeDaily(days: Array<{ day: string }>): Promise<void>;
  /** 보존 범위 안에서 아직 가격이 확정되지 않은 모델별 진단. */
  getUnpricedUsageModels(
    from: Date,
    to: Date,
    replaceRevisionIds?: string[],
  ): Promise<UnpricedUsageModelDiagnostic[]>;
  /** 가격표로 확정 가능한 unpriced 이벤트만 제한된 batch로 복구한다. */
  repairUnpricedUsage(
    request: PricingRepairRequest,
    resolver: PricingRepairResolver,
  ): Promise<PricingRepairBatchResult>;
  /** 모델 문맥 전에 재생된 Codex 사용량 중 모델이 있는 원본과 정확히 일치하는 행만 보정한다. */
  reconcileCodexReplayUsage(
    request: UsageReplayReconciliationRequest,
  ): Promise<UsageReplayReconciliationResult>;

  // ── 읽기 (대시보드) ──
  /** userId 또는 teamId 지정 시 해당 사용자/팀 스코프. */
  getOverview(q: PeriodQuery & { userId?: string; teamId?: string }): Promise<OverviewStats>;
  getDailyTimeseries(
    q: PeriodQuery & BucketOptions & { scope?: TimeseriesScope; teamId?: string },
  ): Promise<DailyPoint[]>;
  /** 선택한 팀 구성원별 버킷 시계열. 호출자는 표시할 사용자 수를 제한한다. */
  getTeamMemberTimeseries(
    q: PeriodQuery & BucketOptions & { teamId: string; userIds: string[] },
  ): Promise<TeamMemberTimeseriesPoint[]>;
  getUserUsage(userId: string, q: PeriodQuery & BucketOptions): Promise<UserUsage>;
  getUserInsightComparison(userId: string, q: InsightComparisonQuery): Promise<UserInsightComparison>;
  /** 내 사용량 — 버킷×모델 시계열 (스탯 뷰 스택 막대) */
  getUserModelTimeseries(userId: string, q: PeriodQuery & BucketOptions): Promise<ModelDailyPoint[]>;
  /** 내 사용량 — 시간 버킷 고정 시계열 (스탯 뷰 시간대 히트맵 — 기간의 표시 버킷과 무관) */
  getUserHourlyTimeseries(userId: string, q: PeriodQuery & { timezone?: string }): Promise<DailyPoint[]>;
  getLeaderboard(q: PeriodQuery & { scope: LeaderScope; teamId?: string; orderBy?: LeaderOrder }): Promise<LeaderRow[]>;
  /** 워크스페이스/팀의 프로바이더별 분해 — 기간·provider 필터 적용. */
  getProviderBreakdown(q: PeriodQuery & { teamId?: string }): Promise<ProviderBreakdown[]>;
  /** 내 기기 목록 — 기간 무관 전체 이력(유휴 기기도 노출, §design-host-breakdown). */
  getUserHosts(userId: string): Promise<DeviceInfo[]>;
  /** 내 세션들의 사용량 요약 — 히스토리 목록의 앱레벨 조인. sessionIds 는 페이지 단위 소량 전제. */
  getSessionUsageSummaries(userId: string, sessionIds: string[]): Promise<SessionUsageSummary[]>;
  /** 한 세션의 사용 이벤트 목록(ts ASC) — 히스토리 상세의 턴별 매칭용. */
  getSessionUsageEvents(userId: string, sessionId: string): Promise<SessionUsageEventRow[]>;
}
