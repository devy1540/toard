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
  assert.equal(loadedKeys[0]!.every((byte) => byte === 1), true);

  clock.advance(300_001);
  await cache.withKey("u:1", load, async (key) => assert.equal(key[0], 2));
  assert.equal(loads, 2);
  assert.equal(loadedKeys[0]!.every((byte) => byte === 0), true);
});

test("loader 실패는 cache하지 않고 다음 호출에서 다시 시도한다", async () => {
  let loads = 0;
  const cache = new UserKeyCache({ ttlMs: 300_000 });
  const load = async () => {
    loads += 1;
    if (loads === 1) throw new Error("KMS_UNAVAILABLE");
    return Buffer.alloc(32, 7);
  };

  await assert.rejects(cache.withKey("u:1", load, async () => undefined), /KMS_UNAVAILABLE/);
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
