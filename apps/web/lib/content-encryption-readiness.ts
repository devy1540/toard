import { loadKeyManagementConfig, type ProviderProfile } from "./key-management/config";
import {
  canonicalTransitKeyName,
  canonicalTransitMount,
} from "./key-management/transit-validation";
import type {
  KeyManagementProvider,
  KeyProviderHealth,
  KeyProviderName,
} from "./key-management/types";
import type { ManagedContentRuntime } from "./managed-content-runtime";

export type ContentEncryptionReadiness = {
  status: "disabled" | "healthy" | "degraded";
  provider: KeyProviderName | null;
  keyRef: string | null;
  fingerprint: string | null;
  managedRecords: number;
  lastCheckAt: string | null;
  errorCode: string | null;
};

export type ContentEncryptionReadinessDb = {
  query(sql: string, params?: unknown[]): Promise<{
    rows: Array<Record<string, unknown>>;
  }>;
};

type ReadinessEnvironment = Readonly<Record<string, string | undefined>>;

const TRANSIENT_PROVIDER_CODES = new Set(["TEMPORARY", "THROTTLED"]);

function fail(code: string): never {
  throw new Error(code);
}

function parseManagedRecords(value: unknown): number {
  if (
    typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
  ) {
    return value;
  }
  if (typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return fail("MANAGED_KEY_STATUS_INVALID");
}

function hasPartialManagedProfile(env: ReadinessEnvironment): boolean {
  return Object.entries(env).some(
    ([name, value]) =>
      value?.trim()
      && (
        name.startsWith("TOARD_KEY_ACTIVE_")
        || name.startsWith("TOARD_KEY_MIGRATION_")
      ),
  );
}

function expectedKeyRef(profile: ProviderProfile): string {
  switch (profile.provider) {
    case "local":
      return `file:${profile.settings.LOCAL_KEK_FILE}`;
    case "aws-kms":
      return profile.settings.AWS_KEY_ARN!;
    case "gcp-kms":
      return profile.settings.GCP_KEY_NAME!;
    case "azure-key-vault":
      return profile.settings.AZURE_KEY_ID!;
    case "vault-transit":
    case "openbao-transit": {
      const address = profile.settings.TRANSIT_ADDRESS!;
      const base = address.endsWith("/") ? address : `${address}/`;
      return new URL(
        `v1/${canonicalTransitMount(profile.settings.TRANSIT_MOUNT!)}/keys/${
          canonicalTransitKeyName(profile.settings.TRANSIT_KEY_NAME!)
        }`,
        base,
      ).href;
    }
  }
}

function assertRuntimeMatches(
  profile: ProviderProfile,
  provider: KeyManagementProvider,
): void {
  const fingerprintPrefix = `${provider.name}:`;
  if (
    provider.name !== profile.provider
    || provider.keyRef !== expectedKeyRef(profile)
    || typeof provider.fingerprint !== "string"
    || !provider.fingerprint.startsWith(fingerprintPrefix)
    || !/^[0-9a-f]{24}$/.test(
      provider.fingerprint.slice(fingerprintPrefix.length),
    )
  ) {
    fail("MANAGED_KEY_RUNTIME_MISMATCH");
  }
}

function checkedAtIso(health: KeyProviderHealth): string {
  if (
    typeof health !== "object"
    || health === null
    || (health.status !== "healthy" && health.status !== "unhealthy")
    || typeof health.latencyMs !== "number"
    || !Number.isFinite(health.latencyMs)
    || health.latencyMs < 0
    || !(health.checkedAt instanceof Date)
    || !Number.isFinite(health.checkedAt.getTime())
    || (
      health.status === "healthy"
      && "errorCode" in health
      && health.errorCode !== undefined
    )
  ) {
    return fail("MANAGED_KEY_HEALTH_INVALID");
  }
  if (
    health.status === "unhealthy"
    && (
      typeof health.errorCode !== "string"
      || health.errorCode.length === 0
      || !/^[A-Z][A-Z0-9_]*$/.test(health.errorCode)
    )
  ) {
    return fail("MANAGED_KEY_HEALTH_INVALID");
  }
  return health.checkedAt.toISOString();
}

export async function getContentEncryptionReadiness(
  db: ContentEncryptionReadinessDb,
  env: ReadinessEnvironment,
  runtime: ManagedContentRuntime | null,
): Promise<ContentEncryptionReadiness> {
  const result = await db.query(
    `SELECT managed_records::text AS managed_records
       FROM content_encryption_status
      WHERE singleton=TRUE`,
  );
  if (result.rows.length !== 1) fail("MANAGED_KEY_STATUS_INVALID");
  const managedRecords = parseManagedRecords(result.rows[0]?.managed_records);

  const activeProvider = env.TOARD_KEY_ACTIVE_PROVIDER?.trim();
  if (!activeProvider) {
    if (hasPartialManagedProfile(env)) fail("MANAGED_KEY_CONFIG_INVALID");
    if (managedRecords > 0) fail("MANAGED_KEY_PROVIDER_MISSING");
    if (runtime) fail("MANAGED_KEY_RUNTIME_MISMATCH");
    return {
      status: "disabled",
      provider: null,
      keyRef: null,
      fingerprint: null,
      managedRecords,
      lastCheckAt: null,
      errorCode: null,
    };
  }

  let profile: ProviderProfile;
  try {
    profile = loadKeyManagementConfig(env).active;
  } catch {
    return fail("MANAGED_KEY_CONFIG_INVALID");
  }
  if (!runtime) fail("MANAGED_KEY_RUNTIME_MISSING");

  const provider = runtime.registry.active;
  assertRuntimeMatches(profile, provider);
  const health = await runtime.health.check(provider);
  const lastCheckAt = checkedAtIso(health);
  const identity = {
    provider: provider.name,
    keyRef: provider.keyRef,
    fingerprint: provider.fingerprint,
    managedRecords,
    lastCheckAt,
  };

  if (health.status === "healthy") {
    return {
      status: "healthy",
      ...identity,
      errorCode: null,
    };
  }
  if (TRANSIENT_PROVIDER_CODES.has(health.errorCode)) {
    return {
      status: "degraded",
      ...identity,
      errorCode: health.errorCode,
    };
  }
  return fail("MANAGED_KEY_NOT_READY");
}
