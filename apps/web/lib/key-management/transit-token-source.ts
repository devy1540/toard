import { readFile as nodeReadFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { CredentialSourceSummary } from "./types";

type SecretFileReader = (path: string) => Promise<Buffer> | Buffer;

type LoginToken = {
  token: string;
  expiresAt: number;
};

type LoginSourceInput = {
  address: string;
  mount: string;
  namespace?: string;
  fetch?: typeof globalThis.fetch;
  readFile?: SecretFileReader;
  now?: () => number;
  timeoutMs?: number;
};

export interface TransitTokenSource {
  readonly description: CredentialSourceSummary;
  getToken(): Promise<string>;
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

function safePathSegment(value: string): string {
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

function validateSecretFile(path: string): void {
  if (!isAbsolute(path)) {
    throw new Error("TRANSIT_TOKEN_FILE_PATH_INVALID");
  }
}

function secretString(secret: Buffer): string {
  const value = secret.toString("utf8").trim();
  if (!value) throw new Error("TRANSIT_TOKEN_INVALID");
  return value;
}

async function readSecret(
  path: string,
  readFile: SecretFileReader,
): Promise<string> {
  let secret: Buffer;
  try {
    secret = await readFile(path);
  } catch {
    throw new Error("TRANSIT_SECRET_FILE_READ_FAILED");
  }
  if (!Buffer.isBuffer(secret)) {
    throw new Error("TRANSIT_SECRET_FILE_INVALID");
  }
  try {
    return secretString(secret);
  } finally {
    secret.fill(0);
  }
}

function authError(status: number): Error {
  if (status === 401 || status === 403) {
    return new Error("TRANSIT_AUTH_FAILED");
  }
  if (status === 429 || status >= 500) {
    return new Error("TRANSIT_AUTH_TEMPORARY");
  }
  return new Error("TRANSIT_AUTH_FAILED");
}

async function loginTransit(
  input: {
    fetch: typeof globalThis.fetch;
    address: string;
    namespace?: string;
    path: string;
    body: Record<string, string>;
    now: () => number;
    timeoutMs: number;
  },
): Promise<LoginToken> {
  const body = Buffer.from(JSON.stringify(input.body), "utf8");
  let response: Response;
  try {
    response = await input.fetch(
      new URL(input.path, requestBase(input.address)),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(input.namespace
            ? { "x-vault-namespace": input.namespace }
            : {}),
        },
        body,
        signal: AbortSignal.timeout(input.timeoutMs),
      },
    );
  } catch {
    throw new Error("TRANSIT_AUTH_TEMPORARY");
  } finally {
    body.fill(0);
  }
  if (!response.ok) throw authError(response.status);

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new Error("TRANSIT_AUTH_RESPONSE_INVALID");
  }
  if (
    typeof json !== "object"
    || json === null
    || !("auth" in json)
    || typeof json.auth !== "object"
    || json.auth === null
  ) {
    throw new Error("TRANSIT_AUTH_RESPONSE_INVALID");
  }
  const auth = json.auth;
  const token = "client_token" in auth ? auth.client_token : undefined;
  const leaseDuration = "lease_duration" in auth ? auth.lease_duration : undefined;
  const renewable = "renewable" in auth ? auth.renewable : undefined;
  if (
    typeof token !== "string"
    || token.trim() === ""
    || typeof leaseDuration !== "number"
    || !Number.isFinite(leaseDuration)
    || leaseDuration <= 0
    || (renewable !== undefined && typeof renewable !== "boolean")
  ) {
    throw new Error("TRANSIT_AUTH_RESPONSE_INVALID");
  }
  return {
    token,
    expiresAt: input.now() + (leaseDuration * 1_000),
  };
}

export class FileTokenSource implements TransitTokenSource {
  readonly description: CredentialSourceSummary = Object.freeze({
    kind: "transit-token-file",
    staticCredential: true,
  });
  private readonly path: string;
  private readonly readFile: SecretFileReader;

