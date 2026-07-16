import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadKeyManagementConfig } from "./config";

const AWS_KEY_ARN =
  "arn:aws:kms:ap-northeast-2:123456789012:key/12345678-1234-1234-1234-123456789abc";
const AWS_MRK_ARN =
  "arn:aws:kms:us-east-1:123456789012:key/mrk-1234567890abcdef1234567890abcdef";

function activeConfig(
  provider: "local" | "aws-kms" | "gcp-kms" | "azure-key-vault" | "vault-transit" | "openbao-transit",
  env: Readonly<Record<string, string | undefined>>,
) {
  return loadKeyManagementConfig({
    TOARD_KEY_ACTIVE_PROVIDER: provider,
    ...env,
  });
}

test("cache TTL과 active local file을 엄격히 검증한다", () => {
  assert.throws(() => loadKeyManagementConfig({}), /TOARD_KEY_ACTIVE_PROVIDER/);
  assert.throws(
    () => loadKeyManagementConfig({
      TOARD_KEY_ACTIVE_PROVIDER: "local",
      TOARD_KEY_ACTIVE_LOCAL_KEK_FILE: "/run/secrets/kek",
      TOARD_USER_KEY_CACHE_TTL_SECONDS: "3601",
    }),
    /300~3600/,
  );
  assert.throws(
    () => loadKeyManagementConfig({
      TOARD_KEY_ACTIVE_PROVIDER: "local",
      TOARD_KEY_ACTIVE_LOCAL_KEK_FILE: "/run/secrets/kek",
      TOARD_USER_KEY_CACHE_TTL_SECONDS: "300.5",
    }),
    /300~3600/,
  );
  assert.throws(
    () => loadKeyManagementConfig({
      TOARD_KEY_ACTIVE_PROVIDER: "local",
      TOARD_KEY_ACTIVE_LOCAL_KEK_FILE: "relative/kek",
    }),
    /absolute|절대/,
  );
});

test("local profile은 raw KEK 없이 secret-file 경로 하나만 받는다", () => {
  assert.throws(
    () => loadKeyManagementConfig({
      TOARD_KEY_ACTIVE_PROVIDER: "local",
      TOARD_KEY_ACTIVE_LOCAL_KEK_FILE: "/run/secrets/kek",
      TOARD_KEY_ACTIVE_LOCAL_KEK_B64: "not-a-real-key",
    }),
    /RAW|raw|환경변수/,
  );
  assert.throws(
    () => loadKeyManagementConfig({
      TOARD_KEY_ACTIVE_PROVIDER: "local",
      TOARD_KEY_ACTIVE_LOCAL_KEK_FILE: "/run/secrets/kek",
      TOARD_KEY_ACTIVE_AWS_KEY_ARN: "arn:aws:kms:region:account:key/id",
    }),
    /local.*하나|허용/,
  );
  assert.throws(
    () => loadKeyManagementConfig({
      TOARD_KEY_ACTIVE_PROVIDER: "local",
    }),
    /TOARD_KEY_ACTIVE_LOCAL_KEK_FILE/,
  );

  const config = loadKeyManagementConfig({
    TOARD_KEY_ACTIVE_PROVIDER: "local",
    TOARD_KEY_ACTIVE_LOCAL_KEK_FILE: "/run/secrets/kek",
  });
  assert.deepEqual(config.active, {
    slot: "active",
    provider: "local",
    settings: { LOCAL_KEK_FILE: "/run/secrets/kek" },
  });
  assert.equal(config.migration, null);
  assert.equal(config.cacheTtlMs, 1_800_000);
});

test("local duplicate는 같은 file path만 거부하고 다른 path의 byte fingerprint는 factory에 맡긴다", () => {
  assert.throws(
    () => loadKeyManagementConfig({
      TOARD_KEY_ACTIVE_PROVIDER: "local",
      TOARD_KEY_ACTIVE_LOCAL_KEK_FILE: "/run/secrets/kek",
      TOARD_KEY_MIGRATION_PROVIDER: "local",
      TOARD_KEY_MIGRATION_LOCAL_KEK_FILE: "/run/secrets/kek",
    }),
    /fingerprint/,
  );

  // 다른 path가 같은 bytes인지는 config parser가 읽지 않고 provider factory가 최종 검증한다.
  const config = loadKeyManagementConfig({
    TOARD_KEY_ACTIVE_PROVIDER: "local",
    TOARD_KEY_ACTIVE_LOCAL_KEK_FILE: "/run/secrets/old-kek",
    TOARD_KEY_MIGRATION_PROVIDER: "local",
    TOARD_KEY_MIGRATION_LOCAL_KEK_FILE: "/run/secrets/new-kek",
    TOARD_USER_KEY_CACHE_TTL_SECONDS: "300",
  });
  assert.deepEqual(config.migration, {
    slot: "migration",
    provider: "local",
    settings: { LOCAL_KEK_FILE: "/run/secrets/new-kek" },
  });
  assert.equal(config.cacheTtlMs, 300_000);
});

