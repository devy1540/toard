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
