import assert from "node:assert/strict";
import test from "node:test";
import { UserKeyCache } from "./user-key-cache";

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
