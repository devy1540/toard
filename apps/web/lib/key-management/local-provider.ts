import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
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
import { localProviderFingerprint } from "./provider-fingerprint";

const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const USER_KEY_PAYLOAD_LENGTH = 68;
const WRAPPED_CIPHERTEXT_LENGTH = IV_LENGTH + AUTH_TAG_LENGTH + USER_KEY_PAYLOAD_LENGTH;

export class LocalKeyManagementProvider implements KeyManagementProvider {
  readonly name = "local" as const;
  readonly keyRef: string;
  readonly fingerprint: string;
  private readonly kek: Buffer;

  constructor(input: { keyFile: string; readFile?: (path: string) => Buffer }) {
    if (!isAbsolute(input.keyFile)) {
      throw new Error("LOCAL_KEK_FILE_PATH_MUST_BE_ABSOLUTE");
    }
    let raw: Buffer;
    try {
      raw = (input.readFile ?? ((path) => readFileSync(path)))(input.keyFile);
    } catch {
      throw new Error("LOCAL_KEK_FILE_UNAVAILABLE");
    }
    if (!Buffer.isBuffer(raw) || raw.length !== 32) {
      throw new Error("LOCAL_KEK_FILE_MUST_BE_32_BYTES");
    }
    this.kek = Buffer.from(raw);
    this.keyRef = `file:${input.keyFile}`;
    this.fingerprint = localProviderFingerprint(this.kek);
  }

  async wrapKey(uck: Buffer, context: KeyContext): Promise<WrappedUserKey> {
    const payload = encodeUserKeyPayload(uck, context);
    try {
      const iv = randomBytes(IV_LENGTH);
      const cipher = createCipheriv("aes-256-gcm", this.kek, iv);
      cipher.setAAD(canonicalKeyContext(context));
      const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
      return {
        provider: this.name,
        keyRef: this.keyRef,
        fingerprint: this.fingerprint,
        ciphertext: Buffer.concat([iv, cipher.getAuthTag(), encrypted]),
        metadata: { algorithm: "aes-256-gcm", format: "local-v1" },
      };
    } finally {
      payload.fill(0);
    }
  }

  async unwrapKey(wrapped: WrappedUserKey, context: KeyContext): Promise<Buffer> {
    if (
      wrapped.provider !== this.name
      || wrapped.keyRef !== this.keyRef
      || wrapped.fingerprint !== this.fingerprint
    ) {
      throw new Error("LOCAL_KEY_WRAPPER_MISMATCH");
    }
    if (wrapped.ciphertext.length !== WRAPPED_CIPHERTEXT_LENGTH) {
      throw new Error("LOCAL_KEY_CIPHERTEXT_INVALID");
    }

    const iv = wrapped.ciphertext.subarray(0, IV_LENGTH);
    const authTag = wrapped.ciphertext.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const encrypted = wrapped.ciphertext.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
    let payload: Buffer | null = null;
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.kek, iv);
      decipher.setAAD(canonicalKeyContext(context));
      decipher.setAuthTag(authTag);
      payload = Buffer.concat([decipher.update(encrypted), decipher.final()]);
      return decodeUserKeyPayload(payload, context);
    } catch {
      throw new Error("LOCAL_KEY_CONTEXT_OR_CIPHERTEXT_INVALID");
    } finally {
      payload?.fill(0);
    }
  }

  async healthCheck(): Promise<KeyProviderHealth> {
    return {
      status: "healthy",
      latencyMs: 0,
      checkedAt: new Date(),
    };
  }

  async describeCredentialSource(): Promise<CredentialSourceSummary> {
    return {
      kind: "secret-file",
      staticCredential: true,
    };
  }
}