test("지원하지 않는 provider를 거부한다", () => {
  assert.throws(
    () => loadKeyManagementConfig({
      TOARD_KEY_ACTIVE_PROVIDER: "unknown",
    }),
    /TOARD_KEY_ACTIVE_PROVIDER/,
  );
});

test("non-local profile은 자기 namespace와 비민감 설정만 보존한다", () => {
  assert.throws(
    () => loadKeyManagementConfig({
      TOARD_KEY_ACTIVE_PROVIDER: "aws-kms",
      TOARD_KEY_ACTIVE_GCP_KEY_NAME: "projects/p/locations/l/keyRings/r/cryptoKeys/k",
    }),
    /GCP_KEY_NAME|허용/,
  );
  assert.throws(
    () => loadKeyManagementConfig({
      TOARD_KEY_ACTIVE_PROVIDER: "aws-kms",
      TOARD_KEY_ACTIVE_AWS_KEY_ARN: AWS_KEY_ARN,
      TOARD_KEY_ACTIVE_AWS_SECRET_ACCESS_KEY: "must-not-enter-settings",
    }),
    /raw credential/,
  );

  const config = loadKeyManagementConfig({
    TOARD_KEY_ACTIVE_PROVIDER: "aws-kms",
    TOARD_KEY_ACTIVE_AWS_KEY_ARN: AWS_KEY_ARN,
    TOARD_KEY_ACTIVE_AWS_REGION: "ap-northeast-2",
  });
  assert.deepEqual(config.active.settings, {
    AWS_KEY_ARN,
    AWS_REGION: "ap-northeast-2",
  });
});

test("provider별 key ref와 auth mode를 엄격히 검증한다", () => {
  assert.throws(
    () => activeConfig("aws-kms", {}),
    /TOARD_KEY_ACTIVE_AWS_KEY_ARN/,
  );
  assert.throws(
    () => activeConfig("aws-kms", {
      TOARD_KEY_ACTIVE_AWS_KEY_ARN: "alias/not-an-arn",
      TOARD_KEY_ACTIVE_AWS_REGION: "ap-northeast-2",
    }),
    /ARN/,
  );
  assert.throws(
    () => activeConfig("aws-kms", {
      TOARD_KEY_ACTIVE_AWS_KEY_ARN: AWS_KEY_ARN,
      TOARD_KEY_ACTIVE_AWS_REGION: "region",
    }),
    /AWS_REGION/,
  );
  assert.throws(
    () => activeConfig("aws-kms", {
      TOARD_KEY_ACTIVE_AWS_KEY_ARN: AWS_KEY_ARN,
    }),
    /TOARD_KEY_ACTIVE_AWS_REGION/,
  );
  assert.throws(
    () => activeConfig("gcp-kms", {
      TOARD_KEY_ACTIVE_GCP_KEY_NAME: "short-name",
    }),
    /projects\/.*\/cryptoKeys/,
  );
  assert.throws(
    () => activeConfig("azure-key-vault", {
      TOARD_KEY_ACTIVE_AZURE_KEY_ID: "https://vault.vault.azure.net/keys/key/version",
      TOARD_KEY_ACTIVE_AZURE_CREDENTIAL_MODE: "default",
      NODE_ENV: "production",
    }),
    /production.*default/,
  );
  assert.throws(
    () => activeConfig("azure-key-vault", {
      TOARD_KEY_ACTIVE_AZURE_KEY_ID: "https://vault.vault.azure.net/keys/key",
      TOARD_KEY_ACTIVE_AZURE_CREDENTIAL_MODE: "managed-identity",
    }),
    /version|AZURE_KEY_ID/,
  );
  assert.throws(
    () => activeConfig("azure-key-vault", {
      TOARD_KEY_ACTIVE_AZURE_KEY_ID: "vault/key",
      TOARD_KEY_ACTIVE_AZURE_CREDENTIAL_MODE: "managed-identity",
    }),
    /AZURE_KEY_ID/,
  );
  assert.throws(
    () => activeConfig("azure-key-vault", {
      TOARD_KEY_ACTIVE_AZURE_KEY_ID: "https://vault.vault.azure.net/keys/key/version",
    }),
    /TOARD_KEY_ACTIVE_AZURE_CREDENTIAL_MODE/,
  );
  assert.throws(
    () => activeConfig("vault-transit", {
      TOARD_KEY_ACTIVE_TRANSIT_ADDRESS: "http://vault:8200",
      TOARD_KEY_ACTIVE_TRANSIT_MOUNT: "transit",
      TOARD_KEY_ACTIVE_TRANSIT_KEY_NAME: "toard",
      TOARD_KEY_ACTIVE_TRANSIT_AUTH_METHOD: "token-file",
      TOARD_KEY_ACTIVE_TRANSIT_TOKEN_FILE: "/run/secrets/vault-token",
    }),
    /https/,
  );
  assert.throws(
    () => activeConfig("vault-transit", {
      TOARD_KEY_ACTIVE_TRANSIT_ADDRESS: "https://vault.example.test:8200",
    }),
    /TOARD_KEY_ACTIVE_TRANSIT_MOUNT/,
  );
});

