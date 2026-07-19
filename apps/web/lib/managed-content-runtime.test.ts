import assert from "node:assert/strict";
import test from "node:test";
import {
  contentCollectionDefaultOn,
  contentCollectionEnabled,
} from "./content-crypto";
import type { KeyManagementProvider } from "./key-management/types";
import { KeyProviderRegistry } from "./key-management/registry";
import {
  createManagedContentRuntime,
  getManagedContentRuntime,
  managedContentConfigured,
  resetManagedContentRuntimeForTests,
  type RuntimeDependencies,
} from "./managed-content-runtime";

const INSTALLATION_ID = "018f47d0-4d47-7b04-950b-7d18a86e1b43";
const VALID_ENV = {
  NODE_ENV: "test",
  TOARD_KEY_ACTIVE_PROVIDER: "local",
  TOARD_KEY_ACTIVE_LOCAL_KEK_FILE: "/run/secrets/toard-local-kek",
};

function fakeProvider(): KeyManagementProvider {
  return {
    name: "local",
    keyRef: "/run/secrets/toard-local-kek",
    fingerprint: "local:test-runtime",
    wrapKey: async () => {
      throw new Error("UNUSED");
    },
    unwrapKey: async () => {
      throw new Error("UNUSED");
    },
    healthCheck: async () => ({
      status: "healthy",
      latencyMs: 0,
      checkedAt: new Date(0),
    }),
    describeCredentialSource: async () => ({
      kind: "test",
      staticCredential: false,
    }),
  };
}

function createRuntimeDeps(): RuntimeDependencies & {
  installationLoads: number;
  providerCreates: number;
  cacheCreates: number;
  userKeyServiceCreates: number;
  healthCreates: number;
} {
  const counters = {
    installationLoads: 0,
    providerCreates: 0,
    cacheCreates: 0,
    userKeyServiceCreates: 0,
    healthCreates: 0,
  };
  const userKeys = {
    async withActiveUserKey() {
      throw new Error("UNUSED");
    },
    async withUserKeyVersion() {
      throw new Error("UNUSED");
    },
  };
  return {
    ...counters,
    env: VALID_ENV,
    loadInstallationId: async () => {
      counters.installationLoads += 1;
      return INSTALLATION_ID;
    },
    createRegistry: () => {
      counters.providerCreates += 1;
      return new KeyProviderRegistry(fakeProvider(), null);
    },
    createCache: (ttlMs) => {
      counters.cacheCreates += 1;
      assert.equal(ttlMs, 1_800_000);
      return {} as ReturnType<NonNullable<RuntimeDependencies["createCache"]>>;
    },
    createUserKeys: ({ installationId, registry }) => {
      counters.userKeyServiceCreates += 1;
      assert.equal(installationId, INSTALLATION_ID);
      assert.ok(registry instanceof KeyProviderRegistry);
      return userKeys;
    },
    createHealth: () => {
      counters.healthCreates += 1;
      return {} as ReturnType<NonNullable<RuntimeDependencies["createHealth"]>>;
    },
    get installationLoads() {
      return counters.installationLoads;
    },
    get providerCreates() {
      return counters.providerCreates;
    },
    get cacheCreates() {
      return counters.cacheCreates;
    },
    get userKeyServiceCreates() {
      return counters.userKeyServiceCreates;
    },
    get healthCreates() {
      return counters.healthCreates;
    },
  };
}

async function withTestRuntime<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env.NODE_ENV;
  const mutableEnv = process.env as Record<string, string | undefined>;
  mutableEnv.NODE_ENV = "test";
  resetManagedContentRuntimeForTests();
  try {
    return await fn();
  } finally {
    resetManagedContentRuntimeForTests();
    if (previous === undefined) delete mutableEnv.NODE_ENV;
    else mutableEnv.NODE_ENV = previous;
  }
}

