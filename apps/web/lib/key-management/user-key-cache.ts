import type {
  CacheResultEvent,
  KeyOperation,
} from "./observability";
import type { KeyProviderName } from "./types";

const USER_KEY_LENGTH = 32;

type UserKeyCacheOptions = {
  ttlMs: number;
  now?: () => number;
  recordCacheResult?: (event: CacheResultEvent) => Promise<void>;
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
  private readonly now: () => number;
  private readonly recordResult?: (event: CacheResultEvent) => Promise<void>;

  constructor(options: UserKeyCacheOptions) {
    this.ttlMs = options.ttlMs;
    this.now = options.now ?? Date.now;
    this.recordResult = options.recordCacheResult;
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
    this.inflight.delete(cacheKey);
    if (!flight) this.generations.delete(cacheKey);
  }

  private async loadWorkingCopy(
    cacheKey: string,
    loader: () => Promise<Buffer>,
    observation: CacheObservationIdentity | undefined,
  ): Promise<Buffer> {
    const entry = this.entries.get(cacheKey);
    if (entry) {
      if (entry.expiresAt > this.now()) {
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
