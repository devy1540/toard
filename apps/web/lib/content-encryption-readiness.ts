import { readFile } from "node:fs/promises";
import { loadKeyManagementConfig, type ProviderProfile } from "./key-management/config";
import {
  canonicalTransitKeyName,
  canonicalTransitMount,
} from "./key-management/transit-validation";
import type {
  KeyManagementProvider,
  KeyProviderName,
} from "./key-management/types";
import type { ManagedContentRuntime } from "./managed-content-runtime";
import {
  awsKmsProviderFingerprint,
  azureKeyVaultProviderFingerprint,
  gcpKmsProviderFingerprint,
  localProviderFingerprint,
  transitProviderFingerprint,
} from "./key-management/provider-fingerprint";
import {
  parseManagedKeyDistribution,
  type ManagedKeyDistributionEntry,
} from "./managed-key-distribution";

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
const DATE_GET_TIME = Date.prototype.getTime;
const DATE_TO_ISO_STRING = Date.prototype.toISOString;

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

function parseSnapshotCount(value: unknown): number {
  try {
    return parseManagedRecords(value);
  } catch {
    return fail("MANAGED_KEY_DISTRIBUTION_INVALID");
  }
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

async function expectedFingerprint(profile: ProviderProfile): Promise<string> {
  switch (profile.provider) {
    case "local": {
      let raw: Buffer | null = null;
      let copy: Buffer | null = null;
      try {
        raw = await readFile(profile.settings.LOCAL_KEK_FILE!);
        copy = Buffer.from(raw);
        if (copy.length !== 32) throw new Error("LOCAL_KEY_FILE_INVALID");
        return localProviderFingerprint(copy);
      } finally {
        raw?.fill(0);
        copy?.fill(0);
      }
    }
    case "aws-kms":
      return awsKmsProviderFingerprint(
        profile.settings.AWS_KEY_ARN!,
        profile.settings.AWS_REGION!,
        profile.settings.AWS_ENDPOINT,
      );
    case "gcp-kms":
      return gcpKmsProviderFingerprint(
        profile.settings.GCP_KEY_NAME!,
        profile.settings.GCP_API_ENDPOINT,
      );
    case "azure-key-vault":
      return azureKeyVaultProviderFingerprint(
        profile.settings.AZURE_KEY_ID!,
      );
    case "vault-transit":
    case "openbao-transit":
      return transitProviderFingerprint(
        profile.provider,
        profile.settings.TRANSIT_ADDRESS!,
        profile.settings.TRANSIT_MOUNT!,
        profile.settings.TRANSIT_KEY_NAME!,
        profile.settings.TRANSIT_NAMESPACE,
      );
  }
}

type ProviderIdentitySnapshot = {
  provider: KeyProviderName;
  keyRef: string;
  fingerprint: string;
};

type WriteFenceIdentity = {
  provider: KeyProviderName;
  providerFingerprint: string;
};

const KEY_PROVIDER_NAMES = new Set<KeyProviderName>([
  "local",
  "aws-kms",
  "gcp-kms",
  "azure-key-vault",
  "vault-transit",
  "openbao-transit",
]);

function parseWriteFenceIdentity(
  row: Record<string, unknown>,
): WriteFenceIdentity | null {
  let providerValue: unknown;
  let fingerprintValue: unknown;
  try {
    providerValue = Reflect.get(row, "write_fence_provider");
    fingerprintValue = Reflect.get(row, "write_fence_provider_fingerprint");
  } catch {
    return fail("MANAGED_KEY_WRITE_FENCE_INVALID");
  }
  if (providerValue === null && fingerprintValue === null) return null;
  if (
    typeof providerValue !== "string"
    || !KEY_PROVIDER_NAMES.has(providerValue as KeyProviderName)
    || typeof fingerprintValue !== "string"
    || !/^(?:local|aws-kms|gcp-kms|azure-key-vault|vault-transit|openbao-transit):[0-9a-f]{24}$/.test(
      fingerprintValue,
    )
    || !fingerprintValue.startsWith(`${providerValue}:`)
  ) {
    return fail("MANAGED_KEY_WRITE_FENCE_INVALID");
  }
  return {
    provider: providerValue as KeyProviderName,
    providerFingerprint: fingerprintValue,
  };
}

function snapshotProviderIdentity(
  provider: KeyManagementProvider,
): Record<keyof ProviderIdentitySnapshot, unknown> {
  try {
    return {
      provider: provider.name,
      keyRef: provider.keyRef,
      fingerprint: provider.fingerprint,
    };
  } catch {
    return fail("MANAGED_KEY_RUNTIME_MISMATCH");
  }
}

async function validatedRuntimeIdentity(
  profile: ProviderProfile,
  snapshot: Record<keyof ProviderIdentitySnapshot, unknown>,
): Promise<ProviderIdentitySnapshot> {
  let configuredKeyRef: string;
  let configuredFingerprint: string;
  try {
    configuredKeyRef = expectedKeyRef(profile);
    configuredFingerprint = await expectedFingerprint(profile);
  } catch {
    return fail("MANAGED_KEY_RUNTIME_MISMATCH");
  }
  const fingerprintPrefix = `${profile.provider}:`;
  if (
    snapshot.provider !== profile.provider
    || snapshot.keyRef !== configuredKeyRef
    || snapshot.fingerprint !== configuredFingerprint
    || typeof snapshot.keyRef !== "string"
    || typeof snapshot.fingerprint !== "string"
    || !snapshot.fingerprint.startsWith(fingerprintPrefix)
    || !/^[0-9a-f]{24}$/.test(
      snapshot.fingerprint.slice(fingerprintPrefix.length),
    )
  ) {
    return fail("MANAGED_KEY_RUNTIME_MISMATCH");
  }
  return {
    provider: profile.provider,
    keyRef: snapshot.keyRef,
    fingerprint: snapshot.fingerprint,
  };
}

function safeDateIso(value: unknown): string | null {
  try {
    if (
      typeof value !== "object"
      || value === null
      || Object.getPrototypeOf(value) !== Date.prototype
      || Object.getOwnPropertyDescriptor(value, "getTime") !== undefined
      || Object.getOwnPropertyDescriptor(value, "toISOString") !== undefined
    ) {
      return null;
    }
    const epoch = DATE_GET_TIME.call(value);
    if (!Number.isFinite(epoch)) return null;
    return DATE_TO_ISO_STRING.call(new Date(epoch));
  } catch {
    return null;
  }
}

type HealthSnapshot = {
  status: unknown;
  latencyMs: unknown;
  checkedAt: unknown;
  errorCode: unknown;
};

type ValidatedHealth = {
  status: "healthy" | "unhealthy";
  lastCheckAt: string;
  errorCode: string | null;
};

function snapshotHealth(health: unknown): HealthSnapshot {
  if (typeof health !== "object" || health === null) {
    return fail("MANAGED_KEY_HEALTH_INVALID");
  }
  try {
    return {
      status: Reflect.get(health, "status"),
      latencyMs: Reflect.get(health, "latencyMs"),
      checkedAt: Reflect.get(health, "checkedAt"),
      errorCode: Reflect.get(health, "errorCode"),
    };
  } catch {
    return fail("MANAGED_KEY_HEALTH_INVALID");
  }
}

function validatedHealth(health: unknown): ValidatedHealth {
  const snapshot = snapshotHealth(health);
  const iso = safeDateIso(snapshot.checkedAt);
  if (
    (snapshot.status !== "healthy" && snapshot.status !== "unhealthy")
    || typeof snapshot.latencyMs !== "number"
    || !Number.isFinite(snapshot.latencyMs)
    || snapshot.latencyMs < 0
    || iso === null
    || (
      snapshot.status === "healthy"
      && snapshot.errorCode !== undefined
    )
  ) {
    return fail("MANAGED_KEY_HEALTH_INVALID");
  }
  if (snapshot.status === "healthy") {
    return { status: "healthy", lastCheckAt: iso, errorCode: null };
  }
  if (
    typeof snapshot.errorCode !== "string"
    || snapshot.errorCode.length === 0
    || !/^[A-Z][A-Z0-9_]*$/.test(snapshot.errorCode)
  ) {
    return fail("MANAGED_KEY_HEALTH_INVALID");
  }
  return {
    status: "unhealthy",
    lastCheckAt: iso,
    errorCode: snapshot.errorCode,
  };
}

function validateDistributionSnapshot(
  value: unknown,
  counts: { active: number; pending: number; retiring: number },
  runtime: ManagedContentRuntime,
): void {
  let distribution: ManagedKeyDistributionEntry[];
  try {
    distribution = parseManagedKeyDistribution(value);
  } catch {
    return fail("MANAGED_KEY_DISTRIBUTION_INVALID");
  }
  const totals = { active: 0, pending: 0, retiring: 0 };
  for (const entry of distribution) {
    const next = totals[entry.state] + entry.count;
    if (!Number.isSafeInteger(next) || next < 0) {
      return fail("MANAGED_KEY_DISTRIBUTION_INVALID");
    }
    totals[entry.state] = next;
    if (entry.state !== "retiring" && !runtime.registry.resolveIdentity(
      entry.provider,
      entry.providerFingerprint,
    )) {
      return fail("MANAGED_KEY_DISTRIBUTION_UNRESOLVABLE");
    }
  }
  if (
    totals.active !== counts.active
    || totals.pending !== counts.pending
    || totals.retiring !== counts.retiring
  ) {
    return fail("MANAGED_KEY_DISTRIBUTION_INVALID");
  }
}

export async function getContentEncryptionReadiness(
  db: ContentEncryptionReadinessDb,
  env: ReadinessEnvironment,
  runtime: ManagedContentRuntime | null,
): Promise<ContentEncryptionReadiness> {
  const result = await db.query(
    `SELECT managed_records::text AS managed_records,
            active_user_keys::text AS active_user_keys,
            pending_user_keys::text AS pending_user_keys,
            retiring_user_keys::text AS retiring_user_keys,
            COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'provider',distribution.provider,
                'provider_fingerprint',distribution.provider_fingerprint,
                'state',distribution.state,
                'wrapper_count',distribution.wrapper_count::text
              ) ORDER BY distribution.provider,distribution.provider_fingerprint,distribution.state)
                FROM managed_content_key_distribution distribution
            ),'[]'::jsonb) AS wrapper_distribution,
            write_fence.provider AS write_fence_provider,
            write_fence.provider_fingerprint AS write_fence_provider_fingerprint
       FROM content_encryption_status
       LEFT JOIN LATERAL latest_managed_content_write_fence() write_fence
         ON TRUE
      WHERE singleton=TRUE`,
  );
  if (result.rows.length !== 1) fail("MANAGED_KEY_STATUS_INVALID");
  const statusRow = result.rows[0];
  if (!statusRow) fail("MANAGED_KEY_STATUS_INVALID");
  const managedRecords = parseManagedRecords(statusRow.managed_records);
  const writeFence = parseWriteFenceIdentity(statusRow);

  const activeProvider = env.TOARD_KEY_ACTIVE_PROVIDER?.trim();
  if (!activeProvider) {
    if (hasPartialManagedProfile(env)) fail("MANAGED_KEY_CONFIG_INVALID");
    if (managedRecords > 0 || writeFence) fail("MANAGED_KEY_PROVIDER_MISSING");
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
  let migrationProfile: ProviderProfile | null;
  try {
    const config = loadKeyManagementConfig(env);
    profile = config.active;
    migrationProfile = config.migration;
  } catch {
    return fail("MANAGED_KEY_CONFIG_INVALID");
  }
  if (!runtime) fail("MANAGED_KEY_RUNTIME_MISSING");

  validateDistributionSnapshot(
    statusRow?.wrapper_distribution,
    {
      active: parseSnapshotCount(statusRow?.active_user_keys),
      pending: parseSnapshotCount(statusRow?.pending_user_keys),
      retiring: parseSnapshotCount(statusRow?.retiring_user_keys),
    },
    runtime,
  );

  const provider = runtime.registry.active;
  const providerIdentity = await validatedRuntimeIdentity(
    profile,
    snapshotProviderIdentity(provider),
  );
  let writeFenceProvider: KeyManagementProvider | null = null;
  if (
    writeFence
    && (
      writeFence.provider !== providerIdentity.provider
      || writeFence.providerFingerprint !== providerIdentity.fingerprint
    )
  ) {
    const migration = runtime.registry.migration;
    if (!migration) fail("MANAGED_KEY_WRITE_FENCE_UNRESOLVABLE");
    const migrationSnapshot = snapshotProviderIdentity(migration);
    if (
      migrationSnapshot.provider !== writeFence.provider
      || migrationSnapshot.fingerprint !== writeFence.providerFingerprint
    ) {
      fail("MANAGED_KEY_WRITE_FENCE_UNRESOLVABLE");
    }
    if (!migrationProfile) fail("MANAGED_KEY_WRITE_FENCE_MISMATCH");
    try {
      await validatedRuntimeIdentity(migrationProfile, migrationSnapshot);
    } catch {
      fail("MANAGED_KEY_WRITE_FENCE_MISMATCH");
    }
    writeFenceProvider = migration;
  }
  const health = validatedHealth(await runtime.health.check(provider));
  if (writeFenceProvider) {
    const migrationHealth = validatedHealth(
      await runtime.health.check(writeFenceProvider),
    );
    if (migrationHealth.status !== "healthy") {
      fail("MANAGED_KEY_WRITE_FENCE_NOT_READY");
    }
  }
  const identity = {
    ...providerIdentity,
    managedRecords,
    lastCheckAt: health.lastCheckAt,
  };

  if (health.status === "healthy") {
    return {
      status: "healthy",
      ...identity,
      errorCode: null,
    };
  }
  if (
    health.errorCode !== null
    && TRANSIENT_PROVIDER_CODES.has(health.errorCode)
  ) {
    return {
      status: "degraded",
      ...identity,
      errorCode: health.errorCode,
    };
  }
  return fail("MANAGED_KEY_NOT_READY");
}
