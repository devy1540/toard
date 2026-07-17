import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import test from "node:test";
import {
  LATEST_SCHEMA_VERSION,
  parseDeploymentReleaseEnvironment,
} from "./deployment-release";

const VALID_ENV = {
  TOARD_DEPLOYMENT_ID: "toard/toard",
  TOARD_RELEASE_REVISION: "12",
  TOARD_RELEASE_TOKEN: "A".repeat(48),
  TOARD_EXPECTED_SCHEMA_VERSION: String(LATEST_SCHEMA_VERSION),
};

test("deployment release schema version은 실제 latest migration과 일치한다", async () => {
  const migrationDirectory = new URL("../../../migrations/", import.meta.url);
  const versions = (await readdir(migrationDirectory))
    .flatMap((name) => {
      const match = /^(\d+)_.*\.sql$/.exec(name);
      return match ? [Number(match[1])] : [];
    })
    .sort((left, right) => left - right);

  assert.equal(versions.at(-1), LATEST_SCHEMA_VERSION);
});

test("deployment release env 네 개가 모두 unset이면 guard를 비활성화한다", () => {
  assert.equal(parseDeploymentReleaseEnvironment({}), null);
});

test("deployment release env를 canonical identity로 검증한다", () => {
  assert.deepEqual(parseDeploymentReleaseEnvironment(VALID_ENV), {
    deploymentId: "toard/toard",
    releaseRevision: 12,
    releaseToken: VALID_ENV.TOARD_RELEASE_TOKEN,
    expectedSchemaVersion: LATEST_SCHEMA_VERSION,
  });
});

test("partial 또는 non-canonical deployment release env를 거부한다", () => {
  const invalid = [
    { TOARD_DEPLOYMENT_ID: "toard/toard" },
    { ...VALID_ENV, TOARD_DEPLOYMENT_ID: "TOARD/toard" },
    { ...VALID_ENV, TOARD_DEPLOYMENT_ID: "toard" },
    { ...VALID_ENV, TOARD_RELEASE_REVISION: "01" },
    { ...VALID_ENV, TOARD_RELEASE_REVISION: "2147483648" },
    { ...VALID_ENV, TOARD_RELEASE_TOKEN: "A".repeat(47) },
    { ...VALID_ENV, TOARD_RELEASE_TOKEN: `${"A".repeat(47)}-` },
    { ...VALID_ENV, TOARD_EXPECTED_SCHEMA_VERSION: "1700000037" },
    { ...VALID_ENV, TOARD_EXPECTED_SCHEMA_VERSION: `0${LATEST_SCHEMA_VERSION}` },
    { ...VALID_ENV, TOARD_RELEASE_TOKEN: "" },
  ];
  for (const env of invalid) {
    assert.throws(
      () => parseDeploymentReleaseEnvironment(env),
      /DEPLOYMENT_RELEASE_ENV_INVALID/,
    );
  }
});