test("provider별 exact 설정만 settings에 보존한다", () => {
  assert.deepEqual(activeConfig("aws-kms", {
    TOARD_KEY_ACTIVE_AWS_KEY_ARN: AWS_KEY_ARN,
    TOARD_KEY_ACTIVE_AWS_REGION: "ap-northeast-2",
    TOARD_KEY_ACTIVE_AWS_ENDPOINT: "HTTPS://KMS.EXAMPLE.TEST:443",
  }).active.settings, {
    AWS_ENDPOINT: "https://kms.example.test/",
    AWS_KEY_ARN,
    AWS_REGION: "ap-northeast-2",
  });

  assert.deepEqual(activeConfig("gcp-kms", {
    TOARD_KEY_ACTIVE_GCP_KEY_NAME: "projects/project-1/locations/asia-northeast3/keyRings/toard/cryptoKeys/user-keys",
    TOARD_KEY_ACTIVE_GCP_API_ENDPOINT: "ASIA-NORTHEAST3-KMS.GOOGLEAPIS.COM:443",
  }).active.settings, {
    GCP_API_ENDPOINT: "asia-northeast3-kms.googleapis.com",
    GCP_KEY_NAME: "projects/project-1/locations/asia-northeast3/keyRings/toard/cryptoKeys/user-keys",
  });

  assert.deepEqual(activeConfig("azure-key-vault", {
    TOARD_KEY_ACTIVE_AZURE_KEY_ID: "https://vault.vault.azure.net/keys/toard-key/key-version",
    TOARD_KEY_ACTIVE_AZURE_CREDENTIAL_MODE: "managed-identity",
    TOARD_KEY_ACTIVE_AZURE_MANAGED_IDENTITY_CLIENT_ID: "00000000-0000-0000-0000-000000000000",
    NODE_ENV: "production",
  }).active.settings, {
    AZURE_CREDENTIAL_MODE: "managed-identity",
    AZURE_KEY_ID: "https://vault.vault.azure.net/keys/toard-key/key-version",
    AZURE_MANAGED_IDENTITY_CLIENT_ID: "00000000-0000-0000-0000-000000000000",
  });

  assert.deepEqual(activeConfig("vault-transit", {
    TOARD_KEY_ACTIVE_TRANSIT_ADDRESS: "HTTPS://VAULT.EXAMPLE.TEST:443",
    TOARD_KEY_ACTIVE_TRANSIT_MOUNT: "transit",
    TOARD_KEY_ACTIVE_TRANSIT_KEY_NAME: "toard",
    TOARD_KEY_ACTIVE_TRANSIT_AUTH_METHOD: "token-file",
    TOARD_KEY_ACTIVE_TRANSIT_NAMESPACE: "team-a",
    TOARD_KEY_ACTIVE_TRANSIT_TOKEN_FILE: "/run/secrets/vault-token",
  }).active.settings, {
    TRANSIT_ADDRESS: "https://vault.example.test/",
    TRANSIT_AUTH_METHOD: "token-file",
    TRANSIT_KEY_NAME: "toard",
    TRANSIT_MOUNT: "transit",
    TRANSIT_NAMESPACE: "team-a",
    TRANSIT_TOKEN_FILE: "/run/secrets/vault-token",
  });

  assert.deepEqual(activeConfig("openbao-transit", {
    TOARD_KEY_ACTIVE_TRANSIT_ADDRESS: "https://openbao.example.test:8200",
    TOARD_KEY_ACTIVE_TRANSIT_MOUNT: "transit",
    TOARD_KEY_ACTIVE_TRANSIT_KEY_NAME: "toard",
    TOARD_KEY_ACTIVE_TRANSIT_AUTH_METHOD: "kubernetes",
    TOARD_KEY_ACTIVE_TRANSIT_KUBERNETES_ROLE: "toard",
    TOARD_KEY_ACTIVE_TRANSIT_KUBERNETES_JWT_FILE: "/var/run/secrets/kubernetes.io/serviceaccount/token",
  }).active.settings, {
    TRANSIT_ADDRESS: "https://openbao.example.test:8200/",
    TRANSIT_AUTH_METHOD: "kubernetes",
    TRANSIT_KEY_NAME: "toard",
    TRANSIT_KUBERNETES_JWT_FILE: "/var/run/secrets/kubernetes.io/serviceaccount/token",
    TRANSIT_KUBERNETES_ROLE: "toard",
    TRANSIT_MOUNT: "transit",
  });
});

