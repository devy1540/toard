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
  wrapper_distribution: [
    { provider: "aws-kms", provider_fingerprint: "aws-kms:0123456789abcdef01234567", state: "active", wrapper_count: "7" },
    { provider: "aws-kms", provider_fingerprint: "aws-kms:0123456789abcdef01234567", state: "pending", wrapper_count: "8" },
    { provider: "aws-kms", provider_fingerprint: "aws-kms:0123456789abcdef01234567", state: "retiring", wrapper_count: "9" },
  ],
};

function runtime(options: {
  provider?: "aws-kms" | "gcp-kms" | "azure-key-vault";
  health?: "healthy" | "unhealthy";
  credential?: { kind: string; staticCredential: boolean };
  migrationProvider?: "gcp-kms";
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
  const migration = options.migrationProvider === "gcp-kms" ? {
    name: "gcp-kms",
    keyRef: "projects/acme/locations/global/keyRings/toard/cryptoKeys/target",
    fingerprint: "gcp-kms:222222222222222222222222",
    describeCredentialSource: async () => ({ kind: "gcp-application-default", staticCredential: false }),
  } : undefined;
  return {
    installationId: "00000000-0000-0000-0000-000000000001",
    registry: { active, migration } as never,
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

function database(
  operationRows: Array<Record<string, unknown>> = [],
  statusRow: Record<string, unknown> = STATUS_ROW,
) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  return {
    calls,
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (/FROM content_encryption_status/i.test(sql)) return { rows: [statusRow] };
      if (/FROM content_key_operation_daily/i.test(sql)) {
        if (/active_operation_count/i.test(sql)) {
          const [provider, fingerprint] = params;
          const count = operationRows
            .filter((row) => row.cache_result === "none")
            .filter((row) => row.provider === undefined || row.provider === provider)
            .filter((row) => row.provider_fingerprint === undefined || row.provider_fingerprint === fingerprint)
            .reduce((sum, row) => sum + BigInt(row.operation_count as string), 0n);
          const rows = operationRows.filter((row) => row.cache_result === "none");
          return {
            rows: rows.length > 0
              ? rows.map((row) => ({ ...row, active_operation_count: count.toString() }))
              : [{
                  operation: null,
                  outcome: null,
                  operation_count: null,
                  total_latency_ms: null,
                  active_operation_count: count.toString(),
                }],
          };
        }
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

test("provider/fingerprint/state 분포와 old provider 제거 가능 여부를 같은 secret-free snapshot으로 반환한다", async () => {
  const readyRow = {
    ...STATUS_ROW,
    active_user_keys: "7",
    pending_user_keys: "0",
    retiring_user_keys: "7",
    wrapper_distribution: [
      { provider: "gcp-kms", provider_fingerprint: "gcp-kms:222222222222222222222222", state: "active", wrapper_count: "7" },
      { provider: "aws-kms", provider_fingerprint: "aws-kms:0123456789abcdef01234567", state: "retiring", wrapper_count: "7" },
    ],
  };
  const db = database([], readyRow);
  const status = await getEncryptionAdminStatus({
    env: { TOARD_KEY_ACTIVE_PROVIDER: "aws-kms" },
    db,
    runtime: runtime({ migrationProvider: "gcp-kms" }),
  });

  assert.deepEqual(status.wrapperDistribution, [
    { provider: "gcp-kms", providerFingerprint: "gcp-kms:222222222222222222222222", state: "active", count: 7 },
    { provider: "aws-kms", providerFingerprint: "aws-kms:0123456789abcdef01234567", state: "retiring", count: 7 },
  ]);
  assert.deepEqual(status.providerMigration, {
    old: { provider: "aws-kms", providerFingerprint: "aws-kms:0123456789abcdef01234567" },
    target: { provider: "gcp-kms", providerFingerprint: "gcp-kms:222222222222222222222222" },
    totalActiveWrappers: 7,
    oldActiveWrappers: 0,
    targetActiveWrappers: 7,
    pendingWrappers: 0,
    unexpectedActiveWrappers: 0,
    removalReady: true,
  });
  assert.deepEqual(status.migrationTarget, {
    provider: "gcp-kms",
    keyRef: "projects/acme/locations/global/keyRings/toard/cryptoKeys/target",
    fingerprint: "gcp-kms:222222222222222222222222",
    credentialSource: { kind: "gcp-application-default", staticCredential: false },
    health: {
      status: "healthy",
      latencyMs: 12,
      checkedAt: new Date("2026-07-17T00:00:00.000Z"),
    },
  });
  assert.equal(db.calls.filter((call) => /content_encryption_status/i.test(call.sql)).length, 1);
  assert.match(db.calls.find((call) => /content_encryption_status/i.test(call.sql))!.sql, /managed_content_key_distribution/i);
  assert.doesNotMatch(JSON.stringify(status), /wrapped_user_key|key material|credential=|secret/i);
});

test("예상 밖 fingerprint, pending, target 부재와 malformed distribution은 제거 가능으로 축소하지 않는다", async () => {
  const unexpected = {
    ...STATUS_ROW,
    active_user_keys: "1",
    pending_user_keys: "0",
    retiring_user_keys: "0",
    wrapper_distribution: [
      { provider: "gcp-kms", provider_fingerprint: "gcp-kms:333333333333333333333333", state: "active", wrapper_count: "1" },
    ],
  };
  const status = await getEncryptionAdminStatus({
    env: { TOARD_KEY_ACTIVE_PROVIDER: "aws-kms" },
    db: database([], unexpected),
    runtime: runtime({ migrationProvider: "gcp-kms" }),
  });
  assert.equal(status.providerMigration.unexpectedActiveWrappers, 1);
  assert.equal(status.providerMigration.removalReady, false);

  const noTarget = await getEncryptionAdminStatus({
    env: { TOARD_KEY_ACTIVE_PROVIDER: "aws-kms" },
    db: database(),
    runtime: runtime(),
  });
  assert.equal(noTarget.providerMigration.target, null);
  assert.equal(noTarget.providerMigration.removalReady, false);

  for (const wrapperDistribution of [
    [{ provider: "aws-kms", provider_fingerprint: "aws-kms:0123456789abcdef01234567", state: "active", wrapper_count: "01" }],
    [{ provider: "aws-kms", provider_fingerprint: "aws-kms:0123456789abcdef01234567", state: "active", wrapper_count: "1", token: "secret" }],
  ]) {
    await assert.rejects(
      getEncryptionAdminStatus({
        env: { TOARD_KEY_ACTIVE_PROVIDER: "aws-kms" },
        db: database([], { ...STATUS_ROW, wrapper_distribution: wrapperDistribution }),
        runtime: runtime({ migrationProvider: "gcp-kms" }),
      }),
      /ENCRYPTION_ADMIN_STATUS_UNAVAILABLE/,
    );
  }
});

test("실제 KMS 호출만 30일 비용에 포함하고 latency는 sum/count 가중 평균이다", async () => {
  const db = database([
    { provider: "aws-kms", operation: "wrap", outcome: "success", cache_result: "none", operation_count: "10000", total_latency_ms: "100000" },
    { provider: "aws-kms", operation: "wrap", outcome: "success", cache_result: "none", operation_count: "2", total_latency_ms: "1000" },
    { provider: "aws-kms", operation: "unwrap", outcome: "throttled", cache_result: "none", operation_count: "9998", total_latency_ms: "29994" },
    { provider: "gcp-kms", operation: "wrap", outcome: "success", cache_result: "none", operation_count: "5000", total_latency_ms: "25000" },
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
    { operation: "wrap", outcome: "success", count: 15002, averageLatencyMs: 8.399 },
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
    scope: "active-provider-only",
    includedRequests: 20000,
    excludedRequests: 5000,
  });
  const operationQueries = db.calls.filter((call) => /content_key_operation_daily/i.test(call.sql));
  assert.equal(operationQueries.length, 2);
  const operationsQuery = operationQueries.find((call) => /active_operation_count/i.test(call.sql))!;
  const cacheQuery = operationQueries.find((call) => /cache_result\s*<>\s*'none'/i.test(call.sql))!;
  for (const query of operationQueries) {
    assert.match(query.sql, /day\s+BETWEEN\s+CURRENT_DATE\s*-\s*INTERVAL\s*'29 days'\s+AND\s+CURRENT_DATE/i);
  }
  assert.match(operationsQuery.sql, /WITH\s+bounded\s+AS/i);
  assert.match(operationsQuery.sql, /LEFT\s+JOIN\s+grouped/i);
  assert.deepEqual(operationsQuery.params, ["aws-kms", "aws-kms:0123456789abcdef01234567"]);
  assert.deepEqual(cacheQuery.params, []);
});

test("none row가 없어도 single snapshot contract는 operations=[]와 active count=0을 반환한다", async () => {
  const db = database();
  const status = await getEncryptionAdminStatus({
    env: { TOARD_KEY_ACTIVE_PROVIDER: "aws-kms" },
    db,
    runtime: runtime(),
  });

  assert.deepEqual(status.operations30d, []);
  assert.deepEqual(status.costEstimate, {
    currency: "USD",
    requestCost: 0,
    monthlyKeyCost: 1,
    total: 1,
    source: "reference",
    asOf: "2026-07-17",
    grossReference: true,
    scope: "active-provider-only",
    includedRequests: 0,
    excludedRequests: 0,
  });
  const operationQueries = db.calls.filter((call) => /content_key_operation_daily/i.test(call.sql));
  assert.equal(operationQueries.length, 2);
  assert.equal(operationQueries.filter((call) => /active_operation_count/i.test(call.sql)).length, 1);
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
    scope: "active-provider-only",
    includedRequests: 20000,
    excludedRequests: 0,
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

test("finite override의 비용 산술 overflow와 집계 overflow는 fail-closed다", async () => {
  await assert.rejects(
    getEncryptionAdminStatus({
      env: {
        TOARD_KEY_ACTIVE_PROVIDER: "aws-kms",
        TOARD_KEY_COST_PER_10000_USD: "9".repeat(308),
        TOARD_KEY_MONTHLY_KEY_COST_USD: "1",
      },
      db: database([
        { operation: "wrap", outcome: "success", cache_result: "none", operation_count: "20000", total_latency_ms: "20" },
      ]),
      runtime: runtime(),
    }),
    /ENCRYPTION_ADMIN_STATUS_UNAVAILABLE/,
  );

  const hugeReference = await getEncryptionAdminStatus({
    env: { TOARD_KEY_ACTIVE_PROVIDER: "aws-kms" },
    db: database([
      {
        operation: "wrap",
        outcome: "success",
        cache_result: "none",
        operation_count: Number.MAX_SAFE_INTEGER.toString(),
        total_latency_ms: Number.MAX_SAFE_INTEGER.toString(),
      },
    ]),
    runtime: runtime(),
  });
  assert.ok(Number.isFinite(hugeReference.costEstimate?.requestCost));
  assert.ok(Number.isFinite(hugeReference.costEstimate?.total));
  assert.ok((hugeReference.costEstimate?.requestCost ?? -1) >= 0);
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
  assert.equal(disabled.migrationTarget, null);
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

test("credential/health hostile getter, Proxy, extra, inherited 필드는 secret-free로 fail-closed다", async () => {
  let healthReads = 0;
  const healthGetter = Object.defineProperties({}, {
    status: { enumerable: true, get: () => (++healthReads === 1 ? "healthy" : "client_secret=health") },
    latencyMs: { enumerable: true, value: 1 },
    checkedAt: { enumerable: true, value: new Date("2026-07-17T00:00:00.000Z") },
  });
  const healthExtra = {
    status: "healthy",
    latencyMs: 1,
    checkedAt: new Date("2026-07-17T00:00:00.000Z"),
    token: "health-extra-secret",
  };
  const healthWrongShape = {
    status: "healthy",
    latencyMs: 1,
    checkedAt: new Date("2026-07-17T00:00:00.000Z"),
    errorCode: "client_secret=wrong-shape",
  };
  const healthProxy = new Proxy({}, {
    ownKeys() { throw new Error("client_secret=proxy-secret"); },
    get() { throw new Error("token=proxy-secret"); },
  });
  for (const hostile of [healthGetter, healthExtra, healthWrongShape, healthProxy]) {
    const current = runtime();
    current.health.check = async () => hostile as never;
    const status = await getEncryptionAdminStatus({
      env: { TOARD_KEY_ACTIVE_PROVIDER: "aws-kms" },
      db: database(),
      runtime: current,
    });
    assert.equal(status.health?.status, "unhealthy");
    assert.equal(status.health?.errorCode, "PROVIDER_HEALTH_UNAVAILABLE");
    assert.doesNotMatch(JSON.stringify(status), /client_secret|proxy-secret|health-extra-secret|token=/i);
  }

  let credentialReads = 0;
  const credentialGetter = Object.defineProperties({}, {
    kind: { enumerable: true, get: () => (++credentialReads === 1 ? "safe-kind" : "client_secret=credential") },
    staticCredential: { enumerable: true, value: false },
  });
  const inherited = Object.create({
    get kind() { return "client_secret=inherited"; },
  });
  Object.defineProperty(inherited, "staticCredential", { enumerable: true, value: false });
  const credentialExtra = { kind: "safe-kind", staticCredential: false, token: "credential-extra-secret" };
  const credentialProxy = new Proxy({}, {
    ownKeys() { throw new Error("token=credential-proxy-secret"); },
    getOwnPropertyDescriptor() { throw new Error("client_secret=credential-proxy-secret"); },
  });
  for (const hostile of [credentialGetter, inherited, credentialExtra, credentialProxy]) {
    const current = runtime();
    current.registry.active.describeCredentialSource = async () => hostile as never;
    await assert.rejects(
      getEncryptionAdminStatus({
        env: { TOARD_KEY_ACTIVE_PROVIDER: "aws-kms" },
        db: database(),
        runtime: current,
      }),
      (error: unknown) => {
        assert.equal((error as Error).message, "ENCRYPTION_ADMIN_STATUS_UNAVAILABLE");
        assert.doesNotMatch((error as Error).message, /client_secret|token|secret/i);
        return true;
      },
    );
  }
});

test("최근 30일 query는 미래 날짜를 제외하는 상한을 모두 가진다", async () => {
  const base = database();
  const db = {
    calls: base.calls,
    query: async (sql: string, params: unknown[] = []) => {
      if (
        /content_key_operation_daily/i.test(sql)
        && !/BETWEEN\s+CURRENT_DATE\s*-\s*INTERVAL\s*'29 days'\s+AND\s+CURRENT_DATE/i.test(sql)
      ) {
        throw new Error("future row included");
      }
      return base.query(sql, params);
    },
  };
  const status = await getEncryptionAdminStatus({
    env: { TOARD_KEY_ACTIVE_PROVIDER: "aws-kms" },
    db,
    runtime: runtime(),
  });
  assert.equal(status.operations30d.length, 0);
  assert.equal(db.calls.filter((call) => /content_key_operation_daily/i.test(call.sql)).length, 2);
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
