import assert from "node:assert/strict";
import test from "node:test";
import {
  ProviderHealthCache,
  runProviderCanary,
} from "./provider-health-cache";
import type {
  CredentialSourceSummary,
  KeyContext,
  KeyManagementProvider,
  KeyProviderHealth,
  WrappedUserKey,
} from "./types";

class CanaryProvider implements KeyManagementProvider {
  readonly name = "local" as const;
  readonly keyRef = "test:key";
  readonly fingerprint = "local:health";
  wrapCalls = 0;
  unwrapCalls = 0;
  healthCalls = 0;
  mismatch = false;
  fail = false;
  pending: Promise<void> | null = null;
  lastWrappedInput: Buffer | null = null;
  lastUnwrappedOutput: Buffer | null = null;

  async wrapKey(uck: Buffer, _context: KeyContext): Promise<WrappedUserKey> {
    this.wrapCalls += 1;
    this.lastWrappedInput = uck;
    if (this.pending) await this.pending;
    if (this.fail) throw new Error("secret provider detail");
    return {
      provider: this.name,
      keyRef: this.keyRef,
      fingerprint: this.fingerprint,
      ciphertext: Buffer.from(uck),
      metadata: {},
    };
  }

  async unwrapKey(wrapped: WrappedUserKey, _context: KeyContext): Promise<Buffer> {
    this.unwrapCalls += 1;
    const output = Buffer.from(wrapped.ciphertext);
    if (this.mismatch) output[0] = output[0]! ^ 0xff;
    this.lastUnwrappedOutput = output;
    return output;
  }

  async healthCheck(): Promise<KeyProviderHealth> {
    this.healthCalls += 1;
    throw new Error("provider healthCheck must not be called");
  }

  async describeCredentialSource(): Promise<CredentialSourceSummary> {
    return { kind: "test", staticCredential: false };
  }
}

test("canary는 wrap/unwrap 결과를 constant-time 비교하고 두 key buffer를 zeroize한다", async () => {
  const provider = new CanaryProvider();
  const random = Buffer.alloc(32, 9);
  const result = await runProviderCanary(provider, {
    randomBytes: () => random,
    now: (() => {
      let value = 100;
      return () => value++;
    })(),
  });

  assert.equal(result.status, "healthy");
  assert.equal(provider.wrapCalls, 1);
  assert.equal(provider.unwrapCalls, 1);
  assert.equal(provider.healthCalls, 0);
  assert.deepEqual(random, Buffer.alloc(32));
  assert.deepEqual(provider.lastUnwrappedOutput, Buffer.alloc(32));
});

test("canary mismatch와 provider 예외는 detail 없는 안전한 unhealthy result다", async () => {
  const mismatch = new CanaryProvider();
  mismatch.mismatch = true;
  const mismatchResult = await runProviderCanary(mismatch);
  assert.deepEqual(mismatchResult.status, "unhealthy");
  if (mismatchResult.status === "unhealthy") {
    assert.equal(mismatchResult.errorCode, "PROVIDER_CANARY_FAILED");
  }

  const failed = new CanaryProvider();
  failed.fail = true;
  const failedResult = await runProviderCanary(failed);
  assert.deepEqual(failedResult.status, "unhealthy");
  assert.equal(JSON.stringify(failedResult).includes("secret provider detail"), false);
});

test("health cache는 fingerprint별 60초 TTL과 concurrent single-flight를 보장한다", async () => {
  let now = 1_000;
  let release!: () => void;
  const provider = new CanaryProvider();
  provider.pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const cache = new ProviderHealthCache({ now: () => now });

  const first = cache.check(provider);
  const concurrent = cache.check(provider);
  release();
  assert.equal((await first).status, "healthy");
  assert.equal((await concurrent).status, "healthy");
  assert.equal(provider.wrapCalls, 1);

  assert.equal((await cache.check(provider)).status, "healthy");
  assert.equal(provider.wrapCalls, 1);
  now += 60_000;
  provider.pending = null;
  assert.equal((await cache.check(provider)).status, "healthy");
  assert.equal(provider.wrapCalls, 2);
});

test("health cache는 실패 후 inflight를 정리하고 clock rollback에도 stale 결과를 쓰지 않는다", async () => {
  let now = 10_000;
  const provider = new CanaryProvider();
  provider.fail = true;
  const cache = new ProviderHealthCache({ ttlMs: 100, now: () => now });

  assert.equal((await cache.check(provider)).status, "unhealthy");
  assert.equal(provider.wrapCalls, 1);
  now = 9_000;
  provider.fail = false;
  assert.equal((await cache.check(provider)).status, "healthy");
  assert.equal(provider.wrapCalls, 2);
});

test("health cache는 invalid TTL을 거부한다", () => {
  for (const ttlMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => new ProviderHealthCache({ ttlMs }),
      /PROVIDER_HEALTH_TTL_INVALID/,
    );
  }
});

test("health cache는 check promise 예외 뒤 stale inflight를 제거한다", async () => {
  let attempts = 0;
  const provider = new CanaryProvider();
  const cache = new ProviderHealthCache({
    check: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient secret detail");
      return {
        status: "healthy",
        latencyMs: 1,
        checkedAt: new Date(0),
      };
    },
  });

  await assert.rejects(cache.check(provider), /transient secret detail/);
  assert.equal((await cache.check(provider)).status, "healthy");
  assert.equal(attempts, 2);
});
