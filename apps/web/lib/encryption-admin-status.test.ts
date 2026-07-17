import assert from "node:assert/strict";
import test from "node:test";
import type { ManagedContentRuntime } from "./managed-content-runtime";
import { getEncryptionAdminStatus } from "./encryption-admin-status";

const STATUS_ROW = {
  server_records: "4",
  e2ee_records: "5",
  managed_records: "6",
  active_user_keys: "7",
  pending_user_keys: "8",
  retiring_user_keys: "9",
  e2ee_migration_pending: "10",
  e2ee_migration_blocked: "11",
};

function runtime(options: {
  provider?: "aws-kms" | "gcp-kms" | "azure-key-vault";
  health?: "healthy" | "unhealthy";
  credential?: { kind: string; staticCredential: boolean };
} = {}): ManagedContentRuntime {
  const provider = options.provider ?? "aws-kms";
  const keyRef = provider === "aws-kms"
    ? "arn:aws:kms:ap-northeast-2:123456789012:key/00000000-0000-0000-0000-000000000001"
    : provider === "gcp-kms"
      ? "projects/acme/locations/global/keyRings/toard/cryptoKeys/content"
      : "https://safe.vault.azure.net/keys/content/version";
  const fingerprint = `${provider}:0123456789abcdef01234567`;
  const active = {
    name: provider,
    keyRef,
    fingerprint,
    wrapKey: async () => { throw new Error("unused"); },
    unwrapKey: async () => { throw new Error("unused"); },
    healthCheck: async () => { throw new Error("unused"); },
    describeCredentialSource: async () => options.credential ?? {
      kind: "aws-default-provider-chain",
      staticCredential: false,
    },
  } as never;
  return {
    installationId: "00000000-0000-0000-0000-000000000001",
    registry: { active } as never,
    userKeys: {} as never,
    health: {
      check: async () => options.health === "unhealthy"
        ? {
            status: "unhealthy",
            latencyMs: 17,
            checkedAt: new Date("2026-07-17T00:00:00.000Z"),
            errorCode: "AUTH_FAILED",
          }
        : {
            status: "healthy",
            latencyMs: 12,
            checkedAt: new Date("2026-07-17T00:00:00.000Z"),
          },
    } as never,
  };
}

function database(operationRows: Array<Record<string, unknown>> = []) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  return {
    calls,
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (/FROM content_encryption_status/i.test(sql)) return { rows: [STATUS_ROW] };
      if (/FROM content_key_operation_daily/i.test(sql)) {
        if (/cache_result\s*=\s*'none'/i.test(sql)) {
          return { rows: operationRows.filter((row) => row.cache_result === "none") };
        }
        if (/cache_result\s*<>\s*'none'/i.test(sql)) {
          return { rows: operationRows.filter((row) => row.cache_result !== "none") };
        }
        return { rows: operationRows };
      }
      throw new Error("unexpected query");
    },
  };
}

test("실제 KMS 호출만 30일 비용에 포함하고 latency는 sum/count 가중 평균이다", async () => {
  const db = database([
    { operation: "wrap", outcome: "success", cache_result: "none", operation_count: "10000", total_latency_ms: "100000" },
    { operation: "wrap", outcome: "success", cache_result: "none", operation_count: "2", total_latency_ms: "1000" },
    { operation: "unwrap", outcome: "throttled", cache_result: "none", operation_count: "9998", total_latency_ms: "29994" },
    { operation: "unwrap", outcome: "success", cache_result: "hit", operation_count: "70000", total_latency_ms: "0" },
    { operation: "unwrap", outcome: "success", cache_result: "miss", operation_count: "5000", total_latency_ms: "0" },
    { operation: "unwrap", outcome: "success", cache_result: "single_flight", operation_count: "300", total_latency_ms: "0" },
  ]);

  const status = await getEncryptionAdminStatus({
    env: { TOARD_KEY_ACTIVE_PROVIDER: "aws-kms" },
    db,
    runtime: runtime(),
  });

  assert.deepEqual(status.operations30d, [
    { operation: "wrap", outcome: "success", count: 10002, averageLatencyMs: 10.098 },
    { operation: "unwrap", outcome: "throttled", count: 9998, averageLatencyMs: 3 },
  ]);
  assert.deepEqual(status.cache30d, { hit: 70000, miss: 5000, singleFlight: 300 });
  assert.deepEqual(status.costEstimate, {
    currency: "USD",
    requestCost: 0.06,
    monthlyKeyCost: 1,
    total: 1.06,
    source: "reference",
    asOf: "2026-07-17",
    grossReference: true,
  });
  const operationQueries = db.calls.filter((call) => /content_key_operation_daily/i.test(call.sql));
  assert.equal(operationQueries.length, 2);
  const operationsQuery = operationQueries.find((call) => /cache_result\s*=\s*'none'/i.test(call.sql))!;
  const cacheQuery = operationQueries.find((call) => /cache_result\s*<>\s*'none'/i.test(call.sql))!;
  assert.match(operationsQuery.sql, /day\s*>=\s*CURRENT_DATE\s*-\s*INTERVAL\s*'29 days'/i);
  assert.deepEqual(operationsQuery.params, ["aws-kms", "aws-kms:0123456789abcdef01234567"]);
  assert.deepEqual(cacheQuery.params, operationsQuery.params);
});

