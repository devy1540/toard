import {
  randomBytes as nodeRandomBytes,
  timingSafeEqual,
} from "node:crypto";
import type {
  KeyContext,
  KeyManagementProvider,
  KeyProviderHealth,
} from "./types";

const CANARY_CONTEXT: KeyContext = Object.freeze({
  installationId: "00000000-0000-0000-0000-000000000000",
  userId: "00000000-0000-0000-0000-000000000000",
  keyVersion: 1,
  purpose: "prompt-history",
});

type CanaryDependencies = {
  randomBytes?: (size: number) => Buffer;
  now?: () => number;
  checkedAt?: () => Date;
};

function safeLatency(startedAt: number, finishedAt: number): number {
  const latency = finishedAt - startedAt;
  return Number.isFinite(latency) && latency >= 0 ? latency : 0;
}

function finiteNow(now: () => number): number | null {
  try {
    const value = now();
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function validCheckedAt(checkedAt: () => Date): Date | null {
  try {
    const value = checkedAt();
    return value instanceof Date && Number.isFinite(value.getTime())
      ? value
      : null;
  } catch {
    return null;
  }
}

function unhealthyHealth(
  latencyMs: number,
  checkedAt: Date,
  errorCode = "PROVIDER_CANARY_FAILED",
): KeyProviderHealth {
  return {
    status: "unhealthy",
    latencyMs,
    checkedAt,
    errorCode,
  };
}

const SAFE_PROVIDER_ERROR_CODES = new Set([
  "AUTH_FAILED",
  "EMPTY_CIPHERTEXT",
  "EMPTY_PLAINTEXT",
  "FAILED",
  "INVALID_CIPHERTEXT",
  "INVALID_PLAINTEXT",
  "KEY_DISABLED",
  "KEY_INVALID_STATE",
  "KEY_MISMATCH",
  "KEY_NOT_FOUND",
  "RESPONSE_INVALID",
  "TEMPORARY",
  "THROTTLED",
  "WRAPPER_MISMATCH",
]);

function safeProviderErrorCode(
  provider: KeyManagementProvider,
  error: unknown,
): string {
  try {
    if (!(error instanceof Error) || typeof error.message !== "string") {
      return "PROVIDER_CANARY_FAILED";
    }
    const prefix = `${provider.name}:`;
    if (!error.message.startsWith(prefix)) return "PROVIDER_CANARY_FAILED";
    const code = error.message.slice(prefix.length);
    return SAFE_PROVIDER_ERROR_CODES.has(code)
      ? code
      : "PROVIDER_CANARY_FAILED";
  } catch {
    return "PROVIDER_CANARY_FAILED";
  }
}

export async function runProviderCanary(
  provider: KeyManagementProvider,
  dependencies: CanaryDependencies = {},
): Promise<KeyProviderHealth> {
  const now = dependencies.now ?? performance.now.bind(performance);
  const checkedAt = dependencies.checkedAt ?? (() => new Date());
  let uck: Buffer | null = null;
  let unwrapped: Buffer | null = null;
  let startedAt: number | null = null;
  try {
    startedAt = finiteNow(now);
    if (startedAt === null) throw new Error("PROVIDER_CANARY_CLOCK_INVALID");
    uck = (dependencies.randomBytes ?? nodeRandomBytes)(32);
    if (!Buffer.isBuffer(uck) || uck.length !== 32) {
      throw new Error("PROVIDER_CANARY_RANDOM_INVALID");
    }
    const wrapped = await provider.wrapKey(uck, CANARY_CONTEXT);
    unwrapped = await provider.unwrapKey(wrapped, CANARY_CONTEXT);
    if (
      !Buffer.isBuffer(unwrapped)
      || unwrapped.length !== uck.length
      || !timingSafeEqual(uck, unwrapped)
    ) {
      throw new Error("PROVIDER_CANARY_MISMATCH");
    }
    const finishedAt = finiteNow(now);
    const resultCheckedAt = validCheckedAt(checkedAt);
    if (finishedAt === null || resultCheckedAt === null) {
      throw new Error("PROVIDER_CANARY_REPORT_INVALID");
    }
    return {
      status: "healthy",
      latencyMs: safeLatency(startedAt, finishedAt),
      checkedAt: resultCheckedAt,
    };
  } catch (error) {
    const finishedAt = startedAt === null ? null : finiteNow(now);
    return unhealthyHealth(
      startedAt !== null && finishedAt !== null
        ? safeLatency(startedAt, finishedAt)
        : 0,
      validCheckedAt(checkedAt) ?? new Date(0),
      safeProviderErrorCode(provider, error),
    );
  } finally {
    uck?.fill(0);
    unwrapped?.fill(0);
  }
}

type ProviderHealthCacheInput = {
  ttlMs?: number;
  now?: () => number;
  check?: (provider: KeyManagementProvider) => Promise<KeyProviderHealth>;
};

type CacheEntry = {
  pending: boolean;
  startedAt: number | null;
  settledAt: number | null;
  promise: Promise<KeyProviderHealth>;
};

export class ProviderHealthCache {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly runCheck: (
    provider: KeyManagementProvider,
  ) => Promise<KeyProviderHealth>;
  private readonly entries = new Map<string, CacheEntry>();

  constructor(input: ProviderHealthCacheInput = {}) {
    const ttlMs = input.ttlMs ?? 60_000;
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new Error("PROVIDER_HEALTH_TTL_INVALID");
    }
    this.ttlMs = ttlMs;
    this.now = input.now ?? Date.now;
    this.runCheck = input.check ?? runProviderCanary;
  }

  check(provider: KeyManagementProvider): Promise<KeyProviderHealth> {
    const cached = this.entries.get(provider.fingerprint);
    if (cached?.pending) return cached.promise;

    const currentTime = finiteNow(this.now);
    if (
      cached
      && currentTime !== null
      && cached.settledAt !== null
      && currentTime >= cached.settledAt
      && currentTime - cached.settledAt < this.ttlMs
    ) {
      return cached.promise;
    }
    if (cached) this.entries.delete(provider.fingerprint);

    let entry!: CacheEntry;
    const promise = Promise.resolve()
      .then(() => this.runCheck(provider))
      .catch(() => unhealthyHealth(0, new Date(0)))
      .then((result) => {
        entry.pending = false;
        const settledAt = finiteNow(this.now);
        if (
          entry.startedAt === null
          || settledAt === null
          || settledAt < entry.startedAt
        ) {
          if (this.entries.get(provider.fingerprint) === entry) {
            this.entries.delete(provider.fingerprint);
          }
        } else {
          entry.settledAt = settledAt;
        }
        return result;
      });
    entry = {
      pending: true,
      startedAt: currentTime,
      settledAt: null,
      promise,
    };
    this.entries.set(provider.fingerprint, entry);
    return promise;
  }
}
