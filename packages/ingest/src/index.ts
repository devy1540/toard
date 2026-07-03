export * from "./types";
export * from "./otlp";
export * from "./provider";
export * from "./dedup";

import { claudeNormalizer } from "./normalizers/claude";
import { codexNormalizer } from "./normalizers/codex";
import type { ProviderNormalizer } from "./types";

export { claudeNormalizer, codexNormalizer };

/** providerKey → normalizer 디스패치 테이블 */
export const normalizers: Record<string, ProviderNormalizer> = {
  claude_code: claudeNormalizer,
  codex: codexNormalizer,
};