test("Transit config는 canonical nested mount와 안전한 key/namespace만 허용한다", () => {
  const base = {
    TOARD_KEY_ACTIVE_TRANSIT_ADDRESS: "https://vault.example.test",
    TOARD_KEY_ACTIVE_TRANSIT_MOUNT: "team/transit",
    TOARD_KEY_ACTIVE_TRANSIT_KEY_NAME: "toard-user-keys",
    TOARD_KEY_ACTIVE_TRANSIT_AUTH_METHOD: "token-file",
    TOARD_KEY_ACTIVE_TRANSIT_NAMESPACE: "team-a",
    TOARD_KEY_ACTIVE_TRANSIT_TOKEN_FILE: "/run/secrets/vault-token",
  };
  assert.deepEqual(
    activeConfig("vault-transit", base).active.settings,
    {
      TRANSIT_ADDRESS: "https://vault.example.test/",
      TRANSIT_AUTH_METHOD: "token-file",
      TRANSIT_KEY_NAME: "toard-user-keys",
      TRANSIT_MOUNT: "team/transit",
      TRANSIT_NAMESPACE: "team-a",
      TRANSIT_TOKEN_FILE: "/run/secrets/vault-token",
    },
  );

  for (const mount of [
    "",
    "team//transit",
    "team/../transit",
    "team/%2e%2e/transit",
    "team\\transit",
    " team/transit",
    "team/\ttransit",
  ]) {
    assert.throws(
      () => activeConfig("vault-transit", {
        ...base,
        TOARD_KEY_ACTIVE_TRANSIT_MOUNT: mount,
      }),
      /TRANSIT_MOUNT/,
    );
  }
  for (const keyName of [
    "",
    ".",
    "..",
    "toard/user-keys",
    "toard\\user-keys",
    "%2e%2e",
    " toard",
    "toard\tkey",
  ]) {
    assert.throws(
      () => activeConfig("vault-transit", {
        ...base,
        TOARD_KEY_ACTIVE_TRANSIT_KEY_NAME: keyName,
      }),
      /TRANSIT_KEY_NAME/,
    );
  }
  for (const namespace of [
    " team-a",
    "team-a ",
    "team\r\nx-injected: yes",
    "team\u007fvalue",
    "x".repeat(513),
  ]) {
    assert.throws(
      () => activeConfig("vault-transit", {
        ...base,
        TOARD_KEY_ACTIVE_TRANSIT_NAMESPACE: namespace,
      }),
      /TRANSIT_NAMESPACE/,
    );
  }
});

