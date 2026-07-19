import { createHash } from "node:crypto";

type TransitProviderName = "vault-transit" | "openbao-transit";

function configFingerprint(
  provider: string,
  identity: readonly unknown[],
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([provider, ...identity]))
    .digest("hex")
    .slice(0, 24);
  return `${provider}:${digest}`;
}

export function localProviderFingerprint(kek: Uint8Array): string {
  return `local:${createHash("sha256")
    .update(kek)
    .digest("hex")
    .slice(0, 24)}`;
}

export function awsKmsProviderFingerprint(
  keyArn: string,
  region: string,
  endpoint?: string,
): string {
  return configFingerprint("aws-kms", [keyArn, region, endpoint ?? null]);
}

export function gcpKmsProviderFingerprint(
  keyName: string,
  apiEndpoint?: string,
): string {
  return configFingerprint("gcp-kms", [keyName, apiEndpoint ?? null]);
}

export function azureKeyVaultProviderFingerprint(keyId: string): string {
  return configFingerprint("azure-key-vault", [keyId]);
}

export function transitProviderFingerprint(
  provider: TransitProviderName,
  address: string,
  mount: string,
  keyName: string,
  namespace?: string,
): string {
  return configFingerprint(provider, [
    address,
    mount,
    keyName,
    namespace ?? null,
  ]);
}
