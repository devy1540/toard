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
    if (
      migration
      && migration.fingerprint === active.fingerprint
    ) {
      throw new Error("KEY_PROVIDER_DUPLICATE_FINGERPRINT");
    }
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

  /**
   * durable migration fence는 key-ref 없이 provider/fingerprint만 저장한다.
   * 따라서 writer는 이 제한된 identity로만 현재 registry의 provider를 찾는다.
   */
  resolveIdentity(
    providerName: KeyManagementProvider["name"],
    fingerprint: string,
  ): KeyManagementProvider | null {
    return this.providersByFingerprint
      .get(fingerprint)
      ?.find((candidate) => (
        candidate.name === providerName
        && candidate.fingerprint === fingerprint
      )) ?? null;
  }
}
