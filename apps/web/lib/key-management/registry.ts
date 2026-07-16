import type {
  KeyManagementProvider,
  WrappedUserKey,
} from "./types";

export class KeyProviderRegistry {
  readonly active: KeyManagementProvider;
  readonly migration: KeyManagementProvider | null;
  private readonly providersByFingerprint: ReadonlyMap<
    string,
    readonly KeyManagementProvider[]
  >;

  constructor(active: KeyManagementProvider, migration: KeyManagementProvider | null) {
    this.active = active;
    this.migration = migration;
    const providersByFingerprint = new Map<string, KeyManagementProvider[]>();
    for (const provider of [active, migration]) {
      if (!provider) continue;
      const providers = providersByFingerprint.get(provider.fingerprint) ?? [];
      providers.push(provider);
      providersByFingerprint.set(provider.fingerprint, providers);
    }
    this.providersByFingerprint = providersByFingerprint;
  }

  resolveWrappedKey(wrapped: WrappedUserKey): KeyManagementProvider {
    const provider = this.providersByFingerprint
      .get(wrapped.fingerprint)
      ?.find((candidate) => (
        candidate.name === wrapped.provider
        && candidate.keyRef === wrapped.keyRef
        && candidate.fingerprint === wrapped.fingerprint
      ));
    if (!provider) {
      throw new Error("KEY_PROVIDER_NOT_REGISTERED");
    }
    return provider;
  }
}
