import { getPool } from "./db";
import type { KeyOperation, KeyOperationOutcome } from "./key-management/observability";
import type {
  CredentialSourceSummary,
  KeyManagementProvider,
  KeyProviderHealth,
  KeyProviderName,
} from "./key-management/types";
import {
  getManagedContentRuntime,
  type ManagedContentRuntime,
} from "./managed-content-runtime";

const REFERENCE_PRICING = {
  "aws-kms": { asOf: "2026-07-17", per10kUsd: 0.03, monthlyKeyUsd: 1.00 },
  "gcp-kms": { asOf: "2026-07-17", per10kUsd: 0.03, monthlyKeyUsd: 0.06 },
} as const;

const PROVIDERS = new Set<KeyProviderName>([
  "local",
  "aws-kms",
  "gcp-kms",
  "azure-key-vault",
  "vault-transit",
  "openbao-transit",
]);
const OPERATIONS = new Set<KeyOperation>(["wrap", "unwrap", "health"]);
const OUTCOMES = new Set<KeyOperationOutcome>([
  "success",
  "throttled",
  "unavailable",
  "auth",
  "invalid",
]);
const CACHE_RESULTS = new Set(["none", "hit", "miss", "single_flight"]);
const HEALTH_ERROR_CODES = new Set([
  "AUTH_FAILED",
  "FAILED",
  "KEY_DISABLED",
  "KEY_INVALID_STATE",
  "KEY_NOT_FOUND",
  "PROVIDER_CANARY_FAILED",
  "RESPONSE_INVALID",
  "TEMPORARY",
  "THROTTLED",
]);

export type CostEstimate = {
  currency: "USD";
  requestCost: number;
  monthlyKeyCost: number;
  total: number;
  source: "reference" | "operator-override";
  asOf: string | null;
  /** Free tier, commitments, tax, and network charges are not deducted. */
  grossReference: true;
};

export type EncryptionAdminStatus = {
  enabled: boolean;
  provider: KeyProviderName | null;
  keyRef: string | null;
  fingerprint: string | null;
  credentialSource: CredentialSourceSummary | null;
  health: KeyProviderHealth | null;
  records: { serverV1: number; e2eeV1: number; managedV1: number };
  userKeys: { active: number; pending: number; retiring: number };
  migrations: { e2eePending: number; e2eeBlocked: number };
  operations30d: Array<{
    operation: KeyOperation;
    outcome: KeyOperationOutcome;
    count: number;
    averageLatencyMs: number;
  }>;
  cache30d: { hit: number; miss: number; singleFlight: number };
  costEstimate: CostEstimate | null;
};

export type EncryptionAdminStatusDatabase = {
  query(sql: string, params?: unknown[]): Promise<{
    rows: Array<Record<string, unknown>>;
  }>;
};

type Dependencies = {
  env?: Readonly<Record<string, string | undefined>>;
  db?: EncryptionAdminStatusDatabase;
  runtime?: ManagedContentRuntime | null;
};

type Pricing = {
  per10kUsd: number;
  monthlyKeyUsd: number;
  source: CostEstimate["source"];
  asOf: string | null;
};

function parseUnsignedCount(value: unknown): number {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new Error("ENCRYPTION_ADMIN_STATUS_INVALID");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("ENCRYPTION_ADMIN_STATUS_INVALID");
  return parsed;
}

function parseOverrideNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  if (value.trim() !== value || value === "" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    throw new Error("KEY_COST_OVERRIDE_INVALID");
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error("KEY_COST_OVERRIDE_INVALID");
  return parsed;
}

function pricingFor(
  env: Readonly<Record<string, string | undefined>>,
  provider: KeyProviderName,
): Pricing | null {
  const per10kUsd = parseOverrideNumber(env.TOARD_KEY_COST_PER_10000_USD);
  const monthlyKeyUsd = parseOverrideNumber(env.TOARD_KEY_MONTHLY_KEY_COST_USD);
  if ((per10kUsd === null) !== (monthlyKeyUsd === null)) {
    throw new Error("KEY_COST_OVERRIDE_INVALID");
  }
  if (per10kUsd !== null && monthlyKeyUsd !== null) {
    return { per10kUsd, monthlyKeyUsd, source: "operator-override", asOf: null };
  }
  const reference = REFERENCE_PRICING[provider as keyof typeof REFERENCE_PRICING];
  return reference
    ? {
        per10kUsd: reference.per10kUsd,
        monthlyKeyUsd: reference.monthlyKeyUsd,
        source: "reference",
        asOf: reference.asOf,
      }
    : null;
}

