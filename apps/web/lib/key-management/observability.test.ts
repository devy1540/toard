import assert from "node:assert/strict";
import test from "node:test";
import {
  ObservedKeyManagementProvider,
  recordKeyOperation,
  type KeyOperationEvent,
} from "./observability";
import { providerError } from "./provider-error";
import type {
  KeyContext,
  KeyManagementProvider,
  WrappedUserKey,
} from "./types";

const UCK = Buffer.alloc(32, 0x31);
const CONTEXT: KeyContext = {
  installationId: "019f7250-dc4d-78fd-98e8-a5465d0f5b69",
  userId: "01900000-0000-7000-8000-000000000001",
  keyVersion: 1,
  purpose: "prompt-history",
};

function innerProvider(): KeyManagementProvider {
  return {
    name: "aws-kms",
    keyRef: "arn:aws:kms:ap-northeast-2:123456789012:key/redacted",
    fingerprint: "aws-kms:0123456789abcdef01234567",
    async wrapKey(uck): Promise<WrappedUserKey> {
      return {
        provider: this.name,
        keyRef: this.keyRef,
        fingerprint: this.fingerprint,
        ciphertext: Buffer.from(uck),
        metadata: { format: "test" },
      };
    },
    async unwrapKey(wrapped) { return Buffer.from(wrapped.ciphertext); },
    async healthCheck() {
      return { status: "healthy", latencyMs: 1, checkedAt: new Date(0) };
    },
    async describeCredentialSource() {
      return { kind: "test", staticCredential: false };
    },
  };
}

test("observed provider records a safe success and metrics failure does not hide crypto success", async () => {
  const events: KeyOperationEvent[] = [];
  const ticks = [100, 112];
  const provider = new ObservedKeyManagementProvider(innerProvider(), {
    now: () => ticks.shift()!,
    recorder: {
      async record(event) {
        events.push(event);
        throw new Error("metrics connection contains credential=secret");
      },
    },
  });

  const wrapped = await provider.wrapKey(UCK, CONTEXT);

  assert.equal(wrapped.provider, "aws-kms");
  assert.deepEqual(events, [{
    provider: "aws-kms",
    fingerprint: "aws-kms:0123456789abcdef01234567",
    operation: "wrap",
    outcome: "success",
    latencyMs: 12,
  }]);
  assert.deepEqual(Reflect.ownKeys(events[0]!), [
    "provider", "fingerprint", "operation", "outcome", "latencyMs",
  ]);
  assert.equal(JSON.stringify(events).includes(CONTEXT.userId), false);
  assert.equal(JSON.stringify(events).includes("credential"), false);
});

test("observed provider preserves the original provider error and maps only branded safe outcomes", async () => {
  const cases = [
    ["THROTTLED", "throttled"],
    ["AUTH_FAILED", "auth"],
    ["TEMPORARY", "unavailable"],
    ["WRAPPER_MISMATCH", "invalid"],
    ["KEY_MISMATCH", "invalid"],
    ["RESPONSE_INVALID", "invalid"],
  ] as const;
  for (const [code, outcome] of cases) {
    const inner = innerProvider();
    const original = providerError(inner.name, code);
    inner.unwrapKey = async () => { throw original; };
    const events: KeyOperationEvent[] = [];
    const provider = new ObservedKeyManagementProvider(inner, {
      now: (() => { const ticks = [5, 8]; return () => ticks.shift()!; })(),
      recorder: { async record(event) { events.push(event); } },
    });

    await assert.rejects(
      provider.unwrapKey({
        provider: inner.name,
        keyRef: inner.keyRef,
        fingerprint: inner.fingerprint,
        ciphertext: Buffer.alloc(32),
        metadata: {},
      }, CONTEXT),
      (error) => error === original,
    );
    assert.equal(events[0]?.outcome, outcome);
  }
});

test("local provider fixed validation errors are classified without recording the message", async () => {
  const inner = innerProvider();
  Object.defineProperties(inner, {
    name: { value: "local" },
    fingerprint: { value: "local:0123456789abcdef01234567" },
  });
  inner.unwrapKey = async () => { throw new Error("LOCAL_KEY_WRAPPER_MISMATCH"); };
  const events: KeyOperationEvent[] = [];
  const provider = new ObservedKeyManagementProvider(inner, {
    recorder: { async record(event) { events.push(event); } },
  });
  await assert.rejects(provider.unwrapKey({
    provider: "local", keyRef: inner.keyRef, fingerprint: inner.fingerprint,
    ciphertext: Buffer.alloc(1), metadata: {},
  }, CONTEXT), /LOCAL_KEY_WRAPPER_MISMATCH/);
  assert.equal(events[0]?.outcome, "invalid");
  assert.equal(JSON.stringify(events).includes("WRAPPER_MISMATCH"), false);
});

test("health observation uses the safe returned status and keeps credential description unobserved", async () => {
  const inner = innerProvider();
  inner.healthCheck = async () => ({
    status: "unhealthy",
    latencyMs: 999,
    checkedAt: new Date(0),
    errorCode: "AUTH_FAILED",
  });
  const events: KeyOperationEvent[] = [];
  const provider = new ObservedKeyManagementProvider(inner, {
    now: (() => { const ticks = [20, 25]; return () => ticks.shift()!; })(),
    recorder: { async record(event) { events.push(event); } },
  });

  assert.equal((await provider.healthCheck()).status, "unhealthy");
  assert.deepEqual(events, [{
    provider: "aws-kms",
    fingerprint: "aws-kms:0123456789abcdef01234567",
    operation: "health",
    outcome: "auth",
    latencyMs: 5,
  }]);
  assert.deepEqual(await provider.describeCredentialSource(), {
    kind: "test",
    staticCredential: false,
  });
  assert.equal(events.length, 1);
});