test("unknown 또는 sibling provider 설정은 비어 있지 않으면 fail-closed한다", () => {
  const aws = {
    TOARD_KEY_ACTIVE_AWS_KEY_ARN: AWS_KEY_ARN,
    TOARD_KEY_ACTIVE_AWS_REGION: "ap-northeast-2",
  };
  assert.throws(
    () => activeConfig("aws-kms", {
      ...aws,
      TOARD_KEY_ACTIVE_AWS_RETRY_LIMIT: "5",
    }),
    /AWS_RETRY_LIMIT|허용/,
  );
  assert.throws(
    () => activeConfig("aws-kms", {
      ...aws,
      TOARD_KEY_ACTIVE_GCP_KEY_NAME: "projects/p/locations/l/keyRings/r/cryptoKeys/k",
    }),
    /GCP_KEY_NAME|허용/,
  );

  const config = activeConfig("aws-kms", {
    ...aws,
    TOARD_KEY_ACTIVE_AWS_RETRY_LIMIT: " ",
    TOARD_KEY_ACTIVE_GCP_KEY_NAME: "",
  });
  assert.deepEqual(config.active.settings, {
    AWS_KEY_ARN: aws.TOARD_KEY_ACTIVE_AWS_KEY_ARN,
    AWS_REGION: aws.TOARD_KEY_ACTIVE_AWS_REGION,
  });
});

test("endpoint는 credential/query/hash를 비노출 거부하고 canonical 값만 저장한다", () => {
  const cases = [
    ["aws-kms", {
      TOARD_KEY_ACTIVE_AWS_KEY_ARN: AWS_KEY_ARN,
      TOARD_KEY_ACTIVE_AWS_REGION: "ap-northeast-2",
      TOARD_KEY_ACTIVE_AWS_ENDPOINT: "http://user:sentinel@localhost:4566",
    }],
    ["aws-kms", {
      TOARD_KEY_ACTIVE_AWS_KEY_ARN: AWS_KEY_ARN,
      TOARD_KEY_ACTIVE_AWS_REGION: "ap-northeast-2",
      TOARD_KEY_ACTIVE_AWS_ENDPOINT: "http://localhost:4566/?token=sentinel",
    }],
    ["aws-kms", {
      TOARD_KEY_ACTIVE_AWS_KEY_ARN: AWS_KEY_ARN,
      TOARD_KEY_ACTIVE_AWS_REGION: "ap-northeast-2",
      TOARD_KEY_ACTIVE_AWS_ENDPOINT: "http://localhost:4566/#secret",
    }],
    ["gcp-kms", {
      TOARD_KEY_ACTIVE_GCP_KEY_NAME: "projects/p/locations/l/keyRings/r/cryptoKeys/k",
      TOARD_KEY_ACTIVE_GCP_API_ENDPOINT: "https://kms.googleapis.com",
    }],
    ["gcp-kms", {
      TOARD_KEY_ACTIVE_GCP_KEY_NAME: "projects/p/locations/l/keyRings/r/cryptoKeys/k",
      TOARD_KEY_ACTIVE_GCP_API_ENDPOINT: "kms.googleapis.com/path",
    }],
    ["gcp-kms", {
      TOARD_KEY_ACTIVE_GCP_KEY_NAME: "projects/p/locations/l/keyRings/r/cryptoKeys/k",
      TOARD_KEY_ACTIVE_GCP_API_ENDPOINT: " kms.googleapis.com",
    }],
    ["gcp-kms", {
      TOARD_KEY_ACTIVE_GCP_KEY_NAME: "projects/p/locations/l/keyRings/r/cryptoKeys/k",
      TOARD_KEY_ACTIVE_GCP_API_ENDPOINT: "user:sentinel",
    }],
    ["gcp-kms", {
      TOARD_KEY_ACTIVE_GCP_KEY_NAME: "projects/p/locations/l/keyRings/r/cryptoKeys/k",
      TOARD_KEY_ACTIVE_GCP_API_ENDPOINT: "kms.googleapis.com?token=sentinel",
    }],
    ["vault-transit", {
      TOARD_KEY_ACTIVE_TRANSIT_ADDRESS: "https://vault.example.test/#secret",
      TOARD_KEY_ACTIVE_TRANSIT_MOUNT: "transit",
      TOARD_KEY_ACTIVE_TRANSIT_KEY_NAME: "toard",
      TOARD_KEY_ACTIVE_TRANSIT_AUTH_METHOD: "token-file",
      TOARD_KEY_ACTIVE_TRANSIT_TOKEN_FILE: "/run/secrets/vault-token",
    }],
    ["vault-transit", {
      TOARD_KEY_ACTIVE_TRANSIT_ADDRESS: "https://user:sentinel@vault.example.test/",
      TOARD_KEY_ACTIVE_TRANSIT_MOUNT: "transit",
      TOARD_KEY_ACTIVE_TRANSIT_KEY_NAME: "toard",
      TOARD_KEY_ACTIVE_TRANSIT_AUTH_METHOD: "token-file",
      TOARD_KEY_ACTIVE_TRANSIT_TOKEN_FILE: "/run/secrets/vault-token",
    }],
    ["vault-transit", {
      TOARD_KEY_ACTIVE_TRANSIT_ADDRESS: "https://vault.example.test/?token=sentinel",
      TOARD_KEY_ACTIVE_TRANSIT_MOUNT: "transit",
      TOARD_KEY_ACTIVE_TRANSIT_KEY_NAME: "toard",
      TOARD_KEY_ACTIVE_TRANSIT_AUTH_METHOD: "token-file",
      TOARD_KEY_ACTIVE_TRANSIT_TOKEN_FILE: "/run/secrets/vault-token",
    }],
  ] as const;

  for (const [provider, env] of cases) {
    assert.throws(
      () => activeConfig(provider, env),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message.includes("sentinel"), false);
        assert.equal(error.message.includes("token="), false);
        assert.equal(error.message.includes("#secret"), false);
        return true;
      },
    );
  }

  assert.equal(activeConfig("aws-kms", {
    TOARD_KEY_ACTIVE_AWS_KEY_ARN: AWS_KEY_ARN,
    TOARD_KEY_ACTIVE_AWS_REGION: "ap-northeast-2",
    TOARD_KEY_ACTIVE_AWS_ENDPOINT: "HTTP://LOCALHOST:80",
  }).active.settings.AWS_ENDPOINT, "http://localhost/");
});

