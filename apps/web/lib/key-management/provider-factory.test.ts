import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderProfile } from "./config";
import {
  createKeyProvider,
  createKeyProviderRegistry,
  type KeyProviderFactoryDependencies,
} from "./provider-factory";

const LOCAL_KEK = Buffer.alloc(32, 7);
const TRANSIT_TOKEN = Buffer.from("hvs.test-token\n", "utf8");

function profile(
  provider: ProviderProfile["provider"],
  settings: Record<string, string>,
  slot: ProviderProfile["slot"] = "active",
): ProviderProfile {
  return { slot, provider, settings: Object.freeze(settings) };
}

function dependencies(): KeyProviderFactoryDependencies {
  return {
    readFile: (path) => {
      if (path.endsWith(".key")) return Buffer.from(LOCAL_KEK);
      return Buffer.from(TRANSIT_TOKEN);
    },
    fetch: async () => {
      throw new Error("NETWORK_MUST_NOT_BE_USED_DURING_CONSTRUCTION");
    },
    awsClient: {
      async send() {
        throw new Error("AWS_MUST_NOT_BE_USED_DURING_CONSTRUCTION");
      },
    },
    gcpClient: {
      async encrypt() {
        throw new Error("GCP_MUST_NOT_BE_USED_DURING_CONSTRUCTION");
      },
      async decrypt() {
        throw new Error("GCP_MUST_NOT_BE_USED_DURING_CONSTRUCTION");
      },
    },
    azureCryptoClient: {
      async wrapKey() {
        throw new Error("AZURE_MUST_NOT_BE_USED_DURING_CONSTRUCTION");
      },
      async unwrapKey() {
        throw new Error("AZURE_MUST_NOT_BE_USED_DURING_CONSTRUCTION");
      },
    },
    now: () => 0,
  };
}

const PROFILES: ReadonlyArray<ProviderProfile> = [
  profile("local", { LOCAL_KEK_FILE: "/secrets/active.key" }),
  profile("aws-kms", {
    AWS_KEY_ARN:
      "arn:aws:kms:ap-northeast-2:123456789012:key/12345678-1234-1234-1234-123456789abc",
    AWS_REGION: "ap-northeast-2",
  }),
  profile("gcp-kms", {
    GCP_KEY_NAME:
      "projects/test/locations/asia-northeast3/keyRings/toard/cryptoKeys/history",
  }),
  profile("azure-key-vault", {
    AZURE_KEY_ID: "https://test.vault.azure.net/keys/history/version-1",
    AZURE_CREDENTIAL_MODE: "managed-identity",
    AZURE_MANAGED_IDENTITY_CLIENT_ID: "11111111-1111-1111-1111-111111111111",
  }),
  profile("vault-transit", {
    TRANSIT_ADDRESS: "https://vault.example.com/",
    TRANSIT_MOUNT: "transit",
    TRANSIT_KEY_NAME: "history",
    TRANSIT_AUTH_METHOD: "token-file",
    TRANSIT_TOKEN_FILE: "/secrets/vault-token",
  }),
  profile("openbao-transit", {
    TRANSIT_ADDRESS: "https://openbao.example.com/",
    TRANSIT_MOUNT: "transit",
    TRANSIT_KEY_NAME: "history",
    TRANSIT_AUTH_METHOD: "static-token",
    TRANSIT_TOKEN_FILE: "/secrets/openbao-token",
  }),
];

for (const configuredProfile of PROFILES) {
  test(`${configuredProfile.provider} profile은 matching provider를 생성한다`, () => {
    const provider = createKeyProvider(configuredProfile, dependencies());
    assert.equal(provider.name, configuredProfile.provider);
  });
}

test("Transit auth method는 정확한 token source만 생성하고 static-token도 파일을 쓴다", async () => {
  const paths: string[] = [];
  const deps = dependencies();
  deps.readFile = (path) => {
    paths.push(path);
    return Buffer.from(TRANSIT_TOKEN);
  };
  const provider = createKeyProvider(
    profile("vault-transit", {
      TRANSIT_ADDRESS: "https://vault.example.com/",
      TRANSIT_MOUNT: "transit",
      TRANSIT_KEY_NAME: "history",
      TRANSIT_AUTH_METHOD: "static-token",
      TRANSIT_TOKEN_FILE: "/secrets/static-token",
    }),
    deps,
  );

  assert.deepEqual(await provider.describeCredentialSource(), {
    kind: "transit-token-file",
    staticCredential: true,
  });
  assert.deepEqual(paths, []);
});

