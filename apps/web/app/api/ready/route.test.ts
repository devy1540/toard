import assert from "node:assert/strict";
import test from "node:test";
import { LATEST_SCHEMA_VERSION } from "@toard/core";
import {
  getContentEncryptionReadiness,
  type ContentEncryptionReadiness,
} from "../../../lib/content-encryption-readiness";
import { awsKmsProviderFingerprint } from "../../../lib/key-management/provider-fingerprint";
import { ProviderHealthCache } from "../../../lib/key-management/provider-health-cache";
import { KeyProviderRegistry } from "../../../lib/key-management/registry";
import type { KeyManagementProvider } from "../../../lib/key-management/types";
import type { ManagedContentRuntime } from "../../../lib/managed-content-runtime";
import { GET } from "./route";

const DISABLED: ContentEncryptionReadiness = {
  status: "disabled",
  provider: null,
  keyRef: null,
  fingerprint: null,
  managedRecords: 0,
  lastCheckAt: null,
  errorCode: null,
};

const DEGRADED: ContentEncryptionReadiness = {
  status: "degraded",
  provider: "aws-kms",
  keyRef:
    "arn:aws:kms:ap-northeast-2:123456789012:key/12345678-1234-1234-1234-123456789012",
  fingerprint: "aws-kms:0123456789abcdef01234567",
  managedRecords: 2,
  lastCheckAt: "2026-07-17T01:02:03.000Z",
  errorCode: "TEMPORARY",
};

const RELEASE_COMPLETION_ID = "c".repeat(64);
const RELEASE_ENV = {
  TOARD_DEPLOYMENT_ID: "toard/toard",
  TOARD_RELEASE_COMPLETION_ID: RELEASE_COMPLETION_ID,
  TOARD_EXPECTED_SCHEMA_VERSION: String(LATEST_SCHEMA_VERSION),
};

function dependencies(
  contentEncryption: ContentEncryptionReadiness = DISABLED,
) {
  const calls: string[] = [];
  const pool = {
    async query(sql: string) {
      calls.push(`query:${sql}`);
      return { rows: [] };
    },
  };
  return {
    calls,
    overrides: {
      env: {},
      getPool: () => {
        calls.push("pool");
        return pool;
      },
      assertLegacyContentKeyReady: async () => {
        calls.push("legacy");
      },
      assertManagedContentDatabaseRoleReady: async () => {
        calls.push("role");
      },
      getManagedContentRuntime: async () => {
        calls.push("runtime");
        return null;
      },
      getContentEncryptionReadiness: async () => {
        calls.push("managed");
        return contentEncryption;
      },
      pingClickHouse: async () => {
        calls.push("clickhouse");
      },
      getTimezoneRollupReadinessAt: async () => {
        calls.push("rollup");
        return {
          status: "disabled" as const,
          watermark: null,
          lagSeconds: null,
          pendingJobs: 0,
          legacyFlagMigration: null,
        };
      },
      getServerVersion: () => "0.0.0",
    },
  };
}

test("ready payload에 disabled contentEncryption을 추가하고 DB 확보 뒤 검사한다", async () => {
  const { calls, overrides } = dependencies();
  const response = await GET.withDependencies(overrides)();

  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).contentEncryption, DISABLED);
  assert.deepEqual(calls.slice(0, 6), [
    "pool",
    "query:SELECT 1",
    "legacy",
    "role",
    "runtime",
    "managed",
  ]);
  assert.equal(calls.includes("clickhouse"), false);
});

test("관리형 본문 role readiness 오류는 role/DB detail 없이 503으로 fail-closed한다", async () => {
  const unsafeRoleDetail = "owner_role password=not-for-response";
  const { calls, overrides } = dependencies();
  const response = await GET.withDependencies({
    ...overrides,
    env: {
      TOARD_KEY_ACTIVE_PROVIDER: "aws-kms",
      TOARD_KEY_ACTIVE_AWS_KEY_ARN:
        "arn:aws:kms:ap-northeast-2:123456789012:key/12345678-1234-1234-1234-123456789012",
      TOARD_KEY_ACTIVE_AWS_REGION: "ap-northeast-2",
    },
    assertManagedContentDatabaseRoleReady: async () => {
      calls.push("role");
      throw new Error(`MANAGED_CONTENT_DATABASE_ROLE_UNSAFE ${unsafeRoleDetail}`);
    },
    getManagedContentRuntime: async () => {
      calls.push("runtime");
      return null;
    },
  })();
  const text = await response.text();

  assert.equal(response.status, 503);
  assert.deepEqual(JSON.parse(text), { status: "not-ready" });
  assert.equal(text.includes(unsafeRoleDetail), false);
  assert.deepEqual(calls.slice(0, 4), [
    "pool",
    "query:SELECT 1",
    "legacy",
    "role",
  ]);
  assert.equal(calls.includes("runtime"), false);
});

test("temporary managed provider 장애는 degraded payload로 200을 유지한다", async () => {
  const { overrides } = dependencies(DEGRADED);
  const response = await GET.withDependencies(overrides)();
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.contentEncryption, DEGRADED);
  assert.equal(body.status, "ready");
});

