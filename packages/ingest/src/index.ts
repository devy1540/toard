export * from "./types";
export * from "./otlp";
export * from "./otlp-metrics";
export * from "./provider";
export * from "./dedup";

import { claudeNormalizer } from "./normalizers/claude";
import { claudeMetricsNormalizer } from "./normalizers/claude-metrics";
import { codexNormalizer } from "./normalizers/codex";
import type { MetricsNormalizer, ProviderNormalizer } from "./types";

export { claudeNormalizer, claudeMetricsNormalizer, codexNormalizer };

/** providerKey → logs normalizer 디스패치 테이블 */
export const normalizers: Record<string, ProviderNormalizer> = {
  claude_code: claudeNormalizer,
  codex: codexNormalizer,
};

/** providerKey → metrics normalizer 디스패치 테이블 (Claude Code 2.x 토큰/비용은 metrics 로만 옴) */
export const metricsNormalizers: Record<string, MetricsNormalizer> = {
  claude_code: claudeMetricsNormalizer,
};
