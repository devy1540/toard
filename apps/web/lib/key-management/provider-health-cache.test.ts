import assert from "node:assert/strict";
import test from "node:test";
import {
  ProviderHealthCache,
  runProviderCanary,
} from "./provider-health-cache";
import { providerError } from "./provider-error";
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

test("canary는 provider의 안전한 allowlisted error code만 보존한다", async () => {
  const safeFailureProvider: KeyManagementProvider = {
    name: "aws-kms",
    keyRef: "test:aws-key",
    fingerprint: "aws-kms:safe-failure",
    async wrapKey(): Promise<WrappedUserKey> {
      throw providerError("aws-kms", "THROTTLED");
    },
    async unwrapKey(): Promise<Buffer> {
      throw new Error("unused");
    },
    async healthCheck(): Promise<KeyProviderHealth> {
      throw new Error("unused");
    },
    async describeCredentialSource(): Promise<CredentialSourceSummary> {
      return { kind: "test", staticCredential: false };
    },
  };

  const transient = await runProviderCanary(safeFailureProvider);
  assert.equal(transient.status, "unhealthy");
  if (transient.status === "unhealthy") {
    assert.equal(transient.errorCode, "THROTTLED");
  }

  for (const message of [
    "aws-kms:THROTTLED",
    "aws-kms:UNKNOWN",
    "aws-kms:TEMPORARY requestId=secret",
    "gcp-kms:TEMPORARY",
    "secret provider detail",
  ]) {
    const unsafeFailureProvider: KeyManagementProvider = {
      ...safeFailureProvider,
      async wrapKey(): Promise<WrappedUserKey> {
        throw new Error(message);
      },
    };
    const result = await runProviderCanary(unsafeFailureProvider);
    assert.equal(result.status, "unhealthy");
    if (result.status === "unhealthy") {
      assert.equal(result.errorCode, "PROVIDER_CANARY_FAILED");
      assert.equal(JSON.stringify(result).includes("secret"), false);
    }
  }

  const maliciousError = new Error("placeholder");
  Object.defineProperty(maliciousError, "message", {
    get() {
      throw new Error("message getter secret");
    },
  });
  const hostileProvider: KeyManagementProvider = {
    ...safeFailureProvider,
    async wrapKey(): Promise<WrappedUserKey> {
      throw maliciousError;
    },
  };
  const hostileResult = await runProviderCanary(hostileProvider);
  assert.equal(hostileResult.status, "unhealthy");
  if (hostileResult.status === "unhealthy") {
    assert.equal(hostileResult.errorCode, "PROVIDER_CANARY_FAILED");
  }
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

test("health cache는 TTL보다 오래 pending이어도 canary를 중복 시작하지 않고 settled 시점부터 TTL을 센다", async () => {
  let now = 0;
  let release!: () => void;
  const provider = new CanaryProvider();
  provider.pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const cache = new ProviderHealthCache({ ttlMs: 100, now: () => now });

  const first = cache.check(provider);
  now = 1_000;
  const stillPending = cache.check(provider);
  assert.equal(first, stillPending);
  await Promise.resolve();
  assert.equal(provider.wrapCalls, 1);

  release();
  await first;
  provider.pending = null;
  now = 1_099;
  await cache.check(provider);
  assert.equal(provider.wrapCalls, 1);
  now = 1_100;
  await cache.check(provider);
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

test("health cache는 check promise 예외를 안전한 unhealthy로 바꾸고 TTL 뒤 재검사한다", async () => {
  let attempts = 0;
  let now = 0;
  const provider = new CanaryProvider();
  const cache = new ProviderHealthCache({
    ttlMs: 10,
    now: () => now,
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

  const failed = await cache.check(provider);
  assert.equal(failed.status, "unhealthy");
  assert.equal(JSON.stringify(failed).includes("transient secret detail"), false);
  now = 10;
  assert.equal((await cache.check(provider)).status, "healthy");
  assert.equal(attempts, 2);
});

test("health cache는 clock throw, NaN, rollback에서 원문 없이 안전하게 refresh한다", async () => {
  const provider = new CanaryProvider();
  const values: Array<number | Error> = [
    100,
    new Error("clock secret"),
    Number.NaN,
    50,
  ];
  const cache = new ProviderHealthCache({
    now: () => {
      const value = values.shift()!;
      if (value instanceof Error) throw value;
      return value;
    },
  });

  assert.equal((await cache.check(provider)).status, "healthy");
  assert.equal((await cache.check(provider)).status, "healthy");
  assert.equal((await cache.check(provider)).status, "healthy");
  assert.equal((await cache.check(provider)).status, "healthy");
  assert.equal(provider.wrapCalls, 4);
});

test("canary dependency 예외와 invalid clock/date는 항상 안전한 unhealthy로 resolve한다", async () => {
  const provider = new CanaryProvider();
  for (const dependencies of [
    {
      randomBytes: () => {
        throw new Error("rng secret");
      },
    },
    {
      randomBytes: () => Buffer.alloc(32, 1),
      now: () => {
        throw new Error("clock secret");
      },
    },
    {
      randomBytes: () => Buffer.alloc(32, 1),
      now: () => Number.NaN,
    },
    {
      randomBytes: () => Buffer.alloc(32, 1),
      checkedAt: () => {
        throw new Error("date secret");
      },
    },
    {
      randomBytes: () => Buffer.alloc(32, 1),
      checkedAt: () => new Date(Number.NaN),
    },
  ]) {
    const result = await runProviderCanary(provider, dependencies);
    assert.equal(result.status, "unhealthy");
    assert.equal(Number.isFinite(result.checkedAt.getTime()), true);
    assert.equal(JSON.stringify(result).includes("secret"), false);
  }
});