test("hostile checkedAt accessor는 secret DTO 대신 고정 503을 반환한다", async () => {
  const secret = "secret-date-token";
  const checkedAt = new Date("2026-07-17T01:02:03.000Z");
  Object.defineProperty(checkedAt, "toISOString", { value: () => secret });
  const keyRef =
    "arn:aws:kms:ap-northeast-2:123456789012:key/12345678-1234-1234-1234-123456789012";
  const provider: KeyManagementProvider = {
    name: "aws-kms",
    keyRef,
    fingerprint: awsKmsProviderFingerprint(keyRef, "ap-northeast-2"),
    async wrapKey() {
      throw new Error("unused");
    },
    async unwrapKey() {
      throw new Error("unused");
    },
    async healthCheck() {
      throw new Error("unused");
    },
    async describeCredentialSource() {
      return { kind: "test", staticCredential: false };
    },
  };
  const runtime: ManagedContentRuntime = {
    installationId: "installation",
    registry: new KeyProviderRegistry(provider, null),
    userKeys: {
      async withActiveUserKey() {
        throw new Error("unused");
      },
      async withUserKeyVersion() {
        throw new Error("unused");
      },
    } as ManagedContentRuntime["userKeys"],
    health: new ProviderHealthCache({
      check: async () => {
        return { status: "healthy" as const, latencyMs: 1, checkedAt };
      },
    }),
  };
  const { overrides } = dependencies();
  const response = await GET.withDependencies({
    ...overrides,
    env: {
      TOARD_KEY_ACTIVE_PROVIDER: "aws-kms",
      TOARD_KEY_ACTIVE_AWS_KEY_ARN: keyRef,
      TOARD_KEY_ACTIVE_AWS_REGION: "ap-northeast-2",
    },
    getPool: () => ({
      async query(sql: string) {
        return /content_encryption_status/.test(sql)
          ? { rows: [{ managed_records: "1" }] }
          : { rows: [] };
      },
    }),
    getManagedContentRuntime: async () => runtime,
    getContentEncryptionReadiness,
  })();
  const text = await response.text();

  assert.equal(response.status, 503);
  assert.deepEqual(JSON.parse(text), { status: "not-ready" });
  assert.equal(text.includes(secret), false);
});

test("managed permanent/config/runtime/DB 오류는 detail 없이 503만 반환한다", async () => {
  const failures = [
    {
      error: new Error("AUTH_FAILED secret=credential"),
      override: {
        getContentEncryptionReadiness: async () => {
          throw new Error("AUTH_FAILED secret=credential");
        },
      },
    },
    {
      error: new Error("MANAGED_KEY_CONFIG_INVALID TOARD_KEY_ACTIVE_SECRET"),
      override: {
        getManagedContentRuntime: async () => {
          throw new Error(
            "MANAGED_KEY_CONFIG_INVALID TOARD_KEY_ACTIVE_SECRET",
          );
        },
      },
    },
    {
      error: new Error("database detail"),
      override: {
        getPool: () => ({
          async query() {
            throw new Error("database detail");
          },
        }),
      },
    },
  ];
  for (const { error, override } of failures) {
    const { overrides } = dependencies();
    const response = await GET.withDependencies({
      ...overrides,
      ...override,
    })();
    const text = await response.text();

    assert.equal(response.status, 503);
    assert.deepEqual(JSON.parse(text), { status: "not-ready" });
    assert.equal(text.includes(error.message), false);
  }
});

test("기존 ClickHouse ping, rollup fallback, historical pricing payload 계약을 유지한다", async () => {
  const { calls, overrides } = dependencies();
  const response = await GET.withDependencies({
    ...overrides,
    env: { STORAGE_BACKEND: "clickhouse", CLICKHOUSE_READ_ROLLUP: "1" },
    getTimezoneRollupReadinessAt: async () => {
      calls.push("rollup");
      throw new Error("observation unavailable");
    },
    getServerVersion: () => "0.15.16",
  })();
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(calls.includes("clickhouse"), true);
  assert.equal(calls.includes("rollup"), true);
  assert.deepEqual(body.rollups, {
    timezone: "fallback",
    timezoneWatermark: null,
    timezoneLagSeconds: null,
    timezonePendingJobs: 0,
    legacyFlagMigration: "deprecated_alias",
  });
  assert.deepEqual(body.historicalPricingReader, {
    currentVersion: "0.15.16",
    minimumVersion: "0.15.16",
    compatible: true,
  });
});

test("Helm env가 설정되면 exact completion marker 전에는 503이고 일치한 뒤에만 200이다", async () => {
  for (const marker of ["missing", "wrong", "correct"] as const) {
    const { overrides } = dependencies();
    const response = await GET.withDependencies({
      ...overrides,
      env: RELEASE_ENV,
      getPool: () => ({
        async query(sql: string, params?: unknown[]) {
          if (/deployment_release_completions/.test(sql)) {
            assert.equal(params?.length, 3);
            const exact = params?.[1] === RELEASE_COMPLETION_ID;
            return { rows: marker === "correct" && exact ? [{ ok: 1 }] : [] };
          }
          return { rows: [] };
        },
      }),
    })();
    assert.equal(response.status, marker === "correct" ? 200 : 503);
    assert.equal((await response.text()).includes(RELEASE_COMPLETION_ID), false);
  }
});

test("partial release env와 marker query 오류는 detail 없이 503이다", async () => {
  const cases = [
    {
      env: { TOARD_DEPLOYMENT_ID: "toard/toard" },
      getPool: dependencies().overrides.getPool,
    },
    {
      env: RELEASE_ENV,
      getPool: () => ({
        async query(sql: string) {
          if (/deployment_release_completions/.test(sql)) {
            throw new Error(`relation missing ${RELEASE_COMPLETION_ID}`);
          }
          return { rows: [] };
        },
      }),
    },
  ];
  for (const releaseCase of cases) {
    const { overrides } = dependencies();
    const response = await GET.withDependencies({
      ...overrides,
      env: releaseCase.env,
      getPool: releaseCase.getPool,
    })();
    const text = await response.text();
    assert.equal(response.status, 503);
    assert.deepEqual(JSON.parse(text), { status: "not-ready" });
    assert.equal(text.includes(RELEASE_COMPLETION_ID), false);
  }
});