function providerIdentity(provider: KeyManagementProvider): {
  provider: KeyProviderName;
  keyRef: string;
  fingerprint: string;
} {
  const name = provider.name;
  const keyRef = provider.keyRef;
  const fingerprint = provider.fingerprint;
  if (
    !PROVIDERS.has(name)
    || typeof keyRef !== "string"
    || keyRef.length < 1
    || keyRef.length > 2_048
    || /[\u0000-\u001f\u007f]/.test(keyRef)
    || typeof fingerprint !== "string"
    || !new RegExp(`^${name}:[0-9a-f]{24}$`).test(fingerprint)
  ) {
    throw new Error("ENCRYPTION_ADMIN_STATUS_INVALID");
  }
  return { provider: name, keyRef, fingerprint };
}

function credentialSource(value: CredentialSourceSummary): CredentialSourceSummary {
  if (
    typeof value?.kind !== "string"
    || !/^[a-z0-9][a-z0-9._:-]{0,127}$/.test(value.kind)
    || typeof value.staticCredential !== "boolean"
  ) {
    throw new Error("ENCRYPTION_ADMIN_STATUS_INVALID");
  }
  return { kind: value.kind, staticCredential: value.staticCredential };
}

function safeHealthFailure(): KeyProviderHealth {
  return {
    status: "unhealthy",
    latencyMs: 0,
    checkedAt: new Date(0),
    errorCode: "PROVIDER_HEALTH_UNAVAILABLE",
  };
}

function healthStatus(value: KeyProviderHealth): KeyProviderHealth {
  try {
    const checkedAt = value.checkedAt;
    if (
      (value.status !== "healthy" && value.status !== "unhealthy")
      || typeof value.latencyMs !== "number"
      || !Number.isFinite(value.latencyMs)
      || value.latencyMs < 0
      || !(checkedAt instanceof Date)
      || !Number.isFinite(checkedAt.getTime())
    ) return safeHealthFailure();
    if (value.status === "healthy") {
      return {
        status: "healthy",
        latencyMs: value.latencyMs,
        checkedAt: new Date(checkedAt.getTime()),
      };
    }
    if (!HEALTH_ERROR_CODES.has(value.errorCode)) return safeHealthFailure();
    return {
      status: "unhealthy",
      latencyMs: value.latencyMs,
      checkedAt: new Date(checkedAt.getTime()),
      errorCode: value.errorCode,
    };
  } catch {
    return safeHealthFailure();
  }
}

function money(value: number): number {
  return Number(value.toFixed(6));
}

function costEstimate(pricing: Pricing | null, requests: number): CostEstimate | null {
  if (!pricing) return null;
  const requestCost = money((requests / 10_000) * pricing.per10kUsd);
  const monthlyKeyCost = money(pricing.monthlyKeyUsd);
  return {
    currency: "USD",
    requestCost,
    monthlyKeyCost,
    total: money(requestCost + monthlyKeyCost),
    source: pricing.source,
    asOf: pricing.asOf,
    grossReference: true,
  };
}