test("AWS KMS ARN은 UUID 또는 MRK key ID와 일치하는 region만 허용한다", () => {
  assert.throws(
    () => activeConfig("aws-kms", {
      TOARD_KEY_ACTIVE_AWS_KEY_ARN: "arn:aws:kms:ap-northeast-2:123456789012:key/key-id",
      TOARD_KEY_ACTIVE_AWS_REGION: "ap-northeast-2",
    }),
    /ARN/,
  );
  assert.throws(
    () => activeConfig("aws-kms", {
      TOARD_KEY_ACTIVE_AWS_KEY_ARN: "arn:aws:kms:ap-northeast-2:123456789012:alias/toard",
      TOARD_KEY_ACTIVE_AWS_REGION: "ap-northeast-2",
    }),
    /ARN/,
  );
  assert.throws(
    () => activeConfig("aws-kms", {
      TOARD_KEY_ACTIVE_AWS_KEY_ARN: AWS_KEY_ARN,
      TOARD_KEY_ACTIVE_AWS_REGION: "us-east-1",
    }),
    /region|AWS_REGION/,
  );

  assert.equal(activeConfig("aws-kms", {
    TOARD_KEY_ACTIVE_AWS_KEY_ARN: AWS_MRK_ARN,
    TOARD_KEY_ACTIVE_AWS_REGION: "us-east-1",
  }).active.settings.AWS_KEY_ARN, AWS_MRK_ARN);
});

