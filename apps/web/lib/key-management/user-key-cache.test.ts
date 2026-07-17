import assert from "node:assert/strict";
import test from "node:test";
import { UserKeyCache } from "./user-key-cache";

const SAFE_IDENTITY = Object.freeze({
  provider: "local" as const,
  fingerprint: "local:abcdefabcdefabcdefabcdef",
  operation: "unwrap" as const,
});

function createClock(start = 0) {
  let current = start;
  return {
    now: () => current,
    advance(ms: number) {
      current += ms;
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("동시 cache miss는 loader 한 번으로 합쳐지고 만료 시 key를 zeroize한다", async () => {
  const clock = createClock();
  let loads = 0;
  const loadedKeys: Buffer[] = [];
  const cache = new UserKeyCache({ ttlMs: 300_000, now: clock.now });
  const load = async () => {
    loads += 1;
    const key = Buffer.alloc(32, loads);
    loadedKeys.push(key);
    return key;
  };

  const values = await Promise.all([
    cache.withKey("u:1", load, async (key) => key[0]),
    cache.withKey("u:1", load, async (key) => key[0]),
  ]);

  assert.deepEqual(values, [1, 1]);
  assert.equal(loads, 1);
  assert.equal(loadedKeys[0]!.every((byte) => byte === 0), true);

  clock.advance(300_001);
  await cache.withKey("u:1", load, async (key) => assert.equal(key[0], 2));
  assert.equal(loads, 2);
  assert.equal(loadedKeys[1]!.every((byte) => byte === 0), true);
});

test("loader 실패는 cache하지 않고 다음 호출에서 다시 시도한다", async () => {
  let loads = 0;
  let failed = true;
  const cache = new UserKeyCache({ ttlMs: 300_000 });
  const load = async () => {
    loads += 1;
    if (failed) throw new Error("KMS_UNAVAILABLE");
    return Buffer.alloc(32, 7);
  };

  await assert.rejects(cache.withKey("u:1", load, async () => undefined), /KMS_UNAVAILABLE/);
  failed = false;
  const value = await cache.withKey("u:1", load, async (key) => key[0]);

  assert.equal(value, 7);
  assert.equal(loads, 2);
});

test("loader의 32바이트가 아닌 결과를 zeroize하고 cache하지 않는다", async () => {
  let loads = 0;
  const invalid = Buffer.alloc(31, 9);
  const cache = new UserKeyCache({ ttlMs: 300_000 });
  const load = async () => {
    loads += 1;
    return loads === 1 ? invalid : Buffer.alloc(32, 4);
  };

  await assert.rejects(
    cache.withKey("u:1", load, async () => undefined),
    /USER_KEY_LENGTH_INVALID/,
  );
  assert.equal(invalid.every((byte) => byte === 0), true);
  assert.equal(await cache.withKey("u:1", load, async (key) => key[0]), 4);
  assert.equal(loads, 2);
});

test("callback은 독립 working copy를 받고 변조와 참조 보관이 cache에 영향을 주지 않는다", async () => {
  const cache = new UserKeyCache({ ttlMs: 300_000 });
  const retained: Buffer[] = [];
  const load = async () => Buffer.alloc(32, 7);

  await cache.withKey("u:1", load, async (key) => {
    retained.push(key);
    key.fill(3);
    assert.equal(key[0], 3);
  });
  const value = await cache.withKey("u:1", load, async (key) => {
    retained.push(key);
    return key[0];
  });

  assert.equal(value, 7);
  assert.equal(retained[0]!.every((byte) => byte === 0), true);
  assert.equal(retained[1]!.every((byte) => byte === 0), true);
});

test("callback throw 뒤에도 working copy를 zeroize하고 cache entry는 유지한다", async () => {
  const cache = new UserKeyCache({ ttlMs: 300_000 });
  let retained: Buffer | undefined;
  const load = async () => Buffer.alloc(32, 8);

  await assert.rejects(
    cache.withKey("u:1", load, async (key) => {
      retained = key;
      throw new Error("CALLBACK_FAILED");
    }),
    /CALLBACK_FAILED/,
  );

  assert.equal(retained!.every((byte) => byte === 0), true);
  assert.equal(await cache.withKey("u:1", load, async (key) => key[0]), 8);
});

test("callback 실행 중 eviction은 이미 전달된 working copy를 변경하지 않는다", async () => {
  const cache = new UserKeyCache({ ttlMs: 300_000 });
  let loads = 0;
  const load = async () => Buffer.alloc(32, ++loads);

  await cache.withKey("u:1", load, async () => undefined);
  const value = await cache.withKey("u:1", load, async (key) => {
    assert.equal(key[0], 1);
    cache.evict("u:1");
    assert.equal(key[0], 1);
    return key[0];
  });

  assert.equal(value, 1);
  assert.equal(await cache.withKey("u:1", load, async (key) => key[0]), 2);
});

test("inflight eviction은 이전 loader의 cache 저장을 무효화하고 다음 호출을 reload한다", async () => {
  const cache = new UserKeyCache({ ttlMs: 300_000 });
  const first = deferred<Buffer>();
  const second = deferred<Buffer>();
  const sources = [Buffer.alloc(32, 1), Buffer.alloc(32, 2)];
  let loads = 0;
  const load = async () => {
    const index = loads++;
    return index === 0 ? first.promise : second.promise;
  };

  const beforeEviction = cache.withKey("u:1", load, async (key) => key[0]);
  cache.evict("u:1");
  const afterEviction = cache.withKey("u:1", load, async (key) => key[0]);
  assert.equal(loads, 2);

  first.resolve(sources[0]!);
  second.resolve(sources[1]!);
  assert.deepEqual(await Promise.all([beforeEviction, afterEviction]), [1, 2]);
  assert.equal(sources[0]!.every((byte) => byte === 0), true);
  assert.equal(sources[1]!.every((byte) => byte === 0), true);
  assert.equal(await cache.withKey("u:1", load, async (key) => key[0]), 2);
  assert.equal(loads, 2);
});

test("공유 inflight source는 모든 waiter가 복사한 뒤 zeroize한다", async () => {
  const cache = new UserKeyCache({ ttlMs: 300_000 });
  const pending = deferred<Buffer>();
  const source = Buffer.alloc(32, 6);
  const callbackValues: number[] = [];
  const load = async () => pending.promise;

  const first = cache.withKey("u:1", load, async (key) => {
    callbackValues.push(key[0]!);
  });
  const second = cache.withKey("u:1", load, async (key) => {
    callbackValues.push(key[0]!);
  });
  pending.resolve(source);
  await Promise.all([first, second]);

  assert.deepEqual(callbackValues, [6, 6]);
  assert.equal(source.every((byte) => byte === 0), true);
});

test("명시적 eviction은 cache key를 zeroize하고 다음 호출을 reload한다", async () => {
  let loads = 0;
  let cached: Buffer | undefined;
  const cache = new UserKeyCache({ ttlMs: 300_000 });
  const load = async () => {
    loads += 1;
    cached = Buffer.alloc(32, loads);
    return cached;
  };

  await cache.withKey("u:1", load, async () => undefined);
  cache.evict("u:1");

  assert.equal(cached!.every((byte) => byte === 0), true);
  assert.equal(await cache.withKey("u:1", load, async (key) => key[0]), 2);
  assert.equal(loads, 2);
});

test("cache hook은 miss, single-flight, hit만 안전한 provider identity와 기록한다", async () => {
  const pending = deferred<Buffer>();
  const events: unknown[] = [];
  const cache = new UserKeyCache({
    ttlMs: 300_000,
    recordCacheResult: async (event) => { events.push(event); },
  });
  const loader = async () => pending.promise;
  const first = cache.withKey("installation:user:version:fingerprint", loader, async (key) => key[0], SAFE_IDENTITY);
  const second = cache.withKey("installation:user:version:fingerprint", loader, async (key) => key[0], SAFE_IDENTITY);
  pending.resolve(Buffer.alloc(32, 7));
  assert.deepEqual(await Promise.all([first, second]), [7, 7]);
  assert.equal(await cache.withKey("installation:user:version:fingerprint", loader, async (key) => key[0], SAFE_IDENTITY), 7);

  assert.deepEqual(events, [
    { ...SAFE_IDENTITY, cacheResult: "miss" },
    { ...SAFE_IDENTITY, cacheResult: "single_flight" },
    { ...SAFE_IDENTITY, cacheResult: "hit" },
  ]);
  const serialized = JSON.stringify(events);
  assert.equal(serialized.includes("installation:user"), false);
  assert.equal(serialized.includes("Buffer"), false);
});

test("cache hook failure does not break key access, TTL, or eviction", async () => {
  const clock = createClock();
  let loads = 0;
  const cache = new UserKeyCache({
    ttlMs: 10,
    now: clock.now,
    recordCacheResult: async () => { throw new Error("metrics failed"); },
  });
  const loader = async () => Buffer.alloc(32, ++loads);

  assert.equal(await cache.withKey("secret-cache-key", loader, async (key) => key[0], SAFE_IDENTITY), 1);
  assert.equal(await cache.withKey("secret-cache-key", loader, async (key) => key[0], SAFE_IDENTITY), 1);
  clock.advance(11);
  assert.equal(await cache.withKey("secret-cache-key", loader, async (key) => key[0], SAFE_IDENTITY), 2);
  cache.evict("secret-cache-key");
  assert.equal(await cache.withKey("secret-cache-key", loader, async (key) => key[0], SAFE_IDENTITY), 3);
  assert.equal(loads, 3);
});

test("cache never awaits a pending hook", async () => {
  const cache = new UserKeyCache({
    ttlMs: 300_000,
    recordCacheResult: () => new Promise<void>(() => undefined),
  });
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("TIMED_OUT")), 50));
  assert.equal(await Promise.race([
    cache.withKey("secret-cache-key", async () => Buffer.alloc(32, 9), async (key) => key[0], SAFE_IDENTITY),
    timeout,
  ]), 9);
  assert.equal(await Promise.race([
    cache.withKey("secret-cache-key", async () => Buffer.alloc(32, 8), async (key) => key[0], SAFE_IDENTITY),
    timeout,
  ]), 9);
});

