import { KeyManagementServiceClient } from "@google-cloud/kms";
import {
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  canonicalKeyContext,
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
import { gcpKmsProviderFingerprint } from "./provider-fingerprint";

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

type GcpKmsRequest = {
  name?: string | null;
  plaintext?: Uint8Array | string | null;
  ciphertext?: Uint8Array | string | null;
  additionalAuthenticatedData?: Uint8Array | string | null;
};

type GcpEncryptResponse = {
  ciphertext?: Uint8Array | string | null;
};

type GcpDecryptResponse = {
  plaintext?: Uint8Array | string | null;
};

export interface GcpKmsClient {
  encrypt(
    request: GcpKmsRequest,
  ): Promise<readonly [GcpEncryptResponse, ...unknown[]]>;
  decrypt(
    request: GcpKmsRequest,
  ): Promise<readonly [GcpDecryptResponse, ...unknown[]]>;
}

export type GcpKmsProviderInput = {
  keyName: string;
  apiEndpoint?: string;
  client?: GcpKmsClient;
};

const HEALTH_CONTEXT: KeyContext = Object.freeze({
  installationId: "toard-provider-health",
  userId: "toard-provider-health",
  keyVersion: 0,
  purpose: "prompt-history",
});

function providerError(code: ProviderErrorCode): Error {
  return createProviderError("gcp-kms", code);
}

function errorCode(error: unknown): number | undefined {
  if (
    typeof error === "object"
    && error !== null
    && "code" in error
    && typeof error.code === "number"
  ) {
    return error.code;
  }
  return undefined;
}

function errorName(error: unknown): string {
  if (
    typeof error === "object"
    && error !== null
    && "name" in error
    && typeof error.name === "string"
  ) {
    return error.name;
  }
  return "";
}

function classifyGcpError(error: unknown): ProviderErrorCode {
  const code = errorCode(error);
  const name = errorName(error);
  if (code === 8 || /ResourceExhausted/i.test(name)) return "THROTTLED";
  if (
    code === 7
    || code === 16
    || /(?:PermissionDenied|Unauthenticated)/i.test(name)
  ) {
    return "AUTH_FAILED";
  }
  if (code === 5 || /NotFound/i.test(name)) return "KEY_NOT_FOUND";
  if (
    code === 9
    || /(?:FailedPrecondition|Disabled)/i.test(name)
  ) {
    return "KEY_DISABLED";
  }
  if (
    code === 4
    || code === 10
    || code === 13
    || code === 14
    || /(?:DeadlineExceeded|Aborted|Internal|Unavailable)/i.test(name)
  ) {
    return "TEMPORARY";
  }
  return "FAILED";
}

function safeErrorCode(error: unknown): string {
  return inspectProviderError(error, "gcp-kms", PROVIDER_ERROR_CODES)
    ?? "FAILED";
}

function createDefaultClient(apiEndpoint: string | undefined): GcpKmsClient {
  const client = apiEndpoint
    ? new KeyManagementServiceClient({ apiEndpoint })
    : new KeyManagementServiceClient();
  return client as GcpKmsClient;
}

export class GcpKmsProvider implements KeyManagementProvider {
  readonly name = "gcp-kms" as const;
  readonly keyRef: string;
  readonly fingerprint: string;
  private readonly client: GcpKmsClient;

  constructor(input: GcpKmsProviderInput) {
    this.keyRef = input.keyName;
    this.fingerprint = gcpKmsProviderFingerprint(
      input.keyName,
      input.apiEndpoint,
    );
    this.client = input.client ?? createDefaultClient(input.apiEndpoint);
  }

  async wrapKey(uck: Buffer, context: KeyContext): Promise<WrappedUserKey> {
    const payload = encodeUserKeyPayload(uck, context);
    const additionalAuthenticatedData = canonicalKeyContext(context);
    let response: GcpEncryptResponse | undefined;
    try {
      [response] = await this.client.encrypt({
        name: this.keyRef,
        plaintext: payload,
        additionalAuthenticatedData,
      });
    } catch (error) {
      throw providerError(classifyGcpError(error));
    } finally {
      payload.fill(0);
      additionalAuthenticatedData.fill(0);
    }

    if (
      !(response?.ciphertext instanceof Uint8Array)
      || response.ciphertext.length === 0
    ) {
      throw providerError("EMPTY_CIPHERTEXT");
    }
    return {
      provider: this.name,
      keyRef: this.keyRef,
      fingerprint: this.fingerprint,
      ciphertext: Buffer.from(response.ciphertext),
      metadata: {
        algorithm: "GOOGLE_SYMMETRIC_ENCRYPTION",
        format: "gcp-kms-v1",
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

    const additionalAuthenticatedData = canonicalKeyContext(context);
    let response: GcpDecryptResponse | undefined;
    try {
      [response] = await this.client.decrypt({
        name: this.keyRef,
        ciphertext: wrapped.ciphertext,
        additionalAuthenticatedData,
      });
    } catch (error) {
      throw providerError(classifyGcpError(error));
    } finally {
      additionalAuthenticatedData.fill(0);
    }

    if (
      !(response?.plaintext instanceof Uint8Array)
      || response.plaintext.length === 0
    ) {
      if (
        response?.plaintext === undefined
        || (
          response.plaintext instanceof Uint8Array
          && response.plaintext.length === 0
        )
      ) {
        throw providerError("EMPTY_PLAINTEXT");
      }
      throw providerError("INVALID_PLAINTEXT");
    }
    const providerPayload = response.plaintext;
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
      kind: "gcp-application-default-credentials",
      staticCredential: false,
    };
  }
}