test("duplicate identity는 credential mode와 auth file 차이로 우회할 수 없다", () => {
  assert.throws(
    () => loadKeyManagementConfig({
      TOARD_KEY_ACTIVE_PROVIDER: "azure-key-vault",
      TOARD_KEY_ACTIVE_AZURE_KEY_ID: "https://VAULT.vault.azure.net/keys/toard/key-version",
      TOARD_KEY_ACTIVE_AZURE_CREDENTIAL_MODE: "default",
      TOARD_KEY_MIGRATION_PROVIDER: "azure-key-vault",
      TOARD_KEY_MIGRATION_AZURE_KEY_ID: "https://vault.vault.azure.net/keys/toard/key-version",
      TOARD_KEY_MIGRATION_AZURE_CREDENTIAL_MODE: "managed-identity",
      TOARD_KEY_MIGRATION_AZURE_MANAGED_IDENTITY_CLIENT_ID: "client-id",
      NODE_ENV: "development",
    }),
    /fingerprint/,
  );

  assert.throws(
    () => loadKeyManagementConfig({
      TOARD_KEY_ACTIVE_PROVIDER: "vault-transit",
      TOARD_KEY_ACTIVE_TRANSIT_ADDRESS: "https://VAULT.EXAMPLE.TEST:443",
      TOARD_KEY_ACTIVE_TRANSIT_MOUNT: "transit",
      TOARD_KEY_ACTIVE_TRANSIT_KEY_NAME: "toard",
      TOARD_KEY_ACTIVE_TRANSIT_NAMESPACE: "team-a",
      TOARD_KEY_ACTIVE_TRANSIT_AUTH_METHOD: "token-file",
      TOARD_KEY_ACTIVE_TRANSIT_TOKEN_FILE: "/run/secrets/active-token",
      TOARD_KEY_MIGRATION_PROVIDER: "vault-transit",
      TOARD_KEY_MIGRATION_TRANSIT_ADDRESS: "https://vault.example.test/",
      TOARD_KEY_MIGRATION_TRANSIT_MOUNT: "transit",
      TOARD_KEY_MIGRATION_TRANSIT_KEY_NAME: "toard",
      TOARD_KEY_MIGRATION_TRANSIT_NAMESPACE: "team-a",
      TOARD_KEY_MIGRATION_TRANSIT_AUTH_METHOD: "kubernetes",
      TOARD_KEY_MIGRATION_TRANSIT_KUBERNETES_ROLE: "toard",
      TOARD_KEY_MIGRATION_TRANSIT_KUBERNETES_JWT_FILE: "/run/secrets/jwt",
    }),
    /fingerprint/,
  );
});

test("Azure SDK lockfile graph는 root Node >=20 계약을 유지한다", () => {
  const rootPackage = JSON.parse(
    readFileSync(new URL("../../../../package.json", import.meta.url), "utf8"),
  ) as { engines?: { node?: string } };
  assert.equal(rootPackage.engines?.node, ">=20");

  const lockfile = readFileSync(
    new URL("../../../../pnpm-lock.yaml", import.meta.url),
    "utf8",
  );
  const node22AzureEntries = lockfile
    .split(/\n(?= {2}\S)/)
    .filter((block) => (
      /^ {2}'?(?:@azure(?:-rest)?\/|@typespec\/ts-http-runtime)/.test(block)
      && /engines: \{node: '>=22(?:\.0\.0)?'\}/.test(block)
    ))
    .map((block) => block.split("\n", 1)[0]!.trim());
  assert.deepEqual(node22AzureEntries, []);
});

test("Transit auth는 선택한 한 방법의 secret-file 설정만 허용한다", () => {
  const base = {
    TOARD_KEY_ACTIVE_TRANSIT_ADDRESS: "https://vault.example.test:8200",
    TOARD_KEY_ACTIVE_TRANSIT_MOUNT: "transit",
    TOARD_KEY_ACTIVE_TRANSIT_KEY_NAME: "toard",
  };

  for (const [authMethod, requiredVariable] of [
    ["token-file", "TOARD_KEY_ACTIVE_TRANSIT_TOKEN_FILE"],
    ["static-token", "TOARD_KEY_ACTIVE_TRANSIT_TOKEN_FILE"],
    ["kubernetes", "TOARD_KEY_ACTIVE_TRANSIT_KUBERNETES_ROLE"],
    ["approle", "TOARD_KEY_ACTIVE_TRANSIT_APPROLE_ROLE_ID_FILE"],
  ] as const) {
    assert.throws(
      () => activeConfig("vault-transit", {
        ...base,
        TOARD_KEY_ACTIVE_TRANSIT_AUTH_METHOD: authMethod,
      }),
      new RegExp(requiredVariable),
    );
  }

  assert.throws(
    () => activeConfig("vault-transit", {
      ...base,
      TOARD_KEY_ACTIVE_TRANSIT_AUTH_METHOD: "token-file",
      TOARD_KEY_ACTIVE_TRANSIT_TOKEN_FILE: "relative/token",
    }),
    /절대 경로/,
  );
  assert.throws(
    () => activeConfig("vault-transit", {
      ...base,
      TOARD_KEY_ACTIVE_TRANSIT_AUTH_METHOD: "token-file",
      TOARD_KEY_ACTIVE_TRANSIT_TOKEN_FILE: "/run/secrets/vault-token",
      TOARD_KEY_ACTIVE_TRANSIT_KUBERNETES_ROLE: "unexpected-second-method",
    }),
    /KUBERNETES_ROLE|auth/,
  );
  assert.throws(
    () => activeConfig("vault-transit", {
      ...base,
      TOARD_KEY_ACTIVE_TRANSIT_AUTH_METHOD: "static-token",
      TOARD_KEY_ACTIVE_TRANSIT_TOKEN: "raw-token",
    }),
    /raw credential/,
  );
  assert.throws(
    () => activeConfig("vault-transit", {
      ...base,
      TOARD_KEY_ACTIVE_TRANSIT_AUTH_METHOD: "token-file",
      TOARD_KEY_ACTIVE_TRANSIT_TOKEN_FILE: "/run/secrets/vault-token",
      TOARD_KEY_ACTIVE_TRANSIT_TLS_SKIP_VERIFY: "true",
    }),
    /TLS_SKIP_VERIFY|허용/,
  );
});