test("TTL scheduler는 재접근 없이 가장 이른 entry를 zeroize하고 unref 한다", async () => {
  const clock = createClock();
  const timers: Array<{ callback: () => void; delay: number; cleared: boolean; unrefCalls: number }> = [];
  const cache = new UserKeyCache({
    ttlMs: 10,
    now: clock.now,
    setTimeout: (callback, delay) => {
      const timer = { callback, delay, cleared: false, unrefCalls: 0 };
      timers.push(timer);
      return { unref: () => { timer.unrefCalls += 1; } } as never;
    },
    clearTimeout: () => { timers[timers.length - 1]!.cleared = true; },
  });
  await cache.withKey("u:1", async () => Buffer.alloc(32, 7), async () => undefined);
  const stored = (cache as unknown as { entries: Map<string, { key: Buffer }> }).entries.get("u:1")!.key;
  assert.equal(timers.length, 1);
  assert.equal(timers[0]!.delay, 10);
  assert.equal(timers[0]!.unrefCalls, 1);
  clock.advance(10);
  timers[0]!.callback();
  assert.equal(stored.every((byte) => byte === 0), true);
  assert.equal((cache as unknown as { entries: Map<string, unknown> }).entries.has("u:1"), false);
});

test("bounded LRU capacity eviction과 clear는 buffer와 expiry timer를 zeroize한다", async () => {
  const timers: Array<{ cleared: boolean }> = [];
  const cache = new UserKeyCache({
    ttlMs: 300_000,
    capacity: 2,
    setTimeout: () => {
      const timer = { cleared: false };
      timers.push(timer);
      return { unref() {} } as never;
    },
    clearTimeout: () => { timers[timers.length - 1]!.cleared = true; },
  });
  await cache.withKey("a", async () => Buffer.alloc(32, 1), async () => undefined);
  await cache.withKey("b", async () => Buffer.alloc(32, 2), async () => undefined);
  await cache.withKey("a", async () => Buffer.alloc(32, 9), async () => undefined);
  const evicted = (cache as unknown as { entries: Map<string, { key: Buffer }> }).entries.get("b")!.key;
  await cache.withKey("c", async () => Buffer.alloc(32, 3), async () => undefined);
  assert.equal(evicted.every((byte) => byte === 0), true);
  assert.deepEqual([...((cache as unknown as { entries: Map<string, unknown> }).entries.keys())], ["a", "c"]);
  const remaining = [...(cache as unknown as { entries: Map<string, { key: Buffer }> }).entries.values()].map(({ key }) => key);
  cache.clear();
  assert.equal(remaining.every((key) => key.every((byte) => byte === 0)), true);
  assert.equal(timers.some((timer) => timer.cleared), true);
});

test("취소된 이전 expiry callback은 현재 단일 scheduler를 교체하지 않는다", async () => {
  const clock = createClock();
  const timers: Array<{ callback: () => void }> = [];
  const cache = new UserKeyCache({
    ttlMs: 10,
    now: clock.now,
    setTimeout: (callback) => {
      const timer = { callback };
      timers.push(timer);
      return { unref() {} } as never;
    },
    clearTimeout: () => undefined,
  });
  await cache.withKey("a", async () => Buffer.alloc(32, 1), async () => undefined);
  await cache.withKey("b", async () => Buffer.alloc(32, 2), async () => undefined);
  assert.equal(timers.length, 2);
  timers[0]!.callback();
  assert.equal(timers.length, 2);
});
