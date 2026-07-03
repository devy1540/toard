/** OTLP LogRecord 를 flat 화한 형태 */
export interface FlatLogRecord {
  resourceAttrs: Record<string, string | number | boolean>;
  scopeName: string | null;
  /** event.name (예: 'claude_code.api_request') */
  eventName: string | null;
  /** 발생 시각 (UTC) */
  ts: Date;
  attrs: Record<string, string | number | boolean>;
}

/** OTLP metric 데이터포인트를 flat 화한 형태 (Sum·Gauge) */
export interface FlatMetricPoint {
  resourceAttrs: Record<string, string | number | boolean>;
  scopeName: string | null;
  /** metric 이름 (예: 'claude_code.token.usage') */
  metricName: string;
  /** 발생 시각 (UTC) — startTimeUnixNano 우선(세션 시작 고정) */
  ts: Date;
  /** 데이터포인트 속성 (예: type=input|output|cacheRead|cacheCreation, model, session.id) */
  attrs: Record<string, string | number | boolean>;
  value: number;
}

export interface NormalizeContext {
  /** 인증 토큰으로 확정된 user_id (SSOT — 설계 §10.1) */
  userId: string | null;
}

/**
 * 정규화 결과 — 비용 미확정.
 * 라우트가 `pricing.resolveCost`(토큰 + providedCostUsd + isFast)로 costUsd 를 채워
 * `@toard/core` 의 `UsageEvent` 로 완성한다 (설계 §5.5: 정규화와 비용은 별도 단계).
 */
export interface NormalizedUsage {
  dedupKey: string;
  providerKey: string;
  userId: string | null;
  sessionId: string | null;
  model: string | null;
  ts: Date;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** 프로바이더 제공 비용 (Claude 제공, Codex 없음) */
  providedCostUsd: number | null;
  isFast: boolean;
}

export interface ProviderNormalizer {
  providerKey: string;
  normalize(records: FlatLogRecord[], ctx: NormalizeContext): NormalizedUsage[];
}

/**
 * metrics 경로 정규화기 (Claude Code 2.x — 토큰/비용이 metrics 로만 옴).
 * 반환하는 NormalizedUsage 는 **세션 누적값**이며, dedupKey 는 (session, model) 기준이라
 * 라우트가 `saveMetricUsageEvents`(upsert-최신누적)로 저장한다 — 반복 export 로 인한 과다집계 방지.
 */
export interface MetricsNormalizer {
  providerKey: string;
  normalize(points: FlatMetricPoint[], ctx: NormalizeContext): NormalizedUsage[];
}