test("runtime은 installation ID와 provider registry를 한 번만 만든다", async () => {
  await withTestRuntime(async () => {
    const deps = createRuntimeDeps();
    const first = await getManagedContentRuntime(deps);
    const second = await getManagedContentRuntime(deps);
    assert.equal(first, second);
    assert.equal(first?.installationId, INSTALLATION_ID);
    assert.equal(deps.installationLoads, 1);
    assert.equal(deps.providerCreates, 1);
    assert.equal(deps.cacheCreates, 1);
    assert.equal(deps.userKeyServiceCreates, 1);
    assert.equal(deps.healthCreates, 1);
  });
});

test("provider 미설정은 disabled이고 일부 설정은 strict config 오류다", async () => {
  const deps = createRuntimeDeps();
  assert.equal(
    await createManagedContentRuntime({ ...deps, env: { NODE_ENV: "test" } }),
    null,
  );
  await assert.rejects(
    createManagedContentRuntime({
      ...deps,
      env: {
        NODE_ENV: "test",
        TOARD_KEY_ACTIVE_LOCAL_KEK_FILE: "/run/secrets/orphaned-kek",
      },
    }),
    /TOARD_KEY_ACTIVE_PROVIDER/,
  );
  await assert.rejects(
    createManagedContentRuntime({
      ...deps,
      env: {
        NODE_ENV: "test",
        TOARD_KEY_ACTIVE_PROVIDER: "aws-kms",
      },
    }),
    /AWS_KEY_ARN/,
  );
});

test("managed 설정과 legacy KEK 설정은 네 조합에서 독립적이다", () => {
  const legacyKek = Buffer.alloc(32, 7).toString("base64");
  assert.equal(managedContentConfigured({}), false);
  assert.equal(managedContentConfigured({ TOARD_CONTENT_KEK_B64: legacyKek }), false);
  assert.equal(managedContentConfigured(VALID_ENV), true);
  assert.equal(
    managedContentConfigured({ ...VALID_ENV, TOARD_CONTENT_KEK_B64: legacyKek }),
    true,
  );
  assert.equal(
    managedContentConfigured({
      TOARD_KEY_ACTIVE_PROVIDER: "aws-kms",
    }),
    false,
  );
});

test("신규 수집 활성과 설치 기본값은 managed provider에만 의존한다", () => {
  const legacyOnly = {
    TOARD_CONTENT_KEK_B64: Buffer.alloc(32, 7).toString("base64"),
    CONTENT_COLLECTION_DEFAULT: "true",
  };
  assert.equal(contentCollectionEnabled(legacyOnly), false);
  assert.equal(contentCollectionDefaultOn(legacyOnly), false);
  assert.equal(contentCollectionEnabled(VALID_ENV), true);
  assert.equal(contentCollectionDefaultOn(VALID_ENV), false);
  assert.equal(
    contentCollectionDefaultOn({
      ...VALID_ENV,
      CONTENT_COLLECTION_DEFAULT: "true",
    }),
    true,
  );
});

test("runtime 초기화의 DB/provider 오류 원문은 노출하지 않는다", async () => {
  const deps = createRuntimeDeps();
  await assert.rejects(
    createManagedContentRuntime({
      ...deps,
      loadInstallationId: async () => {
        throw new Error("postgres://admin:secret@db.internal/toard");
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "MANAGED_CONTENT_RUNTIME_INIT_FAILED");
      assert.doesNotMatch(error.message, /secret|postgres/i);
      return true;
    },
  );
  await assert.rejects(
    createManagedContentRuntime({
      ...deps,
      createRegistry: () => {
        throw new Error("provider credential=top-secret");
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "MANAGED_CONTENT_RUNTIME_INIT_FAILED");
      assert.doesNotMatch(error.message, /credential|secret/i);
      return true;
    },
  );
});

test("runtime reset은 test 환경 밖에서 사용할 수 없다", () => {
  const previous = process.env.NODE_ENV;
  const mutableEnv = process.env as Record<string, string | undefined>;
  mutableEnv.NODE_ENV = "production";
  try {
    assert.throws(
      () => resetManagedContentRuntimeForTests(),
      /MANAGED_CONTENT_RUNTIME_RESET_TEST_ONLY/,
    );
  } finally {
    if (previous === undefined) delete mutableEnv.NODE_ENV;
    else mutableEnv.NODE_ENV = previous;
  }
});