test("migration profile도 exact provider 계약을 적용한다", () => {
  assert.throws(
    () => activeConfig("local", {
      TOARD_KEY_ACTIVE_LOCAL_KEK_FILE: "/run/secrets/active-kek",
      TOARD_KEY_MIGRATION_AWS_KEY_ARN: AWS_MRK_ARN,
    }),
    /TOARD_KEY_MIGRATION_PROVIDER/,
  );
  assert.throws(
    () => activeConfig("local", {
      TOARD_KEY_ACTIVE_LOCAL_KEK_FILE: "/run/secrets/active-kek",
      TOARD_KEY_MIGRATION_PROVIDER: "gcp-kms",
      TOARD_KEY_MIGRATION_GCP_KEY_NAME: "short-name",
    }),
    /projects\/.*\/cryptoKeys/,
  );

  const config = activeConfig("local", {
    TOARD_KEY_ACTIVE_LOCAL_KEK_FILE: "/run/secrets/active-kek",
    TOARD_KEY_MIGRATION_PROVIDER: "azure-key-vault",
    TOARD_KEY_MIGRATION_AZURE_KEY_ID: "https://vault.vault.azure.net/keys/toard-key/key-version",
    TOARD_KEY_MIGRATION_AZURE_CREDENTIAL_MODE: "workload-identity",
    NODE_ENV: "production",
  });
  assert.deepEqual(config.migration?.settings, {
    AZURE_CREDENTIAL_MODE: "workload-identity",
    AZURE_KEY_ID: "https://vault.vault.azure.net/keys/toard-key/key-version",
  });
});

test("credential 계열 raw 값은 settings와 오류에 노출하지 않는다", () => {
  for (const [provider, variable] of [
    ["aws-kms", "TOARD_KEY_ACTIVE_AWS_ACCESS_KEY_ID"],
    ["gcp-kms", "TOARD_KEY_ACTIVE_GCP_CREDENTIALS_JSON"],
    ["azure-key-vault", "TOARD_KEY_ACTIVE_AZURE_CLIENT_KEY"],
  ] as const) {
    const credential = `sensitive-${provider}`;
    assert.throws(
      () => loadKeyManagementConfig({
        TOARD_KEY_ACTIVE_PROVIDER: provider,
        [variable]: credential,
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /raw credential/);
        assert.equal(error.message.includes(credential), false);
        return true;
      },
    );
  }
});

test("빈 sibling provider 환경변수는 unset으로 취급한다", () => {
  const config = loadKeyManagementConfig({
    TOARD_KEY_ACTIVE_PROVIDER: "local",
    TOARD_KEY_ACTIVE_LOCAL_KEK_FILE: "/run/secrets/kek",
    TOARD_KEY_ACTIVE_AWS_KEY_ARN: "",
    TOARD_KEY_ACTIVE_GCP_KEY_NAME: " ",
    TOARD_KEY_ACTIVE_AZURE_KEY_ID: "\t",
    TOARD_KEY_ACTIVE_TRANSIT_ADDRESS: "\n",
    TOARD_KEY_MIGRATION_PROVIDER: " ",
    TOARD_KEY_MIGRATION_LOCAL_KEK_FILE: "",
  });

  assert.deepEqual(config.active.settings, {
    LOCAL_KEK_FILE: "/run/secrets/kek",
  });
  assert.equal(config.migration, null);
});
