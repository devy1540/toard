import assert from "node:assert/strict";
import test from "node:test";
import { KeyProviderRegistry } from "./registry";
import type {
  CredentialSourceSummary,
  KeyContext,
  KeyManagementProvider,
  KeyProviderHealth,
  KeyProviderName,
  WrappedUserKey,
} from "./types";

class FakeProvider implements KeyManagementProvider {
  constructor(
    readonly name: KeyProviderName,
    readonly keyRef: string,
    readonly fingerprint: string,
  ) {}

  async wrapKey(uck: Buffer, _context: KeyContext): Promise<WrappedUserKey> {
    return {
      provider: this.name,
      keyRef: this.keyRef,
      fingerprint: this.fingerprint,
      ciphertext: Buffer.from(uck),
      metadata: {},
    };
  }

  async unwrapKey(wrapped: WrappedUserKey, _context: KeyContext): Promise<Buffer> {
    return Buffer.from(wrapped.ciphertext);
  }

  async healthCheck(): Promise<KeyProviderHealth> {
    return { status: "healthy", latencyMs: 0, checkedAt: new Date(0) };
  }

  async describeCredentialSource(): Promise<CredentialSourceSummary> {
    return { kind: "test", staticCredential: false };
  }
}

function wrapped(
  provider: KeyManagementProvider,
  overrides: Partial<WrappedUserKey> = {},
): WrappedUserKey {
  return {
    provider: provider.name,
    keyRef: provider.keyRef,
    fingerprint: provider.fingerprint,
    ciphertext: Buffer.alloc(96),
    metadata: {},
    ...overrides,
  };
}

test("registry는 active와 migration의 정확한 wrapper identity만 resolve한다", () => {
  const active = new FakeProvider("local", "file:/active", "local:active");
  const migration = new FakeProvider("aws-kms", "arn:aws:kms:key/migration", "aws:migration");
  const registry = new KeyProviderRegistry(active, migration);

  assert.equal(registry.active, active);
  assert.equal(registry.migration, migration);
  assert.equal(registry.resolveWrappedKey(wrapped(active)), active);
  assert.equal(registry.resolveWrappedKey(wrapped(migration)), migration);

  assert.throws(
    () => registry.resolveWrappedKey(wrapped(active, { provider: "aws-kms" })),
    /KEY_PROVIDER_NOT_REGISTERED/,
  );
  assert.throws(
    () => registry.resolveWrappedKey(wrapped(active, { keyRef: "file:/other" })),
    /KEY_PROVIDER_NOT_REGISTERED/,
  );
  assert.throws(
    () => registry.resolveWrappedKey(wrapped(active, { fingerprint: "local:unknown" })),
    /KEY_PROVIDER_NOT_REGISTERED/,
  );
});

test("registry는 migration이 없어도 active만 resolve한다", () => {
  const active = new FakeProvider("local", "file:/active", "local:active");
  const registry = new KeyProviderRegistry(active, null);

  assert.equal(registry.migration, null);
  assert.equal(registry.resolveWrappedKey(wrapped(active)), active);
});

test("registry는 fingerprint가 같아도 provider와 keyRef까지 대조한다", () => {
  const active = new FakeProvider("local", "file:/active", "shared-fingerprint");
  const migration = new FakeProvider("local", "file:/migration", "shared-fingerprint");
  const registry = new KeyProviderRegistry(active, migration);

  assert.equal(registry.resolveWrappedKey(wrapped(active)), active);
  assert.equal(registry.resolveWrappedKey(wrapped(migration)), migration);
});