test("provider identity is captured once and rejects noncanonical fingerprints", () => {
  const inner = innerProvider();
  let reads = 0;
  Object.defineProperty(inner, "fingerprint", {
    configurable: true,
    get() {
      reads += 1;
      return "aws-kms:0123456789abcdef01234567";
    },
  });
  const observed = new ObservedKeyManagementProvider(inner, {
    recorder: { async record() {} },
  });
  assert.equal(observed.fingerprint, "aws-kms:0123456789abcdef01234567");
  assert.equal(observed.fingerprint, "aws-kms:0123456789abcdef01234567");
  assert.equal(reads, 1);

  assert.throws(
    () => new ObservedKeyManagementProvider({
      ...innerProvider(),
      fingerprint: "aws-kms:https://kms/?credential=secret",
    }, { recorder: { async record() {} } }),
    /KEY_OPERATION_IDENTITY_INVALID/,
  );
  assert.throws(
    () => new ObservedKeyManagementProvider({
      ...innerProvider(),
      get fingerprint(): string { throw new Error("credential=identity-secret"); },
    }, { recorder: { async record() {} } }),
    (error: unknown) => error instanceof Error
      && error.message === "KEY_OPERATION_IDENTITY_INVALID"
      && !error.message.includes("secret"),
  );
});

test("hostile local error and clock cannot mask the original crypto result", async () => {
  const inner = innerProvider();
  Object.defineProperties(inner, {
    name: { value: "local" },
    fingerprint: { value: "local:0123456789abcdef01234567" },
  });
  const hostile = new Proxy({}, {
    getPrototypeOf() { throw new Error("credential=proxy-secret"); },
  });
  inner.unwrapKey = async () => { throw hostile; };
  const events: KeyOperationEvent[] = [];
  const provider = new ObservedKeyManagementProvider(inner, {
    now: () => { throw new Error("clock secret"); },
    recorder: { async record(event) { events.push(event); } },
  });

  await assert.rejects(provider.unwrapKey({
    provider: "local", keyRef: inner.keyRef, fingerprint: inner.fingerprint,
    ciphertext: Buffer.alloc(1), metadata: {},
  }, CONTEXT), (error) => error === hostile);
  assert.equal(events[0]?.outcome, "unavailable");

  inner.unwrapKey = async () => Buffer.alloc(32, 4);
  const value = await provider.unwrapKey({
    provider: "local", keyRef: inner.keyRef, fingerprint: inner.fingerprint,
    ciphertext: Buffer.alloc(1), metadata: {},
  }, CONTEXT);
  assert.equal(value[0], 4);
});

test("aggregate writer validates the complete event and uses parameterized bounded values", async () => {
  const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  const db = {
    async query(sql: string, params: readonly unknown[]) {
      calls.push({ sql, params });
      return { rows: [] };
    },
  };
  await recordKeyOperation({
    provider: "local",
    fingerprint: "local:abcdefabcdefabcdefabcdef",
    operation: "unwrap",
    outcome: "success",
    cacheResult: "hit",
    latencyMs: 1.6,
  }, db);
  assert.match(calls[0]!.sql, /ON CONFLICT[\s\S]+DO UPDATE/);
  assert.equal(calls[0]!.sql.includes("abcdefabcdefabcdefabcdef"), false);
  assert.deepEqual(calls[0]!.params, [
    "local", "local:abcdefabcdefabcdefabcdef", "unwrap", "success", "hit", 2,
  ]);

  for (const invalid of [
    { provider: "aws-kms", fingerprint: "aws-kms:credential=secret", operation: "wrap", outcome: "success", latencyMs: 1 },
    { provider: "local", fingerprint: "local:abcdefabcdefabcdefabcdef", operation: "wrap", outcome: "success", latencyMs: -1 },
    { provider: "local", fingerprint: "local:abcdefabcdefabcdefabcdef", operation: "wrap", outcome: "success", latencyMs: Number.POSITIVE_INFINITY },
    { provider: "local", fingerprint: "local:abcdefabcdefabcdefabcdef", operation: "wrap", outcome: "success", latencyMs: 86_400_001 },
  ]) {
    await assert.rejects(
      recordKeyOperation(invalid as KeyOperationEvent, db),
      /KEY_OPERATION_EVENT_INVALID/,
    );
  }
  assert.equal(calls.length, 1);
});

test("aggregate writer masks database exception details", async () => {
  await assert.rejects(
    recordKeyOperation({
      provider: "local",
      fingerprint: "local:abcdefabcdefabcdefabcdef",
      operation: "wrap",
      outcome: "success",
      latencyMs: 1,
    }, {
      async query() { throw new Error("postgres://admin:secret@db/internal"); },
    }),
    (error: unknown) => (
      error instanceof Error
      && error.message === "KEY_OPERATION_RECORD_FAILED"
      && !error.message.includes("secret")
    ),
  );
});

test("aggregate writer masks hostile event traps before touching the database", async () => {
  let calls = 0;
  const hostile = new Proxy({}, {
    ownKeys() { throw new Error("credential=event-secret"); },
  }) as KeyOperationEvent;
  await assert.rejects(
    recordKeyOperation(hostile, {
      async query() { calls += 1; },
    }),
    (error: unknown) => error instanceof Error
      && error.message === "KEY_OPERATION_EVENT_INVALID"
      && !error.message.includes("secret"),
  );
  assert.equal(calls, 0);
});