export async function getEncryptionAdminStatus(
  dependencies: Dependencies = {},
): Promise<EncryptionAdminStatus> {
  const env = dependencies.env ?? process.env;
  const db = dependencies.db ?? getPool();
  let pricing: Pricing | null = null;
  try {
    const runtime = Object.prototype.hasOwnProperty.call(dependencies, "runtime")
      ? dependencies.runtime ?? null
      : await getManagedContentRuntime();
    if (!runtime && env.TOARD_KEY_ACTIVE_PROVIDER?.trim()) {
      throw new Error("MANAGED_CONTENT_RUNTIME_UNAVAILABLE");
    }

    const statusResult = await db.query(
      `SELECT server_records,e2ee_records,managed_records,
              active_user_keys,pending_user_keys,retiring_user_keys,
              e2ee_migration_pending,e2ee_migration_blocked
         FROM content_encryption_status
        WHERE singleton=TRUE`,
    );
    const row = statusResult.rows[0];
    if (!row) throw new Error("ENCRYPTION_ADMIN_STATUS_INVALID");
    const records = {
      serverV1: parseUnsignedCount(row.server_records),
      e2eeV1: parseUnsignedCount(row.e2ee_records),
      managedV1: parseUnsignedCount(row.managed_records),
    };
    const userKeys = {
      active: parseUnsignedCount(row.active_user_keys),
      pending: parseUnsignedCount(row.pending_user_keys),
      retiring: parseUnsignedCount(row.retiring_user_keys),
    };
    const migrations = {
      e2eePending: parseUnsignedCount(row.e2ee_migration_pending),
      e2eeBlocked: parseUnsignedCount(row.e2ee_migration_blocked),
    };

    if (!runtime) {
      return {
        enabled: false,
        provider: null,
        keyRef: null,
        fingerprint: null,
        credentialSource: null,
        health: null,
        records,
        userKeys,
        migrations,
        operations30d: [],
        cache30d: { hit: 0, miss: 0, singleFlight: 0 },
        costEstimate: null,
      };
    }

    const identity = providerIdentity(runtime.registry.active);
    pricing = pricingFor(env, identity.provider);
    const [source, health, operationsResult, cacheResult] = await Promise.all([
      runtime.registry.active.describeCredentialSource().then(credentialSource),
      runtime.health.check(runtime.registry.active).then(healthStatus).catch(safeHealthFailure),
      db.query(
        `SELECT operation,outcome,
                SUM(operation_count)::text AS operation_count,
                SUM(total_latency_ms)::text AS total_latency_ms
           FROM content_key_operation_daily
          WHERE day >= CURRENT_DATE - INTERVAL '29 days'
            AND provider=$1
            AND provider_fingerprint=$2
            AND cache_result='none'
          GROUP BY operation,outcome
          ORDER BY operation,outcome`,
        [identity.provider, identity.fingerprint],
      ),
      db.query(
        `SELECT cache_result,
                SUM(operation_count)::text AS operation_count
           FROM content_key_operation_daily
          WHERE day >= CURRENT_DATE - INTERVAL '29 days'
            AND provider=$1
            AND provider_fingerprint=$2
            AND cache_result<>'none'
          GROUP BY cache_result
          ORDER BY cache_result`,
        [identity.provider, identity.fingerprint],
      ),
    ]);

    const operationAggregates = new Map<string, {
      operation: KeyOperation;
      outcome: KeyOperationOutcome;
      count: number;
      totalLatencyMs: number;
    }>();
    const cache30d = { hit: 0, miss: 0, singleFlight: 0 };
    let actualProviderCalls = 0;
    for (const operationRow of operationsResult.rows) {
      const operation = operationRow.operation;
      const outcome = operationRow.outcome;
      if (
        typeof operation !== "string"
        || !OPERATIONS.has(operation as KeyOperation)
        || typeof outcome !== "string"
        || !OUTCOMES.has(outcome as KeyOperationOutcome)
      ) throw new Error("ENCRYPTION_ADMIN_STATUS_INVALID");
      const count = parseUnsignedCount(operationRow.operation_count);
      const totalLatencyMs = parseUnsignedCount(operationRow.total_latency_ms);
      actualProviderCalls += count;
      if (!Number.isSafeInteger(actualProviderCalls)) {
        throw new Error("ENCRYPTION_ADMIN_STATUS_INVALID");
      }
      const key = `${operation}:${outcome}`;
      const existing = operationAggregates.get(key);
      const nextCount = (existing?.count ?? 0) + count;
      const nextLatency = (existing?.totalLatencyMs ?? 0) + totalLatencyMs;
      if (!Number.isSafeInteger(nextCount) || !Number.isSafeInteger(nextLatency)) {
        throw new Error("ENCRYPTION_ADMIN_STATUS_INVALID");
      }
      operationAggregates.set(key, {
        operation: operation as KeyOperation,
        outcome: outcome as KeyOperationOutcome,
        count: nextCount,
        totalLatencyMs: nextLatency,
      });
    }
    for (const cacheRow of cacheResult.rows) {
      const result = cacheRow.cache_result;
      if (
        typeof result !== "string"
        || result === "none"
        || !CACHE_RESULTS.has(result)
      ) throw new Error("ENCRYPTION_ADMIN_STATUS_INVALID");
      const count = parseUnsignedCount(cacheRow.operation_count);
      if (result === "hit") cache30d.hit += count;
      else if (result === "miss") cache30d.miss += count;
      else cache30d.singleFlight += count;
      if (!Number.isSafeInteger(cache30d.hit + cache30d.miss + cache30d.singleFlight)) {
        throw new Error("ENCRYPTION_ADMIN_STATUS_INVALID");
      }
    }
    const operations30d = Array.from(operationAggregates.values()).map((aggregate) => ({
      operation: aggregate.operation,
      outcome: aggregate.outcome,
      count: aggregate.count,
      averageLatencyMs: aggregate.count === 0
        ? 0
        : Number((aggregate.totalLatencyMs / aggregate.count).toFixed(3)),
    }));

    return {
      enabled: true,
      provider: identity.provider,
      keyRef: identity.keyRef,
      fingerprint: identity.fingerprint,
      credentialSource: source,
      health,
      records,
      userKeys,
      migrations,
      operations30d,
      cache30d,
      costEstimate: costEstimate(pricing, actualProviderCalls),
    };
  } catch (error) {
    if (error instanceof Error && error.message === "KEY_COST_OVERRIDE_INVALID") throw error;
    throw new Error("ENCRYPTION_ADMIN_STATUS_UNAVAILABLE");
  }
}
