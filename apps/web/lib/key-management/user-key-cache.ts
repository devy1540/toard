const USER_KEY_LENGTH = 32;

type UserKeyCacheOptions = {
  ttlMs: number;
  now?: () => number;
};

type UserKeyCacheEntry = {
  key: Buffer;
  expiresAt: number;
};

export class UserKeyCache {
  private readonly entries = new Map<string, UserKeyCacheEntry>();
  private readonly inflight = new Map<string, Promise<Buffer>>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: UserKeyCacheOptions) {
    this.ttlMs = options.ttlMs;
    this.now = options.now ?? Date.now;
  }

  async withKey<T>(
    cacheKey: string,
    loader: () => Promise<Buffer>,
    fn: (key: Buffer) => Promise<T> | T,
  ): Promise<T> {
    const key = await this.load(cacheKey, loader);
    return fn(key);
  }

  evict(cacheKey: string): void {
    const entry = this.entries.get(cacheKey);
    entry?.key.fill(0);
    this.entries.delete(cacheKey);
  }

  private async load(cacheKey: string, loader: () => Promise<Buffer>): Promise<Buffer> {
    const entry = this.entries.get(cacheKey);
    if (entry) {
      if (entry.expiresAt > this.now()) return entry.key;
      this.evict(cacheKey);
    }

    const current = this.inflight.get(cacheKey);
    if (current) return current;

    const pending = (async () => {
      const key = await loader();
      if (!Buffer.isBuffer(key) || key.length !== USER_KEY_LENGTH) {
        if (Buffer.isBuffer(key)) key.fill(0);
        throw new Error("USER_KEY_LENGTH_INVALID");
      }
      this.entries.set(cacheKey, {
        key,
        expiresAt: this.now() + this.ttlMs,
      });
      return key;
    })();
    this.inflight.set(cacheKey, pending);
    try {
      return await pending;
    } finally {
      if (this.inflight.get(cacheKey) === pending) {
        this.inflight.delete(cacheKey);
      }
    }
  }
}
