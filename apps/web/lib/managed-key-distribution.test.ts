import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateProviderRemovalReadiness,
  parseManagedKeyDistribution,
} from "./managed-key-distribution";

const OLD = { provider: "local" as const, providerFingerprint: "local:111111111111111111111111" };
const TARGET = { provider: "aws-kms" as const, providerFingerprint: "aws-kms:222222222222222222222222" };

const READY_ROWS = [
  { provider: "aws-kms", provider_fingerprint: TARGET.providerFingerprint, state: "active", wrapper_count: "2" },
  { provider: "local", provider_fingerprint: OLD.providerFingerprint, state: "retiring", wrapper_count: "2" },
];

test("distribution parser emits one canonical secret-free DTO and rejects hostile or overflowing DB shapes", () => {
  assert.deepEqual(parseManagedKeyDistribution(READY_ROWS), [
    { provider: "aws-kms", providerFingerprint: TARGET.providerFingerprint, state: "active", count: 2 },
    { provider: "local", providerFingerprint: OLD.providerFingerprint, state: "retiring", count: 2 },
  ]);

  const getter = Object.defineProperties({}, {
    provider: { enumerable: true, get() { return "local"; } },
    provider_fingerprint: { enumerable: true, value: OLD.providerFingerprint },
    state: { enumerable: true, value: "active" },
    wrapper_count: { enumerable: true, value: "1" },
  });
  const proxy = new Proxy({}, { ownKeys() { throw new Error("token=secret"); } });
  for (const rows of [
    [{ ...READY_ROWS[0], wrapped_user_key: "plaintext" }],
    [{ ...READY_ROWS[0], provider_fingerprint: "aws-kms:unexpected" }],
    [{ ...READY_ROWS[0], state: "future" }],
    [{ ...READY_ROWS[0], wrapper_count: "01" }],
    [{ ...READY_ROWS[0], wrapper_count: Number.MAX_SAFE_INTEGER.toString() }, { ...READY_ROWS[0] }],
    [getter],
    [proxy],
  ]) {
    assert.throws(
      () => parseManagedKeyDistribution(rows),
      (error: unknown) => {
        assert.equal((error as Error).message, "MANAGED_KEY_DISTRIBUTION_INVALID");
        assert.doesNotMatch((error as Error).message, /secret|plaintext|token/i);
        return true;
      },
    );
  }
});

test("removal readiness requires every active wrapper on the configured target and no pending wrapper", () => {
  const readyDistribution = parseManagedKeyDistribution(READY_ROWS);
  assert.deepEqual(evaluateProviderRemovalReadiness(readyDistribution, OLD, TARGET), {
    old: OLD,
    target: TARGET,
    totalActiveWrappers: 2,
    oldActiveWrappers: 0,
    targetActiveWrappers: 2,
    pendingWrappers: 0,
    unexpectedActiveWrappers: 0,
    removalReady: true,
  });

  for (const rows of [
    [{ ...READY_ROWS[0], wrapper_count: "1" }, { ...READY_ROWS[1] },
      { provider: "local", provider_fingerprint: OLD.providerFingerprint, state: "active", wrapper_count: "1" }],
    [...READY_ROWS, { provider: "aws-kms", provider_fingerprint: TARGET.providerFingerprint, state: "pending", wrapper_count: "1" }],
    [{ ...READY_ROWS[0], wrapper_count: "1" }, { ...READY_ROWS[1] },
      { provider: "gcp-kms", provider_fingerprint: "gcp-kms:333333333333333333333333", state: "active", wrapper_count: "1" }],
  ]) {
    assert.equal(
      evaluateProviderRemovalReadiness(parseManagedKeyDistribution(rows), OLD, TARGET).removalReady,
      false,
    );
  }

  const noTarget = evaluateProviderRemovalReadiness(readyDistribution, OLD, null);
  assert.equal(noTarget.target, null);
  assert.equal(noTarget.removalReady, false);
});
