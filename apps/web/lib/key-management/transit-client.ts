import type { CredentialSourceSummary } from "./types";
import type { TransitTokenSource } from "./transit-token-source";

type TransitErrorCode =
  | "AUTH_FAILED"
  | "FAILED"
  | "KEY_NOT_FOUND"
  | "RESPONSE_INVALID"
  | "TEMPORARY"
  | "THROTTLED";

export interface TransitClientLike {
  readonly address: string;
  readonly mount: string;
  readonly keyName: string;
  readonly namespace?: string;
  readonly keyRef: string;
  encrypt(payload: Buffer, aad: Buffer): Promise<string>;
  decrypt(ciphertext: string, aad: Buffer): Promise<Buffer>;
  describeCredentialSource(): Promise<CredentialSourceSummary>;
}

export type TransitClientInput = {
  address: string;
  mount: string;
  keyName: string;
  namespace?: string;
  tokenSource: TransitTokenSource;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
};

function transitError(code: TransitErrorCode): Error {
  return new Error(`TRANSIT:${code}`);
}

function canonicalAddress(address: string): string {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new Error("TRANSIT_ADDRESS_INVALID");
  }
  if (
    address !== address.trim()
    || /\s/.test(address)
    || url.protocol !== "https:"
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new Error("TRANSIT_ADDRESS_INVALID");
  }
  return url.href;
}

function pathSegment(value: string): string {
  if (
    value === ""
    || value !== value.trim()
    || value === "."
    || value === ".."
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error("TRANSIT_PATH_INVALID");
  }
  return encodeURIComponent(value);
}

function requestBase(address: string): string {
  return address.endsWith("/") ? address : `${address}/`;
}

function classifyStatus(status: number): TransitErrorCode {
  if (status === 401 || status === 403) return "AUTH_FAILED";
  if (status === 404) return "KEY_NOT_FOUND";
  if (status === 429) return "THROTTLED";
  if (status >= 500) return "TEMPORARY";
  return "FAILED";
}

function isStrictBase64(value: string): boolean {
  if (
    value === ""
    || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    return false;
  }
  return Buffer.from(value, "base64").toString("base64") === value;
}

export class TransitClient implements TransitClientLike {
  readonly address: string;
  readonly mount: string;
  readonly keyName: string;
  readonly namespace?: string;
  readonly keyRef: string;
  private readonly encodedMount: string;
  private readonly encodedKeyName: string;
  private readonly tokenSource: TransitTokenSource;
  private readonly fetch: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(input: TransitClientInput) {
    this.address = canonicalAddress(input.address);
    this.encodedMount = pathSegment(input.mount);
    this.encodedKeyName = pathSegment(input.keyName);
    this.mount = input.mount;
    this.keyName = input.keyName;
    this.namespace = input.namespace;
    if (
      this.namespace !== undefined
      && (
        this.namespace === ""
        || this.namespace !== this.namespace.trim()
        || /[\r\n\u0000]/.test(this.namespace)
      )
    ) {
      throw new Error("TRANSIT_NAMESPACE_INVALID");
    }
    this.keyRef = new URL(
      `v1/${this.encodedMount}/keys/${this.encodedKeyName}`,
      requestBase(this.address),
    ).href;
    this.tokenSource = input.tokenSource;
    this.fetch = input.fetch ?? globalThis.fetch;
    this.timeoutMs = input.timeoutMs ?? 5_000;
  }

  private async post(
    operation: "encrypt" | "decrypt",
    body: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    let token: string;
    try {
      token = await this.tokenSource.getToken();
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message === "TRANSIT_AUTH_FAILED") throw transitError("AUTH_FAILED");
      if (message === "TRANSIT_AUTH_TEMPORARY") throw transitError("TEMPORARY");
      throw transitError("AUTH_FAILED");
    }
    if (!token.trim()) throw transitError("AUTH_FAILED");

    const encodedBody = Buffer.from(JSON.stringify(body), "utf8");
    let response: Response;
    try {
      response = await this.fetch(
        new URL(
          `v1/${this.encodedMount}/${operation}/${this.encodedKeyName}`,
          requestBase(this.address),
        ),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-vault-token": token,
            ...(this.namespace
              ? { "x-vault-namespace": this.namespace }
              : {}),
          },
          body: encodedBody,
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
    } catch {
      throw transitError("TEMPORARY");
    } finally {
      encodedBody.fill(0);
      token = "";
    }
    if (!response.ok) throw transitError(classifyStatus(response.status));

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw transitError("RESPONSE_INVALID");
    }
    if (
      typeof json !== "object"
      || json === null
      || !("data" in json)
      || typeof json.data !== "object"
      || json.data === null
      || Array.isArray(json.data)
    ) {
      throw transitError("RESPONSE_INVALID");
    }
    return json.data as Record<string, unknown>;
  }

  async encrypt(payload: Buffer, aad: Buffer): Promise<string> {
    const data = await this.post("encrypt", {
      plaintext: payload.toString("base64"),
      associated_data: aad.toString("base64"),
    });
    if (
      typeof data.ciphertext !== "string"
      || data.ciphertext.trim() === ""
      || /[\r\n\u0000]/.test(data.ciphertext)
    ) {
      throw transitError("RESPONSE_INVALID");
    }
    return data.ciphertext;
  }

  async decrypt(ciphertext: string, aad: Buffer): Promise<Buffer> {
    if (
      ciphertext.trim() === ""
      || /[\r\n\u0000]/.test(ciphertext)
    ) {
      throw transitError("RESPONSE_INVALID");
    }
    const data = await this.post("decrypt", {
      ciphertext,
      associated_data: aad.toString("base64"),
    });
    if (
      typeof data.plaintext !== "string"
      || !isStrictBase64(data.plaintext)
    ) {
      throw transitError("RESPONSE_INVALID");
    }
    return Buffer.from(data.plaintext, "base64");
  }

  async describeCredentialSource(): Promise<CredentialSourceSummary> {
    return {
      kind: this.tokenSource.description.kind,
      staticCredential: this.tokenSource.description.staticCredential,
    };
  }
}
