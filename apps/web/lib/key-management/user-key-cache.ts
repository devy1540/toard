import type {
  CacheResultEvent,
  KeyOperation,
} from "./observability";
import type { KeyProviderName } from "./types";

const USER_KEY_LENGTH = 32;
const DEFAULT_CACHE_CAPACITY = 256;

type ExpiryTimer = ReturnType<typeof setTimeout>;

type UserKeyCacheOptions = {
  ttlMs: number;
  capacity?: number;
  now?: () => number;
  recordCacheResult?: (event: CacheResultEvent) => Promise<void>;
  setTimeout?: (callback: () => void, delay: number) => ExpiryTimer;
  clearTimeout?: (timer: ExpiryTimer) => void;
};

export type CacheObservationIdentity = Readonly<{
  provider: KeyProviderName;
  fingerprint: string;
  operation: KeyOperation;
}>;

type UserKeyCacheEntry = {
  key: Buffer;
  expiresAt: number;
};

type InflightUserKeyLoad = {
  generation: number;
  promise: Promise<Buffer>;
  waiters: number;
  settled: boolean;
  source?: Buffer;
};

export class UserKeyCache {
  private readonly entries = new Map<string, UserKeyCacheEntry>();
  private readonly inflight = new Map<string, InflightUserKeyLoad>();
  private readonly generations = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly capacity: number;
  private readonly now: () => number;
  private readonly recordResult?: (event: CacheResultEvent) => Promise<void>;
  private readonly scheduleTimeout: (callback: () => void, delay: number) => ExpiryTimer;
  private readonly cancelTimeout: (timer: ExpiryTimer) => void;
  private expiryTimer: ExpiryTimer | undefined;

  constructor(options: UserKeyCacheOptions) {
    this.ttlMs = options.ttlMs;
    this.capacity = options.capacity ?? DEFAULT_CACHE_CAPACITY;
    if (!Number.isSafeInteger(this.capacity) || this.capacity < 1) {
      throw new Error("USER_KEY_CACHE_CAPACITY_INVALID");
    }
    this.now = options.now ?? Date.now;
    this.recordResult = options.recordCacheResult;
    this.scheduleTimeout = options.setTimeout ?? setTimeout;
    this.cancelTimeout = options.clearTimeout ?? clearTimeout;
  }

  async withKey<T>(
    cacheKey: string,
    loader: () => Promise<Buffer>,
    fn: (key: Buffer) => Promise<T> | T,
    observation?: CacheObservationIdentity,
  ): Promise<T> {
    const workingKey = await this.loadWorkingCopy(cacheKey, loader, observation);
    try {
      return await fn(workingKey);
    } finally {
      workingKey.fill(0);
    }
  }

  evict(cacheKey: string): void {
    const flight = this.inflight.get(cacheKey);
    this.generations.set(cacheKey, this.generation(cacheKey) + 1);
    const entry = this.entries.get(cacheKey);
    entry?.key.fill(0);
    this.entries.delete(cacheKey);
    this.rescheduleExpiry();
    this.inflight.delete(cacheKey);
    if (!flight) this.generations.delete(cacheKey);
  }

  clear(): void {
    for (const [cacheKey, entry] of this.entries) {
      this.generations.set(cacheKey, this.generation(cacheKey) + 1);
      entry.key.fill(0);
    }
    this.entries.clear();
    for (const [cacheKey, flight] of this.inflight) {
      this.generations.set(cacheKey, this.generation(cacheKey) + 1);
      this.inflight.delete(cacheKey);
      this.cleanupLoad(cacheKey, flight);
    }
    this.clearExpiryTimer();
    if (this.inflight.size === 0) this.generations.clear();
  }

  private async loadWorkingCopy(
    cacheKey: string,
    loader: () => Promise<Buffer>,
    observation: CacheObservationIdentity | undefined,
  ): Promise<Buffer> {
    const entry = this.entries.get(cacheKey);
    if (entry) {
      if (entry.expiresAt > this.now()) {
        this.entries.delete(cacheKey);
        this.entries.set(cacheKey, entry);
        this.observe(observation, "hit");
        return Buffer.from(entry.key);
      }
      this.evict(cacheKey);
    }

    const existingFlight = this.inflight.get(cacheKey);
    const flight = existingFlight ?? this.startLoad(cacheKey, loader);
    flight.waiters += 1;
    try {
      this.observe(observation, existingFlight ? "single_flight" : "miss");
      const source = await flight.promise;
      return Buffer.from(source);
    } finally {
      flight.waiters -= 1;
      this.cleanupLoad(cacheKey, flight);
    }
  }

