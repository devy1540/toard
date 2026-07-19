import { readFileSync } from "node:fs";
import { AwsKmsProvider, type AwsKmsClient } from "./aws-kms-provider";
import {
  AzureKeyVaultProvider,
  type AzureCryptographyClient,
  type AzureCredentialMode,
} from "./azure-key-vault-provider";
import type {
  KeyManagementConfig,
  ProviderProfile,
} from "./config";
import {
  GcpKmsProvider,
  type GcpKmsClient,
} from "./gcp-kms-provider";
import { LocalKeyManagementProvider } from "./local-provider";
import {
  ObservedKeyManagementProvider,
  type KeyOperationRecorder,
} from "./observability";
import { OpenBaoTransitProvider } from "./openbao-transit-provider";
import { KeyProviderRegistry } from "./registry";
import { TransitClient } from "./transit-client";
import {
  AppRoleTokenSource,
  FileTokenSource,
  KubernetesTokenSource,
  type TransitTokenSource,
} from "./transit-token-source";
import type { KeyManagementProvider } from "./types";
import { VaultTransitProvider } from "./vault-transit-provider";

type SecretFileReader = (path: string) => Buffer;

export type KeyProviderFactoryDependencies = {
  readFile?: SecretFileReader;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  awsClient?: AwsKmsClient;
  gcpClient?: GcpKmsClient;
  azureCryptoClient?: AzureCryptographyClient;
  azureEnv?: NodeJS.ProcessEnv;
  nodeEnv?: string;
  operationRecorder?: KeyOperationRecorder;
};

function required(
  settings: Readonly<Record<string, string>>,
  name: string,
): string {
  const value = settings[name];
  if (!value) throw new Error("KEY_PROVIDER_PROFILE_INVALID");
  return value;
}

function createLocalProvider(
  profile: ProviderProfile,
  dependencies: KeyProviderFactoryDependencies,
): KeyManagementProvider {
  const readFile = dependencies.readFile ?? readFileSync;
  const temporaryBuffers: Buffer[] = [];
  try {
    return new LocalKeyManagementProvider({
      keyFile: required(profile.settings, "LOCAL_KEK_FILE"),
      readFile: (path) => {
        const temporary = readFile(path);
        if (!Buffer.isBuffer(temporary)) {
          throw new Error("KEY_PROVIDER_FILE_INVALID");
        }
        temporaryBuffers.push(temporary);
        return temporary;
      },
    });
  } finally {
    for (const temporary of temporaryBuffers) temporary.fill(0);
  }
}

function createTransitTokenSource(
  profile: ProviderProfile,
  dependencies: KeyProviderFactoryDependencies,
): TransitTokenSource {
  const settings = profile.settings;
  const readFile = dependencies.readFile ?? readFileSync;
  const common = {
    address: required(settings, "TRANSIT_ADDRESS"),
    mount: required(settings, "TRANSIT_MOUNT"),
    namespace: settings.TRANSIT_NAMESPACE,
    fetch: dependencies.fetch,
    readFile,
    now: dependencies.now,
  };
  switch (required(settings, "TRANSIT_AUTH_METHOD")) {
    case "token-file":
    case "static-token":
      return new FileTokenSource(
        required(settings, "TRANSIT_TOKEN_FILE"),
        readFile,
      );
    case "kubernetes":
      return new KubernetesTokenSource({
        ...common,
        role: required(settings, "TRANSIT_KUBERNETES_ROLE"),
        jwtFile: required(settings, "TRANSIT_KUBERNETES_JWT_FILE"),
      });
    case "approle":
      return new AppRoleTokenSource({
        ...common,
        roleIdFile: required(settings, "TRANSIT_APPROLE_ROLE_ID_FILE"),
        secretIdFile: required(settings, "TRANSIT_APPROLE_SECRET_ID_FILE"),
      });
    default:
      throw new Error("KEY_PROVIDER_PROFILE_INVALID");
  }
}

