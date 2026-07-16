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

export async function runProviderCanary(
  provider: KeyManagementProvider,
  dependencies: CanaryDependencies = {},
): Promise<KeyProviderHealth> {
  const now = dependencies.now ?? performance.now.bind(performance);
  const checkedAt = dependencies.checkedAt ?? (() => new Date());
  const uck = (dependencies.randomBytes ?? nodeRandomBytes)(32);
  const startedAt = now();
  let unwrapped: Buffer | null = null;
  try {
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
    return {
      status: "healthy",
      latencyMs: safeLatency(startedAt, now()),
      checkedAt: checkedAt(),
    };
  } catch {
    return {
      status: "unhealthy",
      latencyMs: safeLatency(startedAt, now()),
      checkedAt: checkedAt(),
      errorCode: "PROVIDER_CANARY_FAILED",
    };
  } finally {
    if (Buffer.isBuffer(uck)) uck.fill(0);
    unwrapped?.fill(0);
  }
}

type ProviderHealthCacheInput = {
  ttlMs?: number;
  now?: () => number;
  check?: (provider: KeyManagementProvider) => Promise<KeyProviderHealth>;
};

type CacheEntry = {
  createdAt: number;
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
    const currentTime = this.now();
    const cached = this.entries.get(provider.fingerprint);
    if (
      cached
      && Number.isFinite(currentTime)
      && currentTime >= cached.createdAt
      && currentTime - cached.createdAt < this.ttlMs
    ) {
      return cached.promise;
    }

    const createdAt = Number.isFinite(currentTime) ? currentTime : 0;
    const entry: CacheEntry = {
      createdAt,
      promise: Promise.resolve().then(() => this.runCheck(provider)),
    };
    this.entries.set(provider.fingerprint, entry);
    entry.promise.catch(() => {
      if (this.entries.get(provider.fingerprint) === entry) {
        this.entries.delete(provider.fingerprint);
      }
    });
    return entry.promise;
  }
}
