import assert from "node:assert/strict";
import test from "node:test";
import type { ManagedContentRuntime } from "./managed-content-runtime";
import { KeyProviderRegistry } from "./key-management/registry";
import {
  getContentEncryptionReadiness,
  type ContentEncryptionReadinessDb,
} from "./content-encryption-readiness";
import type {
  CredentialSourceSummary,
  KeyContext,
  KeyManagementProvider,
  KeyProviderHealth,
  WrappedUserKey,
} from "./key-management/types";

const AWS_KEY_ARN =
  "arn:aws:kms:ap-northeast-2:123456789012:key/12345678-1234-1234-1234-123456789012";
const VALID_ENV = {
  TOARD_KEY_ACTIVE_PROVIDER: "aws-kms",
  TOARD_KEY_ACTIVE_AWS_KEY_ARN: AWS_KEY_ARN,
  TOARD_KEY_ACTIVE_AWS_REGION: "ap-northeast-2",
};

class ReadinessProvider implements KeyManagementProvider {
  readonly name = "aws-kms" as const;
  readonly keyRef = AWS_KEY_ARN;
  readonly fingerprint = "aws-kms:0123456789abcdef01234567";

  async wrapKey(_uck: Buffer, _context: KeyContext): Promise<WrappedUserKey> {
    throw new Error("unused");
  }

  async unwrapKey(
    _wrapped: WrappedUserKey,
    _context: KeyContext,
  ): Promise<Buffer> {
    throw new Error("unused");
  }

  async healthCheck(): Promise<KeyProviderHealth> {
    throw new Error("unused");
  }

  async describeCredentialSource(): Promise<CredentialSourceSummary> {
    return { kind: "test", staticCredential: false };
  }
}

function dbStatus(
  row: Record<string, unknown> | null = { managed_records: "0" },
): ContentEncryptionReadinessDb & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async query(sql) {
      calls.push(sql);
      return { rows: row === null ? [] : [row] };
    },
  };
}

function runtimeHealth(
  health: KeyProviderHealth | Record<string, unknown>,
): ManagedContentRuntime & {
  calls: KeyManagementProvider[];
} {
  const provider = new ReadinessProvider();
  const calls: KeyManagementProvider[] = [];
  return {
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
    health: {
      async check(candidate: KeyManagementProvider) {
        calls.push(candidate);
        return health as KeyProviderHealth;
      },
    } as ManagedContentRuntime["health"],
    calls,
  };
}

test("provider 미설정이고 managed row가 없으면 disabled이며 외부 health를 호출하지 않는다", async () => {
  const db = dbStatus();
  const status = await getContentEncryptionReadiness(db, {}, null);

  assert.deepEqual(status, {
    status: "disabled",
    provider: null,
    keyRef: null,
    fingerprint: null,
    managedRecords: 0,
    lastCheckAt: null,
    errorCode: null,
  });
  assert.equal(db.calls.length, 1);
  assert.match(db.calls[0]!, /FROM content_encryption_status/i);
  assert.doesNotMatch(db.calls[0]!, /prompt_records|managed_user_keys/i);
});

test("provider 미설정인데 runtime이 존재하면 fail-closed다", async () => {
  await assert.rejects(
    getContentEncryptionReadiness(
      dbStatus(),
      {},
      runtimeHealth({
        status: "healthy",
        latencyMs: 1,
        checkedAt: new Date(),
      }),
    ),
    /MANAGED_KEY_RUNTIME_MISMATCH/,
  );
});

test("managed rows without active provider are not ready", async () => {
  await assert.rejects(
    getContentEncryptionReadiness(
      dbStatus({ managed_records: "2" }),
      {},
      null,
    ),
    /MANAGED_KEY_PROVIDER_MISSING/,
  );
});

test("partial 또는 invalid managed config와 runtime null은 not-ready다", async () => {
  await assert.rejects(
    getContentEncryptionReadiness(
      dbStatus(),
      { TOARD_KEY_ACTIVE_AWS_REGION: "ap-northeast-2" },
      null,
    ),
    /MANAGED_KEY_CONFIG_INVALID/,
  );
  await assert.rejects(
    getContentEncryptionReadiness(
      dbStatus(),
      { TOARD_KEY_ACTIVE_PROVIDER: "aws-kms" },
      null,
    ),
    /MANAGED_KEY_CONFIG_INVALID/,
  );
  await assert.rejects(
    getContentEncryptionReadiness(dbStatus(), VALID_ENV, null),
    /MANAGED_KEY_RUNTIME_MISSING/,
  );
});

