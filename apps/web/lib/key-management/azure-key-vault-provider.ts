import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  WorkloadIdentityCredential,
  type TokenCredential,
} from "@azure/identity";
import {
  CryptographyClient,
} from "@azure/keyvault-keys";
import {
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  decodeUserKeyPayload,
  encodeUserKeyPayload,
} from "./context";
import type {
  CredentialSourceSummary,
  KeyContext,
  KeyManagementProvider,
  KeyProviderHealth,
  WrappedUserKey,
} from "./types";
import {
  inspectProviderError,
  providerError as createProviderError,
} from "./provider-error";
import { azureKeyVaultProviderFingerprint } from "./provider-fingerprint";

export type AzureCredentialMode =
  | "managed-identity"
  | "workload-identity"
  | "default";

type ProviderErrorCode =
  | "AUTH_FAILED"
  | "EMPTY_CIPHERTEXT"
  | "EMPTY_PLAINTEXT"
  | "FAILED"
  | "INVALID_CIPHERTEXT"
  | "INVALID_PLAINTEXT"
  | "KEY_DISABLED"
  | "KEY_NOT_FOUND"
  | "TEMPORARY"
  | "THROTTLED"
  | "WRAPPER_MISMATCH";

const PROVIDER_ERROR_CODES: ReadonlySet<string> = new Set([
  "AUTH_FAILED",
  "EMPTY_CIPHERTEXT",
  "EMPTY_PLAINTEXT",
  "FAILED",
  "INVALID_CIPHERTEXT",
  "INVALID_PLAINTEXT",
  "KEY_DISABLED",
  "KEY_NOT_FOUND",
  "TEMPORARY",
  "THROTTLED",
  "WRAPPER_MISMATCH",
]);

type AzureCryptoResult = {
  result?: unknown;
};

export interface AzureCryptographyClient {
  wrapKey(
    algorithm: "RSA-OAEP-256",
    key: Uint8Array,
  ): Promise<AzureCryptoResult>;
  unwrapKey(
    algorithm: "RSA-OAEP-256",
    encryptedKey: Uint8Array,
  ): Promise<AzureCryptoResult>;
}

export type AzureKeyVaultProviderInput = {
  keyId: string;
  credentialMode?: AzureCredentialMode;
  env?: NodeJS.ProcessEnv;
  nodeEnv?: string;
  cryptoClient?: AzureCryptographyClient;
};

const HEALTH_CONTEXT: KeyContext = Object.freeze({
  installationId: "toard-provider-health",
  userId: "toard-provider-health",
  keyVersion: 0,
  purpose: "prompt-history",
});

function configured(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  return value;
}

function validateCredentialModePolicy(
  mode: AzureCredentialMode,
  nodeEnv: string,
): void {
  if (mode === "default" && nodeEnv === "production") {
    throw new Error("AZURE_DEFAULT_CREDENTIAL_FORBIDDEN");
  }
}

function validateVersionedKeyId(keyId: string): void {
  let keyUrl: URL;
  try {
    keyUrl = new URL(keyId);
  } catch {
    throw new Error("AZURE_KEY_ID_VERSION_REQUIRED");
  }
  if (
    keyId !== keyId.trim()
    || keyUrl.protocol !== "https:"
    || keyUrl.username
    || keyUrl.password
    || keyUrl.search
    || keyUrl.hash
    || !/^\/keys\/[^/]+\/[^/]+$/.test(keyUrl.pathname)
  ) {
    throw new Error("AZURE_KEY_ID_VERSION_REQUIRED");
  }
}

export function createAzureCredential(
  mode: AzureCredentialMode,
  env: NodeJS.ProcessEnv,
  nodeEnv: string,
): TokenCredential {
  validateCredentialModePolicy(mode, nodeEnv);
  if (mode === "managed-identity") {
    const clientId = configured(env.AZURE_CLIENT_ID);
    return clientId
      ? new ManagedIdentityCredential(clientId)
      : new ManagedIdentityCredential();
  }
  if (mode === "workload-identity") {
    const tenantId = configured(env.AZURE_TENANT_ID);
    const clientId = configured(env.AZURE_CLIENT_ID);
    const tokenFilePath = configured(env.AZURE_FEDERATED_TOKEN_FILE);
    if (!tenantId || !clientId || !tokenFilePath) {
      throw new Error("AZURE_WORKLOAD_IDENTITY_INCOMPLETE");
    }
    return new WorkloadIdentityCredential({
      tenantId,
      clientId,
      tokenFilePath,
    });
  }
  return new DefaultAzureCredential();
}

function providerError(code: ProviderErrorCode): Error {
  return createProviderError("azure-key-vault", code);
}

function statusCode(error: unknown): number | undefined {
  if (
    typeof error === "object"
    && error !== null
    && "statusCode" in error
    && typeof error.statusCode === "number"
  ) {
    return error.statusCode;
  }
  return undefined;
}

function errorCode(error: unknown): string {
  if (
    typeof error === "object"
    && error !== null
    && "code" in error
    && typeof error.code === "string"
  ) {
    return error.code;
  }
  return "";
}

