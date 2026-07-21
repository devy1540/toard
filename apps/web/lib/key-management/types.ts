export type KeyProviderName =
  | "local"
  | "aws-kms"
  | "gcp-kms"
  | "azure-key-vault"
  | "vault-transit"
  | "openbao-transit";

export type KeyContext = {
  installationId: string;
  userId: string;
  keyVersion: number;
  purpose: "prompt-history";
};

export type WrappedUserKey = {
  provider: KeyProviderName;
  keyRef: string;
  fingerprint: string;
  ciphertext: Buffer;
  metadata: Record<string, string>;
};

export type KeyProviderHealth =
  | {
      status: "healthy";
      latencyMs: number;
      checkedAt: Date;
    }
  | {
      status: "unhealthy";
      latencyMs: number;
      checkedAt: Date;
      errorCode: string;
    };

export type CredentialSourceSummary = {
  kind: string;
  staticCredential: boolean;
};

export interface KeyManagementProvider {
  readonly name: KeyProviderName;
  readonly keyRef: string;
  readonly fingerprint: string;
  wrapKey(uck: Buffer, context: KeyContext): Promise<WrappedUserKey>;
  unwrapKey(wrapped: WrappedUserKey, context: KeyContext): Promise<Buffer>;
  healthCheck(): Promise<KeyProviderHealth>;
  describeCredentialSource(): Promise<CredentialSourceSummary>;
}
