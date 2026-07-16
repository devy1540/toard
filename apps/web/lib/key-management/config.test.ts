import assert from "node:assert/strict";
import test from "node:test";
import { loadKeyManagementConfig } from "./config";

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

test("migration은 active와 다른 provider 설정만 허용한다", () => {
  assert.throws(
    () => loadKeyManagementConfig({
      TOARD_KEY_ACTIVE_PROVIDER: "local",
      TOARD_KEY_ACTIVE_LOCAL_KEK_FILE: "/run/secrets/kek",
      TOARD_KEY_MIGRATION_PROVIDER: "local",
      TOARD_KEY_MIGRATION_LOCAL_KEK_FILE: "/run/secrets/kek",
    }),
    /fingerprint/,
  );

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
    /AWS_/,
  );
  assert.throws(
    () => loadKeyManagementConfig({
      TOARD_KEY_ACTIVE_PROVIDER: "aws-kms",
      TOARD_KEY_ACTIVE_AWS_KEY_ARN: "arn:aws:kms:region:account:key/id",
      TOARD_KEY_ACTIVE_AWS_SECRET_ACCESS_KEY: "must-not-enter-settings",
    }),
    /raw credential/,
  );

  const config = loadKeyManagementConfig({
    TOARD_KEY_ACTIVE_PROVIDER: "aws-kms",
    TOARD_KEY_ACTIVE_AWS_KEY_ARN: "arn:aws:kms:region:account:key/id",
    TOARD_KEY_ACTIVE_AWS_REGION: "ap-northeast-2",
  });
  assert.deepEqual(config.active.settings, {
    AWS_KEY_ARN: "arn:aws:kms:region:account:key/id",
    AWS_REGION: "ap-northeast-2",
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
