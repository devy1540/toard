import {
  DecryptCommand,
  EncryptCommand,
  KMSClient,
  type DecryptCommandOutput,
  type EncryptCommandOutput,
} from "@aws-sdk/client-kms";
import { randomBytes, timingSafeEqual } from "node:crypto";
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
  providerError,
} from "./provider-error";
import { awsKmsProviderFingerprint } from "./provider-fingerprint";

type ProviderErrorCode =
  | "AUTH_FAILED"
  | "EMPTY_CIPHERTEXT"
  | "EMPTY_PLAINTEXT"
  | "FAILED"
  | "INVALID_CIPHERTEXT"
  | "INVALID_PLAINTEXT"
  | "KEY_DISABLED"
  | "KEY_INVALID_STATE"
  | "KEY_MISMATCH"
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
  "KEY_INVALID_STATE",
  "KEY_MISMATCH",
  "KEY_NOT_FOUND",
  "TEMPORARY",
  "THROTTLED",
  "WRAPPER_MISMATCH",
]);

export interface AwsKmsClient {
  send(command: EncryptCommand): Promise<EncryptCommandOutput>;
  send(command: DecryptCommand): Promise<DecryptCommandOutput>;
}

export type AwsKmsProviderInput = {
  keyArn: string;
  region: string;
  endpoint?: string;
  client?: AwsKmsClient;
};

const HEALTH_CONTEXT: KeyContext = Object.freeze({
  installationId: "toard-provider-health",
  userId: "toard-provider-health",
  keyVersion: 0,
  purpose: "prompt-history",
});

export function keyContextMap(
  context: KeyContext,
): Readonly<Record<string, string>> {
  return Object.freeze({
    installationId: context.installationId,
    userId: context.userId,
    keyVersion: String(context.keyVersion),
    purpose: context.purpose,
  });
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

function httpStatusCode(error: unknown): number | undefined {
  if (
    typeof error !== "object"
    || error === null
    || !("$metadata" in error)
    || typeof error.$metadata !== "object"
    || error.$metadata === null
    || !("httpStatusCode" in error.$metadata)
    || typeof error.$metadata.httpStatusCode !== "number"
  ) {
    return undefined;
  }
  return error.$metadata.httpStatusCode;
}

function retryable(error: unknown): { retryable: boolean; throttling: boolean } {
  if (
    typeof error !== "object"
    || error === null
    || !("$retryable" in error)
    || typeof error.$retryable !== "object"
    || error.$retryable === null
  ) {
    return { retryable: false, throttling: false };
  }
  return {
    retryable: true,
    throttling: (
      "throttling" in error.$retryable
      && error.$retryable.throttling === true
    ),
  };
}

function classifyAwsError(error: unknown): ProviderErrorCode {
  const name = errorName(error);
  const status = httpStatusCode(error);
  const retry = retryable(error);

  if (
    status === 429
    || retry.throttling
    || /(?:Throttl|TooManyRequests)/i.test(name)
  ) {
    return "THROTTLED";
  }
  if (
    status === 401
    || status === 403
    || /(?:AccessDenied|NotAuthorized|UnrecognizedClient|InvalidSignature|ExpiredToken)/i.test(name)
  ) {
    return "AUTH_FAILED";
  }
  if (name === "NotFoundException") return "KEY_NOT_FOUND";
  if (name === "DisabledException") return "KEY_DISABLED";
  if (name === "KMSInvalidStateException") return "KEY_INVALID_STATE";
  if (name === "IncorrectKeyException") return "KEY_MISMATCH";
  if (name === "InvalidCiphertextException") return "INVALID_CIPHERTEXT";
  if (
    (status !== undefined && status >= 500)
    || retry.retryable
    || /(?:DependencyTimeout|ServiceUnavailable|InternalException)/i.test(name)
  ) {
    return "TEMPORARY";
  }
  return "FAILED";
}

function safeErrorCode(error: unknown): string {
  return inspectProviderError(error, "aws-kms", PROVIDER_ERROR_CODES)
    ?? "FAILED";
}

export class AwsKmsProvider implements KeyManagementProvider {
  readonly name = "aws-kms" as const;
  readonly keyRef: string;
  readonly fingerprint: string;
  private readonly client: AwsKmsClient;

  constructor(input: AwsKmsProviderInput) {
    this.keyRef = input.keyArn;
    this.fingerprint = awsKmsProviderFingerprint(
      input.keyArn,
      input.region,
      input.endpoint,
    );
    this.client = input.client ?? new KMSClient({
      region: input.region,
      endpoint: input.endpoint,
    });
  }

  async wrapKey(uck: Buffer, context: KeyContext): Promise<WrappedUserKey> {
    const payload = encodeUserKeyPayload(uck, context);
    let output: EncryptCommandOutput;
    try {
      output = await this.client.send(new EncryptCommand({
        KeyId: this.keyRef,
        Plaintext: payload,
        EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
        EncryptionContext: keyContextMap(context),
      }));
    } catch (error) {
      throw providerError(this.name, classifyAwsError(error));
    } finally {
      payload.fill(0);
    }

    if (
      !(output.CiphertextBlob instanceof Uint8Array)
      || output.CiphertextBlob.length === 0
    ) {
      throw providerError(this.name, "EMPTY_CIPHERTEXT");
    }
    return {
      provider: this.name,
      keyRef: this.keyRef,
      fingerprint: this.fingerprint,
      ciphertext: Buffer.from(output.CiphertextBlob),
      metadata: {
        algorithm: "SYMMETRIC_DEFAULT",
        format: "aws-kms-v1",
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
      throw providerError(this.name, "WRAPPER_MISMATCH");
    }
    if (
      !(wrapped.ciphertext instanceof Uint8Array)
      || wrapped.ciphertext.length === 0
    ) {
      throw providerError(this.name, "INVALID_CIPHERTEXT");
    }

    let output: DecryptCommandOutput;
    try {
      output = await this.client.send(new DecryptCommand({
        KeyId: this.keyRef,
        CiphertextBlob: wrapped.ciphertext,
        EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
        EncryptionContext: keyContextMap(context),
      }));
    } catch (error) {
      throw providerError(this.name, classifyAwsError(error));
    }

    const plaintext = output.Plaintext;
    try {
      if (!(plaintext instanceof Uint8Array) || plaintext.length === 0) {
        throw providerError(this.name, "EMPTY_PLAINTEXT");
      }
      let payload: Buffer | undefined;
      try {
        payload = Buffer.from(plaintext);
        return decodeUserKeyPayload(payload, context);
      } catch {
        throw providerError(this.name, "INVALID_PLAINTEXT");
      } finally {
        payload?.fill(0);
      }
    } finally {
      if (plaintext instanceof Uint8Array) plaintext.fill(0);
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
        throw providerError(this.name, "INVALID_PLAINTEXT");
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
      kind: "aws-sdk-default-chain",
      staticCredential: false,
    };
  }
}
