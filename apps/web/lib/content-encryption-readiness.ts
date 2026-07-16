import { readFile } from "node:fs/promises";
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
import {
  awsKmsProviderFingerprint,
  azureKeyVaultProviderFingerprint,
  gcpKmsProviderFingerprint,
  localProviderFingerprint,
  transitProviderFingerprint,
} from "./key-management/provider-fingerprint";

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

async function assertRuntimeMatches(
  profile: ProviderProfile,
  provider: KeyManagementProvider,
): Promise<void> {
  let configuredKeyRef: string;
  let configuredFingerprint: string;
  try {
    configuredKeyRef = expectedKeyRef(profile);
    configuredFingerprint = await expectedFingerprint(profile);
  } catch {
    return fail("MANAGED_KEY_RUNTIME_MISMATCH");
  }
  const fingerprintPrefix = `${provider.name}:`;
  if (
    provider.name !== profile.provider
    || provider.keyRef !== configuredKeyRef
    || provider.fingerprint !== configuredFingerprint
    || typeof provider.fingerprint !== "string"
    || !provider.fingerprint.startsWith(fingerprintPrefix)
    || !/^[0-9a-f]{24}$/.test(
      provider.fingerprint.slice(fingerprintPrefix.length),
    )
  ) {
    fail("MANAGED_KEY_RUNTIME_MISMATCH");
  }
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

function checkedAtIso(health: KeyProviderHealth): string {
  let iso: string | null;
  try {
    iso = safeDateIso(health.checkedAt);
  } catch {
    iso = null;
  }
  if (
    typeof health !== "object"
    || health === null
    || (health.status !== "healthy" && health.status !== "unhealthy")
    || typeof health.latencyMs !== "number"
    || !Number.isFinite(health.latencyMs)
    || health.latencyMs < 0
    || iso === null
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
  return iso;
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
  await assertRuntimeMatches(profile, provider);
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