function classifyAzureError(error: unknown): ProviderErrorCode {
  const status = statusCode(error);
  const code = errorCode(error);
  if (status === 429 || /Throttl|TooManyRequests/i.test(code)) {
    return "THROTTLED";
  }
  if (
    status === 401
    || status === 403
    || /(?:Unauthorized|Forbidden|Authentication|Credential)/i.test(code)
  ) {
    return "AUTH_FAILED";
  }
  if (status === 404 || /(?:KeyNotFound|NotFound)/i.test(code)) {
    return "KEY_NOT_FOUND";
  }
  if (
    status === 409
    || /(?:KeyDisabled|KeyNotActive|Conflict)/i.test(code)
  ) {
    return "KEY_DISABLED";
  }
  if (
    (status !== undefined && status >= 500)
    || /(?:ServiceUnavailable|InternalServerError|Timeout)/i.test(code)
  ) {
    return "TEMPORARY";
  }
  return "FAILED";
}

function safeErrorCode(error: unknown): string {
  return inspectProviderError(
    error,
    "azure-key-vault",
    PROVIDER_ERROR_CODES,
  ) ?? "FAILED";
}

function credentialSourceKind(mode: AzureCredentialMode): string {
  switch (mode) {
    case "managed-identity":
      return "azure-managed-identity";
    case "workload-identity":
      return "azure-workload-identity";
    case "default":
      return "azure-default-credential";
  }
}

export class AzureKeyVaultProvider implements KeyManagementProvider {
  readonly name = "azure-key-vault" as const;
  readonly keyRef: string;
  readonly fingerprint: string;
  private readonly credentialMode: AzureCredentialMode;
  private readonly client: AzureCryptographyClient;

  constructor(input: AzureKeyVaultProviderInput) {
    const nodeEnv = input.nodeEnv
      ?? input.env?.NODE_ENV
      ?? process.env.NODE_ENV
      ?? "development";
    validateVersionedKeyId(input.keyId);
    validateCredentialModePolicy(
      input.credentialMode ?? "default",
      nodeEnv,
    );
    this.keyRef = input.keyId;
    this.fingerprint = azureKeyVaultProviderFingerprint(input.keyId);
    this.credentialMode = input.credentialMode ?? "default";
    if (input.cryptoClient) {
      this.client = input.cryptoClient;
      return;
    }
    const credential = createAzureCredential(
      this.credentialMode,
      input.env ?? process.env,
      nodeEnv,
    );
    this.client = new CryptographyClient(
      input.keyId,
      credential,
    ) as AzureCryptographyClient;
  }

  async wrapKey(uck: Buffer, context: KeyContext): Promise<WrappedUserKey> {
    const payload = encodeUserKeyPayload(uck, context);
    let response: AzureCryptoResult | undefined;
    try {
      response = await this.client.wrapKey("RSA-OAEP-256", payload);
    } catch (error) {
      throw providerError(classifyAzureError(error));
    } finally {
      payload.fill(0);
    }

    if (
      !(response?.result instanceof Uint8Array)
      || response.result.length === 0
    ) {
      throw providerError("EMPTY_CIPHERTEXT");
    }
    return {
      provider: this.name,
      keyRef: this.keyRef,
      fingerprint: this.fingerprint,
      ciphertext: Buffer.from(response.result),
      metadata: {
        algorithm: "RSA-OAEP-256",
        format: "azure-key-vault-v1",
      },
    };
  }

  async unwrapKey(
    wrapped: WrappedUserKey,
    context: KeyContext,
  ): Promise<Buffer> {
    if (
      wrapped.provider !== this.name
      || wrapped.keyRef !== this.keyRef
      || wrapped.fingerprint !== this.fingerprint
    ) {
      throw providerError("WRAPPER_MISMATCH");
    }
    if (
      !(wrapped.ciphertext instanceof Uint8Array)
      || wrapped.ciphertext.length === 0
    ) {
      throw providerError("INVALID_CIPHERTEXT");
    }

    let response: AzureCryptoResult | undefined;
    try {
      response = await this.client.unwrapKey(
        "RSA-OAEP-256",
        wrapped.ciphertext,
      );
    } catch (error) {
      throw providerError(classifyAzureError(error));
    }

    if (
      !(response?.result instanceof Uint8Array)
      || response.result.length === 0
    ) {
      if (
        response?.result === undefined
        || (
          response.result instanceof Uint8Array
          && response.result.length === 0
        )
      ) {
        throw providerError("EMPTY_PLAINTEXT");
      }
      throw providerError("INVALID_PLAINTEXT");
    }
    const providerPayload = response.result;
    const payload = Buffer.from(providerPayload);
    try {
      return decodeUserKeyPayload(payload, context);
    } catch {
      throw providerError("INVALID_PLAINTEXT");
    } finally {
      payload.fill(0);
      providerPayload.fill(0);
    }
  }

  async healthCheck(): Promise<KeyProviderHealth> {
    const startedAt = Date.now();
    const userKey = randomBytes(32);
    let unwrapped: Buffer | null = null;
    try {
      const wrapped = await this.wrapKey(userKey, HEALTH_CONTEXT);
      unwrapped = await this.unwrapKey(wrapped, HEALTH_CONTEXT);
      if (
        unwrapped.length !== userKey.length
        || !timingSafeEqual(unwrapped, userKey)
      ) {
        throw providerError("INVALID_PLAINTEXT");
      }
      return {
        status: "healthy",
        latencyMs: Date.now() - startedAt,
        checkedAt: new Date(),
      };
    } catch (error) {
      return {
        status: "unhealthy",
        latencyMs: Date.now() - startedAt,
        checkedAt: new Date(),
        errorCode: safeErrorCode(error),
      };
    } finally {
      userKey.fill(0);
      unwrapped?.fill(0);
    }
  }

  async describeCredentialSource(): Promise<CredentialSourceSummary> {
    return {
      kind: credentialSourceKind(this.credentialMode),
      staticCredential: false,
    };
  }
}