const TRANSIT_AUTH_CASES: ReadonlyArray<{
  method: string;
  settings: Readonly<Record<string, string>>;
  description: Readonly<{
    kind: string;
    staticCredential: boolean;
  }>;
}> = [
  {
    method: "token-file",
    settings: { TRANSIT_TOKEN_FILE: "/secrets/token" },
    description: { kind: "transit-token-file", staticCredential: true },
  },
  {
    method: "static-token",
    settings: { TRANSIT_TOKEN_FILE: "/secrets/static-token" },
    description: { kind: "transit-token-file", staticCredential: true },
  },
  {
    method: "kubernetes",
    settings: {
      TRANSIT_KUBERNETES_ROLE: "toard",
      TRANSIT_KUBERNETES_JWT_FILE: "/var/run/secrets/kubernetes/token",
    },
    description: { kind: "transit-kubernetes", staticCredential: false },
  },
  {
    method: "approle",
    settings: {
      TRANSIT_APPROLE_ROLE_ID_FILE: "/secrets/role-id",
      TRANSIT_APPROLE_SECRET_ID_FILE: "/secrets/secret-id",
    },
    description: { kind: "transit-approle", staticCredential: true },
  },
];

for (const authCase of TRANSIT_AUTH_CASES) {
  test(`Transit ${authCase.method}은 해당 token source만 선택한다`, async () => {
    let reads = 0;
    let fetches = 0;
    const provider = createKeyProvider(
      profile("vault-transit", {
        TRANSIT_ADDRESS: "https://vault.example.com/",
        TRANSIT_MOUNT: "transit",
        TRANSIT_KEY_NAME: "history",
        TRANSIT_AUTH_METHOD: authCase.method,
        ...authCase.settings,
      }),
      {
        ...dependencies(),
        readFile: () => {
          reads += 1;
          return Buffer.from(TRANSIT_TOKEN);
        },
        fetch: async () => {
          fetches += 1;
          throw new Error("NETWORK_MUST_NOT_BE_USED_DURING_CONSTRUCTION");
        },
      },
    );

    assert.deepEqual(
      await provider.describeCredentialSource(),
      authCase.description,
    );
    assert.equal(reads, 0);
    assert.equal(fetches, 0);
  });
}

test("factory 오류는 설정 원문이나 secret 경로를 노출하지 않는다", () => {
  const secretPath = "/private/customer/local-kek";
  assert.throws(
    () => createKeyProvider(
      profile("local", { LOCAL_KEK_FILE: secretPath }),
      {
        ...dependencies(),
        readFile: () => {
          throw new Error(`read failed: ${secretPath}`);
        },
      },
    ),
    (error: Error) => (
      error.message === "KEY_PROVIDER_CONSTRUCTION_FAILED"
      && !error.message.includes(secretPath)
    ),
  );
});

test("registry factory는 다른 local path가 같은 KEK bytes면 거부하고 임시 buffer를 zeroize한다", () => {
  const issued: Buffer[] = [];
  const config = {
    active: profile("local", { LOCAL_KEK_FILE: "/secrets/a.key" }),
    migration: profile(
      "local",
      { LOCAL_KEK_FILE: "/secrets/b.key" },
      "migration",
    ),
    cacheTtlMs: 1_800_000,
  };

  assert.throws(
    () => createKeyProviderRegistry(config, {
      readFile: () => {
        const value = Buffer.from(LOCAL_KEK);
        issued.push(value);
        return value;
      },
    }),
    /KEY_PROVIDER_DUPLICATE_FINGERPRINT/,
  );
  assert.equal(issued.length, 2);
  for (const value of issued) assert.deepEqual(value, Buffer.alloc(32));
});

test("registry factory는 active와 migration을 정확히 resolve한다", () => {
  const config = {
    active: PROFILES[1]!,
    migration: {
      ...PROFILES[2]!,
      slot: "migration" as const,
    },
    cacheTtlMs: 1_800_000,
  };
  const registry = createKeyProviderRegistry(config, dependencies());

  assert.equal(registry.active.name, "aws-kms");
  assert.equal(registry.migration?.name, "gcp-kms");
  assert.equal(registry.resolveWrappedKey({
    provider: registry.active.name,
    keyRef: registry.active.keyRef,
    fingerprint: registry.active.fingerprint,
    ciphertext: Buffer.alloc(1),
    metadata: {},
  }), registry.active);
});
