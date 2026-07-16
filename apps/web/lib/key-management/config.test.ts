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
