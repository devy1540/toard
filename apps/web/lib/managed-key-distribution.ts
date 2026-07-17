import type { KeyProviderName } from "./key-management/types";

const PROVIDERS = new Set<KeyProviderName>([
  "local", "aws-kms", "gcp-kms", "azure-key-vault", "vault-transit", "openbao-transit",
]);
const STATES = new Set<ManagedKeyState>(["active", "pending", "retiring"]);

export type ManagedKeyState = "active" | "pending" | "retiring";

export type ManagedKeyDistributionEntry = {
  provider: KeyProviderName;
  providerFingerprint: string;
  state: ManagedKeyState;
  count: number;
};

export type ProviderDistributionIdentity = {
  provider: KeyProviderName;
  providerFingerprint: string;
};

export type ProviderRemovalReadiness = {
  old: ProviderDistributionIdentity | null;
  target: ProviderDistributionIdentity | null;
  totalActiveWrappers: number;
  oldActiveWrappers: number;
  targetActiveWrappers: number;
  pendingWrappers: number;
  unexpectedActiveWrappers: number;
  removalReady: boolean;
};

function invalid(): never {
  throw new Error("MANAGED_KEY_DISTRIBUTION_INVALID");
}

function safeAdd(left: number, right: number): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum) || sum < 0) invalid();
  return sum;
}

function snapshotArray(value: unknown): unknown[] {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) invalid();
    const keys = Reflect.ownKeys(value);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (!lengthDescriptor || !("value" in lengthDescriptor)) invalid();
    const length = lengthDescriptor.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > 10_000) invalid();
    if (keys.length !== length + 1 || !keys.includes("length")) invalid();
    const result: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor)) invalid();
      result.push(descriptor.value);
    }
    return result;
  } catch {
    return invalid();
  }
}

function snapshotRow(value: unknown): Record<string, unknown> {
  const expected = ["provider", "provider_fingerprint", "state", "wrapper_count"];
  try {
    if (typeof value !== "object" || value === null) invalid();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalid();
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== expected.length
      || keys.some((key) => typeof key !== "string" || !expected.includes(key))
    ) invalid();
    const snapshot: Record<string, unknown> = {};
    for (const key of expected) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) invalid();
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch {
    return invalid();
  }
}

export function parseManagedKeyDistribution(value: unknown): ManagedKeyDistributionEntry[] {
  const rows = snapshotArray(value);
  const identities = new Set<string>();
  let total = 0;
  return rows.map((value) => {
    const row = snapshotRow(value);
    const provider = row.provider;
    const providerFingerprint = row.provider_fingerprint;
    const state = row.state;
    const rawCount = row.wrapper_count;
    if (
      typeof provider !== "string"
      || !PROVIDERS.has(provider as KeyProviderName)
      || typeof providerFingerprint !== "string"
      || !new RegExp(`^${provider}:[0-9a-f]{24}$`).test(providerFingerprint)
      || typeof state !== "string"
      || !STATES.has(state as ManagedKeyState)
      || typeof rawCount !== "string"
      || !/^[1-9]\d*$/.test(rawCount)
    ) invalid();
    const count = Number(rawCount);
    if (!Number.isSafeInteger(count) || count < 1) invalid();
    total = safeAdd(total, count);
    const identity = `${provider}\u0000${providerFingerprint}\u0000${state}`;
    if (identities.has(identity)) invalid();
    identities.add(identity);
    return {
      provider: provider as KeyProviderName,
      providerFingerprint,
      state: state as ManagedKeyState,
      count,
    };
  });
}

function sameIdentity(
  entry: ManagedKeyDistributionEntry,
  identity: ProviderDistributionIdentity | null,
): boolean {
  return identity !== null
    && entry.provider === identity.provider
    && entry.providerFingerprint === identity.providerFingerprint;
}

export function evaluateProviderRemovalReadiness(
  distribution: readonly ManagedKeyDistributionEntry[],
  old: ProviderDistributionIdentity | null,
  target: ProviderDistributionIdentity | null,
): ProviderRemovalReadiness {
  let totalActiveWrappers = 0;
  let oldActiveWrappers = 0;
  let targetActiveWrappers = 0;
  let pendingWrappers = 0;
  let unexpectedActiveWrappers = 0;
  for (const entry of distribution) {
    if (entry.state === "pending") pendingWrappers = safeAdd(pendingWrappers, entry.count);
    if (entry.state !== "active") continue;
    totalActiveWrappers = safeAdd(totalActiveWrappers, entry.count);
    if (sameIdentity(entry, old)) oldActiveWrappers = safeAdd(oldActiveWrappers, entry.count);
    else if (sameIdentity(entry, target)) targetActiveWrappers = safeAdd(targetActiveWrappers, entry.count);
    else unexpectedActiveWrappers = safeAdd(unexpectedActiveWrappers, entry.count);
  }
  return {
    old,
    target,
    totalActiveWrappers,
    oldActiveWrappers,
    targetActiveWrappers,
    pendingWrappers,
    unexpectedActiveWrappers,
    removalReady: old !== null
      && target !== null
      && old.providerFingerprint !== target.providerFingerprint
      && oldActiveWrappers === 0
      && targetActiveWrappers === totalActiveWrappers
      && pendingWrappers === 0
      && unexpectedActiveWrappers === 0,
  };
}