  private startLoad(
    cacheKey: string,
    loader: () => Promise<Buffer>,
  ): InflightUserKeyLoad {
    const flight = {
      generation: this.generation(cacheKey),
      waiters: 0,
      settled: false,
    } as InflightUserKeyLoad;
    flight.promise = (async () => {
      const source = await loader();
      if (!Buffer.isBuffer(source) || source.length !== USER_KEY_LENGTH) {
        if (Buffer.isBuffer(source)) source.fill(0);
        throw new Error("USER_KEY_LENGTH_INVALID");
      }
      flight.source = source;
      if (
        flight.generation === this.generation(cacheKey)
        && this.inflight.get(cacheKey) === flight
      ) {
        this.entries.set(cacheKey, {
          key: Buffer.from(source),
          expiresAt: this.now() + this.ttlMs,
        });
        this.enforceCapacity();
        this.rescheduleExpiry();
      }
      return source;
    })().finally(() => {
      flight.settled = true;
      this.cleanupLoad(cacheKey, flight);
    });
    this.inflight.set(cacheKey, flight);
    return flight;
  }

  private cleanupLoad(cacheKey: string, flight: InflightUserKeyLoad): void {
    if (!flight.settled || flight.waiters !== 0) return;
    flight.source?.fill(0);
    flight.source = undefined;
    if (this.inflight.get(cacheKey) === flight) {
      this.inflight.delete(cacheKey);
    }
    if (!this.entries.has(cacheKey) && !this.inflight.has(cacheKey)) {
      this.generations.delete(cacheKey);
    }
  }

  private generation(cacheKey: string): number {
    return this.generations.get(cacheKey) ?? 0;
  }

  private enforceCapacity(): void {
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.entries().next().value as
        | [string, UserKeyCacheEntry]
        | undefined;
      if (!oldest) return;
      const [cacheKey, entry] = oldest;
      entry.key.fill(0);
      this.entries.delete(cacheKey);
      if (!this.inflight.has(cacheKey)) this.generations.delete(cacheKey);
    }
  }

  private rescheduleExpiry(): void {
    this.clearExpiryTimer();
    let expiresAt: number | undefined;
    for (const entry of this.entries.values()) {
      if (expiresAt === undefined || entry.expiresAt < expiresAt) expiresAt = entry.expiresAt;
    }
    if (expiresAt === undefined) return;
    const delay = Math.max(0, expiresAt - this.now());
    const timer = this.scheduleTimeout(() => {
      if (this.expiryTimer !== timer) return;
      this.expiryTimer = undefined;
      this.expireEntries();
      this.rescheduleExpiry();
    }, delay);
    this.expiryTimer = timer;
    (timer as unknown as { unref?: () => unknown }).unref?.();
  }

  private expireEntries(): void {
    const now = this.now();
    for (const [cacheKey, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        entry.key.fill(0);
        this.entries.delete(cacheKey);
        if (!this.inflight.has(cacheKey)) this.generations.delete(cacheKey);
      }
    }
  }

  private clearExpiryTimer(): void {
    if (!this.expiryTimer) return;
    this.cancelTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
  }

  private observe(
    identity: CacheObservationIdentity | undefined,
    cacheResult: CacheResultEvent["cacheResult"],
  ): void {
    if (!this.recordResult || !identity) return;
    try {
      const provider = identity.provider;
      const fingerprint = identity.fingerprint;
      const operation = identity.operation;
      if (
        ![
          "local", "aws-kms", "gcp-kms", "azure-key-vault", "vault-transit", "openbao-transit",
        ].includes(provider)
        || typeof fingerprint !== "string"
        || !new RegExp(`^${provider}:[0-9a-f]{24}$`).test(fingerprint)
        || !["wrap", "unwrap", "health"].includes(operation)
      ) return;
      void Promise.resolve(this.recordResult(Object.freeze({
        provider,
        fingerprint,
        operation,
        cacheResult,
      }))).catch(() => undefined);
    } catch {
      // Cache metrics must never affect key availability or cache lifecycle.
    }
  }
}
