import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { TextDecoder } from "node:util";
import {
  canonicalKeyContext,
  decodeUserKeyPayload,
  encodeUserKeyPayload,
} from "./context";
import type { TransitClientLike } from "./transit-client";
import { isTransitCiphertext } from "./transit-validation";
import type {
  CredentialSourceSummary,
  KeyContext,
  KeyManagementProvider,
  KeyProviderHealth,
  KeyProviderName,
  WrappedUserKey,
} from "./types";

type TransitProviderName = Extract<
  KeyProviderName,
  "vault-transit" | "openbao-transit"
>;

type ProviderErrorCode =
  | "AUTH_FAILED"
  | "FAILED"
  | "INVALID_CIPHERTEXT"
  | "INVALID_PLAINTEXT"
  | "KEY_NOT_FOUND"
  | "RESPONSE_INVALID"
  | "TEMPORARY"
  | "THROTTLED"
  | "WRAPPER_MISMATCH";

export type TransitProviderInput = {
  client: TransitClientLike;
};

const HEALTH_CONTEXT: KeyContext = Object.freeze({
  installationId: "toard-provider-health",
  userId: "toard-provider-health",
  keyVersion: 0,
  purpose: "prompt-history",
});

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const TRANSIT_ERROR =
  /^TRANSIT:(AUTH_FAILED|FAILED|KEY_NOT_FOUND|RESPONSE_INVALID|TEMPORARY|THROTTLED)(?:\s|$)/;

function providerError(
  provider: TransitProviderName,
  code: ProviderErrorCode,
): Error {
  return new Error(`${provider}:${code}`);
}

function classifyTransitError(error: unknown): ProviderErrorCode {
  if (!(error instanceof Error)) return "FAILED";
  const match = TRANSIT_ERROR.exec(error.message);
  return (match?.[1] as ProviderErrorCode | undefined) ?? "FAILED";
}

function providerFingerprint(
  provider: TransitProviderName,
  client: TransitClientLike,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([
      provider,
      client.address,
      client.mount,
      client.keyName,
      client.namespace ?? null,
    ]))
    .digest("hex")
    .slice(0, 24);
  return `${provider}:${digest}`;
}

function safeErrorCode(
  provider: TransitProviderName,
  error: unknown,
): string {
  if (
    error instanceof Error
    && error.message.startsWith(`${provider}:`)
  ) {
    return error.message.slice(provider.length + 1);
  }
  return "FAILED";
}

export abstract class TransitKeyManagementProvider
implements KeyManagementProvider {
  abstract readonly name: TransitProviderName;
  readonly keyRef: string;
  readonly fingerprint: string;
  protected readonly client: TransitClientLike;

  protected constructor(
    name: TransitProviderName,
    input: TransitProviderInput,
  ) {
    this.client = input.client;
    this.keyRef = input.client.keyRef;
    this.fingerprint = providerFingerprint(name, input.client);
  }

  async wrapKey(uck: Buffer, context: KeyContext): Promise<WrappedUserKey> {
    const payload = encodeUserKeyPayload(uck, context);
    const aad = canonicalKeyContext(context);
    let ciphertext: string;
    try {
      ciphertext = await this.client.encrypt(payload, aad);
    } catch (error) {
      throw providerError(this.name, classifyTransitError(error));
    } finally {
      payload.fill(0);
      aad.fill(0);
    }
    if (
      !isTransitCiphertext(ciphertext)
    ) {
      throw providerError(this.name, "INVALID_CIPHERTEXT");
    }
    return {
      provider: this.name,
      keyRef: this.keyRef,
      fingerprint: this.fingerprint,
      ciphertext: Buffer.from(ciphertext, "utf8"),
      metadata: {
        algorithm: "transit-aead",
        format: "vault-ciphertext-v1",
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

    let ciphertext: string;
    try {
      ciphertext = UTF8_DECODER.decode(wrapped.ciphertext);
    } catch {
      throw providerError(this.name, "INVALID_CIPHERTEXT");
    }
    if (
      !isTransitCiphertext(ciphertext)
    ) {
      throw providerError(this.name, "INVALID_CIPHERTEXT");
    }

    const aad = canonicalKeyContext(context);
    let payload: Buffer;
    try {
      payload = await this.client.decrypt(ciphertext, aad);
    } catch (error) {
      throw providerError(this.name, classifyTransitError(error));
    } finally {
      aad.fill(0);
      ciphertext = "";
    }
    try {
      return decodeUserKeyPayload(payload, context);
    } catch {
      throw providerError(this.name, "INVALID_PLAINTEXT");
    } finally {
      payload.fill(0);
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
        errorCode: safeErrorCode(this.name, error),
      };
    } finally {
      userKey.fill(0);
      unwrapped?.fill(0);
    }
  }

  describeCredentialSource(): Promise<CredentialSourceSummary> {
    return this.client.describeCredentialSource();
  }
}

export class VaultTransitProvider extends TransitKeyManagementProvider {
  readonly name = "vault-transit" as const;

  constructor(input: TransitProviderInput) {
    super("vault-transit", input);
  }
}