  constructor(
    path: string,
    readFile: SecretFileReader = nodeReadFile,
  ) {
    validateSecretFile(path);
    this.path = path;
    this.readFile = readFile;
  }

  getToken(): Promise<string> {
    return readSecret(this.path, this.readFile);
  }
}

abstract class CachedLoginTokenSource implements TransitTokenSource {
  abstract readonly description: CredentialSourceSummary;
  protected readonly address: string;
  protected readonly mount: string;
  protected readonly namespace?: string;
  protected readonly fetch: typeof globalThis.fetch;
  protected readonly readFile: SecretFileReader;
  protected readonly now: () => number;
  protected readonly timeoutMs: number;
  private cached: LoginToken | null = null;
  private pending: Promise<LoginToken> | null = null;

  protected constructor(input: LoginSourceInput) {
    this.address = canonicalAddress(input.address);
    this.mount = safePathSegment(input.mount);
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
    this.fetch = input.fetch ?? globalThis.fetch;
    this.readFile = input.readFile ?? nodeReadFile;
    this.now = input.now ?? Date.now;
    this.timeoutMs = input.timeoutMs ?? 5_000;
  }

  protected abstract login(): Promise<LoginToken>;

  async getToken(): Promise<string> {
    if (
      this.cached
      && this.now() < this.cached.expiresAt - 30_000
    ) {
      return this.cached.token;
    }
    if (!this.pending) {
      this.pending = this.login().then((token) => {
        this.cached = token;
        return token;
      }).finally(() => {
        this.pending = null;
      });
    }
    return (await this.pending).token;
  }

  protected loginRequest(body: Record<string, string>): Promise<LoginToken> {
    return loginTransit({
      fetch: this.fetch,
      address: this.address,
      namespace: this.namespace,
      path: `v1/auth/${this.mount}/login`,
      body,
      now: this.now,
      timeoutMs: this.timeoutMs,
    });
  }
}

export type KubernetesTokenSourceInput = LoginSourceInput & {
  role: string;
  jwtFile: string;
};

export class KubernetesTokenSource extends CachedLoginTokenSource {
  readonly description: CredentialSourceSummary = Object.freeze({
    kind: "transit-kubernetes",
    staticCredential: false,
  });
  private readonly role: string;
  private readonly jwtFile: string;

  constructor(input: KubernetesTokenSourceInput) {
    super(input);
    if (
      input.role === ""
      || input.role !== input.role.trim()
      || /[\r\n\u0000]/.test(input.role)
    ) {
      throw new Error("TRANSIT_KUBERNETES_ROLE_INVALID");
    }
    validateSecretFile(input.jwtFile);
    this.role = input.role;
    this.jwtFile = input.jwtFile;
  }

  protected async login(): Promise<LoginToken> {
    const jwt = await readSecret(this.jwtFile, this.readFile);
    return this.loginRequest({ role: this.role, jwt });
  }
}

export type AppRoleTokenSourceInput = LoginSourceInput & {
  roleIdFile: string;
  secretIdFile: string;
};

export class AppRoleTokenSource extends CachedLoginTokenSource {
  readonly description: CredentialSourceSummary = Object.freeze({
    kind: "transit-approle",
    staticCredential: true,
  });
  private readonly roleIdFile: string;
  private readonly secretIdFile: string;

  constructor(input: AppRoleTokenSourceInput) {
    super(input);
    validateSecretFile(input.roleIdFile);
    validateSecretFile(input.secretIdFile);
    this.roleIdFile = input.roleIdFile;
    this.secretIdFile = input.secretIdFile;
  }

  protected async login(): Promise<LoginToken> {
    const roleId = await readSecret(this.roleIdFile, this.readFile);
    const secretId = await readSecret(this.secretIdFile, this.readFile);
    return this.loginRequest({
      role_id: roleId,
      secret_id: secretId,
    });
  }
}