test("operator override는 두 값 모두 명시된 0 이상 finite 숫자만 허용한다", async () => {
  const db = database([
    { operation: "wrap", outcome: "success", cache_result: "none", operation_count: "20000", total_latency_ms: "20" },
  ]);
  const status = await getEncryptionAdminStatus({
    env: {
      TOARD_KEY_ACTIVE_PROVIDER: "aws-kms",
      TOARD_KEY_COST_PER_10000_USD: "0.04",
      TOARD_KEY_MONTHLY_KEY_COST_USD: "1.25",
    },
    db,
    runtime: runtime(),
  });

  assert.deepEqual(status.costEstimate, {
    currency: "USD",
    requestCost: 0.08,
    monthlyKeyCost: 1.25,
    total: 1.33,
    source: "operator-override",
    asOf: null,
    grossReference: true,
  });

  for (const env of [
    { TOARD_KEY_COST_PER_10000_USD: "0.04" },
    { TOARD_KEY_COST_PER_10000_USD: "-1", TOARD_KEY_MONTHLY_KEY_COST_USD: "1" },
    { TOARD_KEY_COST_PER_10000_USD: "Infinity", TOARD_KEY_MONTHLY_KEY_COST_USD: "1" },
    { TOARD_KEY_COST_PER_10000_USD: "1x", TOARD_KEY_MONTHLY_KEY_COST_USD: "1" },
  ]) {
    await assert.rejects(
      getEncryptionAdminStatus({
        env: { TOARD_KEY_ACTIVE_PROVIDER: "aws-kms", ...env },
        db: database(),
        runtime: runtime(),
      }),
      /KEY_COST_OVERRIDE_INVALID/,
    );
  }
});

test("미지원 단가 provider는 override가 없으면 null이고 status JSON은 secret-free다", async () => {
  const status = await getEncryptionAdminStatus({
    env: {
      TOARD_KEY_ACTIVE_PROVIDER: "azure-key-vault",
      AZURE_CLIENT_SECRET: "client_secret=do-not-leak",
      TRANSIT_TOKEN: "token=do-not-leak",
    },
    db: database(),
    runtime: runtime({
      provider: "azure-key-vault",
      credential: { kind: "azure-workload-identity", staticCredential: false },
    }),
  });

  assert.equal(status.costEstimate, null);
  assert.deepEqual(status.credentialSource, {
    kind: "azure-workload-identity",
    staticCredential: false,
  });
  const json = JSON.stringify(status);
  assert.doesNotMatch(json, /client_secret|do-not-leak|TRANSIT_TOKEN|token=/i);
});

test("disabled와 unhealthy를 거짓 healthy 또는 0 비용으로 표현하지 않는다", async () => {
  const disabled = await getEncryptionAdminStatus({ env: {}, db: database(), runtime: null });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.provider, null);
  assert.equal(disabled.health, null);
  assert.equal(disabled.costEstimate, null);

  const unhealthy = await getEncryptionAdminStatus({
    env: { TOARD_KEY_ACTIVE_PROVIDER: "aws-kms" },
    db: database(),
    runtime: runtime({ health: "unhealthy" }),
  });
  assert.equal(unhealthy.health?.status, "unhealthy");
  assert.equal(unhealthy.health?.errorCode, "AUTH_FAILED");
});

test("health 검사 예외와 비정상 결과는 secret-free unhealthy로 축소한다", async () => {
  for (const check of [
    async () => { throw new Error("credential=health-secret"); },
    async () => ({
      status: "unhealthy",
      latencyMs: 1,
      checkedAt: new Date("2026-07-17T00:00:00.000Z"),
      errorCode: "credential=health-secret",
    }),
  ]) {
    const current = runtime();
    current.health.check = check as never;
    const status = await getEncryptionAdminStatus({
      env: { TOARD_KEY_ACTIVE_PROVIDER: "aws-kms" },
      db: database(),
      runtime: current,
    });
    assert.equal(status.health?.status, "unhealthy");
    assert.equal(status.health?.errorCode, "PROVIDER_HEALTH_UNAVAILABLE");
    assert.doesNotMatch(JSON.stringify(status), /health-secret|credential=/i);
  }
});

test("상태 DB 실패와 credential source 실패는 성공 상태로 축소하지 않는다", async () => {
  await assert.rejects(
    getEncryptionAdminStatus({
      env: { TOARD_KEY_ACTIVE_PROVIDER: "aws-kms" },
      db: { query: async () => { throw new Error("password=secret"); } },
      runtime: runtime(),
    }),
    /ENCRYPTION_ADMIN_STATUS_UNAVAILABLE/,
  );

  const broken = runtime();
  broken.registry.active.describeCredentialSource = async () => {
    throw new Error("credential=secret");
  };
  await assert.rejects(
    getEncryptionAdminStatus({
      env: { TOARD_KEY_ACTIVE_PROVIDER: "aws-kms" },
      db: database(),
      runtime: broken,
    }),
    /ENCRYPTION_ADMIN_STATUS_UNAVAILABLE/,
  );
});