test("runtime active provider가 config와 다르면 not-ready다", async () => {
  const runtime = runtimeHealth({
    status: "healthy",
    latencyMs: 1,
    checkedAt: new Date("2026-07-17T01:02:03.000Z"),
  });
  Object.defineProperty(runtime.registry.active, "keyRef", {
    value:
      "arn:aws:kms:ap-northeast-2:123456789012:key/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  });

  await assert.rejects(
    getContentEncryptionReadiness(dbStatus(), VALID_ENV, runtime),
    /MANAGED_KEY_RUNTIME_MISMATCH/,
  );
  assert.equal(runtime.calls.length, 0);
});

test("healthy는 active provider exact instance와 공개 식별자만 반환한다", async () => {
  const runtime = runtimeHealth({
    status: "healthy",
    latencyMs: 12,
    checkedAt: new Date("2026-07-17T01:02:03.000Z"),
  });
  const status = await getContentEncryptionReadiness(
    dbStatus({ managed_records: 2 }),
    VALID_ENV,
    runtime,
  );

  assert.deepEqual(status, {
    status: "healthy",
    provider: "aws-kms",
    keyRef: AWS_KEY_ARN,
    fingerprint: "aws-kms:0123456789abcdef01234567",
    managedRecords: 2,
    lastCheckAt: "2026-07-17T01:02:03.000Z",
    errorCode: null,
  });
  assert.deepEqual(runtime.calls, [runtime.registry.active]);
});

test("runtime의 malformed fingerprint는 readiness payload에 노출하지 않고 거부한다", async () => {
  const runtime = runtimeHealth({
    status: "healthy",
    latencyMs: 1,
    checkedAt: new Date(),
  });
  Object.defineProperty(runtime.registry.active, "fingerprint", {
    value: "aws-kms:secret-path-or-token",
  });

  await assert.rejects(
    getContentEncryptionReadiness(dbStatus(), VALID_ENV, runtime),
    /MANAGED_KEY_RUNTIME_MISMATCH/,
  );
  assert.equal(runtime.calls.length, 0);
});

for (const errorCode of ["TEMPORARY", "THROTTLED"]) {
  test(`${errorCode} KMS 장애는 degraded다`, async () => {
    const status = await getContentEncryptionReadiness(
      dbStatus({ managed_records: "2" }),
      VALID_ENV,
      runtimeHealth({
        status: "unhealthy",
        latencyMs: 20,
        checkedAt: new Date("2026-07-17T01:02:03.000Z"),
        errorCode,
      }),
    );
    assert.equal(status.status, "degraded");
    assert.equal(status.errorCode, errorCode);
  });
}

for (const errorCode of [
  "AUTH_FAILED",
  "KEY_NOT_FOUND",
  "KEY_DISABLED",
  "KEY_INVALID_STATE",
  "WRAPPER_MISMATCH",
  "PROVIDER_CANARY_FAILED",
  "UNKNOWN",
]) {
  test(`${errorCode} health는 fail-closed not-ready다`, async () => {
    await assert.rejects(
      getContentEncryptionReadiness(
        dbStatus({ managed_records: 1 }),
        VALID_ENV,
        runtimeHealth({
          status: "unhealthy",
          latencyMs: 20,
          checkedAt: new Date("2026-07-17T01:02:03.000Z"),
          errorCode,
        }),
      ),
      /MANAGED_KEY_NOT_READY/,
    );
  });
}

test("malformed health result는 fail-closed다", async () => {
  for (const health of [
    null,
    {},
    { status: "healthy", latencyMs: -1, checkedAt: new Date() },
    { status: "healthy", latencyMs: 1, checkedAt: new Date(Number.NaN) },
    {
      status: "healthy",
      latencyMs: 1,
      checkedAt: new Date(),
      errorCode: "TEMPORARY",
    },
    {
      status: "unhealthy",
      latencyMs: 1,
      checkedAt: new Date(),
      errorCode: "",
    },
  ]) {
    await assert.rejects(
      getContentEncryptionReadiness(
        dbStatus(),
        VALID_ENV,
        runtimeHealth(health as Record<string, unknown>),
      ),
      /MANAGED_KEY_HEALTH_INVALID/,
    );
  }
});

test("singleton row 누락과 malformed managed count는 fail-closed다", async () => {
  for (const row of [
    null,
    {},
    { managed_records: "-1" },
    { managed_records: "1.5" },
    { managed_records: "9007199254740992" },
    { managed_records: Number.NaN },
  ]) {
    await assert.rejects(
      getContentEncryptionReadiness(dbStatus(row), {}, null),
      /MANAGED_KEY_STATUS_INVALID/,
    );
  }
});