function createTransitProvider(
  profile: ProviderProfile,
  dependencies: KeyProviderFactoryDependencies,
): KeyManagementProvider {
  const settings = profile.settings;
  const client = new TransitClient({
    address: required(settings, "TRANSIT_ADDRESS"),
    mount: required(settings, "TRANSIT_MOUNT"),
    keyName: required(settings, "TRANSIT_KEY_NAME"),
    namespace: settings.TRANSIT_NAMESPACE,
    tokenSource: createTransitTokenSource(profile, dependencies),
    fetch: dependencies.fetch,
  });
  return profile.provider === "vault-transit"
    ? new VaultTransitProvider({ client })
    : new OpenBaoTransitProvider({ client });
}

function createValidatedKeyProvider(
  profile: ProviderProfile,
  dependencies: KeyProviderFactoryDependencies,
): KeyManagementProvider {
  const settings = profile.settings;
  switch (profile.provider) {
    case "local":
      return createLocalProvider(profile, dependencies);
    case "aws-kms":
      return new AwsKmsProvider({
        keyArn: required(settings, "AWS_KEY_ARN"),
        region: required(settings, "AWS_REGION"),
        endpoint: settings.AWS_ENDPOINT,
        client: dependencies.awsClient,
      });
    case "gcp-kms":
      return new GcpKmsProvider({
        keyName: required(settings, "GCP_KEY_NAME"),
        apiEndpoint: settings.GCP_API_ENDPOINT,
        client: dependencies.gcpClient,
      });
    case "azure-key-vault": {
      const credentialMode = required(
        settings,
        "AZURE_CREDENTIAL_MODE",
      ) as AzureCredentialMode;
      const ambientAzureEnv = dependencies.azureEnv ?? process.env;
      const azureEnv = {
        AZURE_CLIENT_ID:
          (credentialMode === "managed-identity"
            ? settings.AZURE_MANAGED_IDENTITY_CLIENT_ID
            : undefined)
          ?? ambientAzureEnv.AZURE_CLIENT_ID,
        AZURE_TENANT_ID: ambientAzureEnv.AZURE_TENANT_ID,
        AZURE_FEDERATED_TOKEN_FILE:
          ambientAzureEnv.AZURE_FEDERATED_TOKEN_FILE,
        NODE_ENV: ambientAzureEnv.NODE_ENV,
      };
      return new AzureKeyVaultProvider({
        keyId: required(settings, "AZURE_KEY_ID"),
        credentialMode,
        env: azureEnv,
        nodeEnv: dependencies.nodeEnv ?? azureEnv.NODE_ENV,
        cryptoClient: dependencies.azureCryptoClient,
      });
    }
    case "vault-transit":
    case "openbao-transit":
      return createTransitProvider(profile, dependencies);
    default:
      throw new Error("KEY_PROVIDER_PROFILE_INVALID");
  }
}

export function createKeyProvider(
  profile: ProviderProfile,
  dependencies: KeyProviderFactoryDependencies = {},
): KeyManagementProvider {
  try {
    return new ObservedKeyManagementProvider(
      createValidatedKeyProvider(profile, dependencies),
      {
        recorder: dependencies.operationRecorder,
        now: dependencies.now,
      },
    );
  } catch {
    throw new Error("KEY_PROVIDER_CONSTRUCTION_FAILED");
  }
}

export function createKeyProviderRegistry(
  config: KeyManagementConfig,
  dependencies: KeyProviderFactoryDependencies = {},
): KeyProviderRegistry {
  const active = createKeyProvider(config.active, dependencies);
  const migration = config.migration
    ? createKeyProvider(config.migration, dependencies)
    : null;
  if (migration && migration.fingerprint === active.fingerprint) {
    throw new Error("KEY_PROVIDER_DUPLICATE_FINGERPRINT");
  }
  return new KeyProviderRegistry(active, migration);
}
