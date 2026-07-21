export type ContentRole = "user" | "assistant";
export type E2eeAlgorithm = "AES-256-GCM";
export const E2EE_MAX_CIPHERTEXT_BYTES = 1_048_576;

export interface ContentAadInput {
  schema: "e2ee_v1";
  contentOwnerId: string;
  dedupKey: string;
  providerKey: string;
  turnRole: ContentRole;
  ts: string;
}

export interface E2eePromptRecordWire extends ContentAadInput {
  algorithm: E2eeAlgorithm;
  aadVersion: 1;
  contentKeyVersion: number;
  sessionId: string | null;
  wrappedDek: string;
  dekWrapIv: string;
  dekWrapAuthTag: string;
  iv: string;
  ciphertext: string;
  authTag: string;
  agent?: E2eePromptAgentWire | null;
}

export interface E2eePromptAgentWire {
  id: string;
  parentId: string | null;
  depth: number | null;
  name: string | null;
  role: string | null;
}

export interface ContentDeviceWire {
  kind: "shim" | "browser";
  label: string;
  platform: string;
  publicKey: string;
  algorithmVersion: "hpke-p256-v1";
}

export interface DeviceEnvelopeWire {
  algorithm: "hpke-p256-hkdf-sha256-aes256gcm-v1";
  encapsulatedKey: string;
  ciphertext: string;
}

export interface ContentKeyWrapperWire {
  wrapperType: "device" | "recovery";
  wrapperRef: string;
  contentKeyVersion: number;
  kdfVersion: "hkdf-sha256-v1" | "hpke-p256-v1";
  publicSaltOrInput: string | null;
  nonce: string | null;
  authTag: string | null;
  encapsulatedKey: string | null;
  wrappedContentKey: string;
}

export class E2eeContractError extends Error {
  constructor(message: string, public readonly index?: number) {
    super(index === undefined ? message : `records[${index}]: ${message}`);
    this.name = "E2eeContractError";
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function record(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new E2eeContractError(message);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const set = new Set(allowed);
  const extra = Object.keys(value).find((key) => !set.has(key));
  if (extra) throw new E2eeContractError(`허용되지 않은 필드: ${extra}`);
}

function string(value: unknown, field: string, max = 255): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new E2eeContractError(`${field}는 1~${max}자 문자열이어야 합니다`);
  }
  return value;
}

function nullableString(value: unknown, field: string, max = 255): string | null {
  if (value === null) return null;
  return string(value, field, max);
}

function optionalNullableString(value: unknown, field: string, max = 255): string | null {
  if (value === undefined || value === null) return null;
  return string(value, field, max);
}

function promptAgent(value: unknown): E2eePromptAgentWire | null {
  if (value === undefined || value === null) return null;
  const input = record(value, "agent는 객체 또는 null이어야 합니다");
  exactKeys(input, ["id", "parentId", "depth", "name", "role"]);
  let depth: number | null = null;
  if (input.depth !== undefined && input.depth !== null) {
    if (!Number.isSafeInteger(input.depth) || Number(input.depth) < 1 || Number(input.depth) > 32) {
      throw new E2eeContractError("agent.depth는 1 이상 32 이하 정수 또는 null이어야 합니다");
    }
    depth = Number(input.depth);
  }
  return {
    id: string(input.id, "agent.id", 255),
    parentId: optionalNullableString(input.parentId, "agent.parentId", 255),
    depth,
    name: optionalNullableString(input.name, "agent.name", 100),
    role: optionalNullableString(input.role, "agent.role", 100),
  };
}

function positiveVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 32_767) {
    throw new E2eeContractError("contentKeyVersion은 1 이상 32767 이하 정수여야 합니다");
  }
  return Number(value);
}

function uuid(value: unknown, field: string): string {
  const parsed = string(value, field, 64);
  if (!UUID_RE.test(parsed)) throw new E2eeContractError(`${field}는 UUID여야 합니다`);
  return parsed;
}

function isoTimestamp(value: unknown): string {
  const raw = string(value, "ts", 64);
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) throw new E2eeContractError("ts는 유효한 ISO 8601이어야 합니다");
  return parsed.toISOString();
}

export function fromBase64Url(value: unknown, field: string): Buffer {
  if (typeof value !== "string" || value.length === 0 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new E2eeContractError(`${field}는 padding 없는 base64url이어야 합니다`);
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length === 0 || decoded.toString("base64url") !== value) {
    throw new E2eeContractError(`${field}는 padding 없는 base64url이어야 합니다`);
  }
  return decoded;
}

function bytes(value: unknown, field: string, length: number): string {
  const decoded = fromBase64Url(value, field);
  if (decoded.length !== length) throw new E2eeContractError(`${field}는 ${length}바이트여야 합니다`);
  return value as string;
}

function rangedBytes(value: unknown, field: string, min: number, max: number): string {
  if (value === "") throw new E2eeContractError(`${field}는 ${min}바이트 이상이어야 합니다`);
  const decoded = fromBase64Url(value, field);
  if (decoded.length < min) throw new E2eeContractError(`${field}는 ${min}바이트 이상이어야 합니다`);
  if (decoded.length > max) throw new E2eeContractError(`${field}는 ${max}바이트 이하여야 합니다`);
  return value as string;
}

export function canonicalContentAad(input: ContentAadInput): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    schema: input.schema,
    contentOwnerId: input.contentOwnerId,
    dedupKey: input.dedupKey,
    providerKey: input.providerKey,
    turnRole: input.turnRole,
    ts: new Date(input.ts).toISOString(),
  }));
}

const E2EE_FIELDS = [
  "schema", "algorithm", "aadVersion", "contentOwnerId", "contentKeyVersion", "dedupKey",
  "sessionId", "providerKey", "turnRole", "ts", "wrappedDek", "dekWrapIv", "dekWrapAuthTag",
  "iv", "ciphertext", "authTag", "agent",
] as const;

export function parseE2eePromptRecord(value: unknown): E2eePromptRecordWire {
  const input = record(value, "레코드는 객체여야 합니다");
  exactKeys(input, E2EE_FIELDS);
  if (input.schema !== "e2ee_v1") throw new E2eeContractError("schema는 e2ee_v1이어야 합니다");
  if (input.algorithm !== "AES-256-GCM") {
    throw new E2eeContractError("algorithm은 AES-256-GCM이어야 합니다");
  }
  if (input.aadVersion !== 1) throw new E2eeContractError("aadVersion은 1이어야 합니다");
  if (input.turnRole !== "user" && input.turnRole !== "assistant") {
    throw new E2eeContractError("turnRole은 user 또는 assistant여야 합니다");
  }
  const agent = input.agent === undefined ? undefined : promptAgent(input.agent);
  return {
    schema: "e2ee_v1",
    algorithm: "AES-256-GCM",
    aadVersion: 1,
    contentOwnerId: uuid(input.contentOwnerId, "contentOwnerId"),
    contentKeyVersion: positiveVersion(input.contentKeyVersion),
    dedupKey: string(input.dedupKey, "dedupKey", 255),
    sessionId: nullableString(input.sessionId, "sessionId", 255),
    providerKey: string(input.providerKey, "providerKey", 100),
    turnRole: input.turnRole,
    ts: isoTimestamp(input.ts),
    wrappedDek: bytes(input.wrappedDek, "wrappedDek", 32),
    dekWrapIv: bytes(input.dekWrapIv, "dekWrapIv", 12),
    dekWrapAuthTag: bytes(input.dekWrapAuthTag, "dekWrapAuthTag", 16),
    iv: bytes(input.iv, "iv", 12),
    ciphertext: rangedBytes(input.ciphertext, "ciphertext", 1, E2EE_MAX_CIPHERTEXT_BYTES),
    authTag: bytes(input.authTag, "authTag", 16),
    ...(agent === undefined ? {} : { agent }),
  };
}

export function parseE2eePromptRecordsBody(value: unknown): E2eePromptRecordWire[] {
  if (!Array.isArray(value)) throw new E2eeContractError("본문은 E2EE 레코드 배열이어야 합니다");
  if (value.length > 1_000) throw new E2eeContractError("배치는 최대 1000건이어야 합니다");
  return value.map((item, index) => {
    try {
      return parseE2eePromptRecord(item);
    } catch (error) {
      if (error instanceof E2eeContractError) throw new E2eeContractError(error.message, index);
      throw error;
    }
  });
}

export function parseContentDevice(value: unknown): ContentDeviceWire {
  const input = record(value, "device는 객체여야 합니다");
  exactKeys(input, ["kind", "label", "platform", "publicKey", "algorithmVersion"]);
  if (input.kind !== "shim" && input.kind !== "browser") {
    throw new E2eeContractError("device kind는 shim 또는 browser여야 합니다");
  }
  if (input.algorithmVersion !== "hpke-p256-v1") {
    throw new E2eeContractError("device algorithmVersion은 hpke-p256-v1이어야 합니다");
  }
  return {
    kind: input.kind,
    label: string(input.label, "label", 80),
    platform: string(input.platform, "platform", 40),
    publicKey: bytes(input.publicKey, "publicKey", 65),
    algorithmVersion: "hpke-p256-v1",
  };
}

export function parseDeviceEnvelope(value: unknown): DeviceEnvelopeWire {
  const input = record(value, "device envelope는 객체여야 합니다");
  exactKeys(input, ["algorithm", "encapsulatedKey", "ciphertext"]);
  if (input.algorithm !== "hpke-p256-hkdf-sha256-aes256gcm-v1") {
    throw new E2eeContractError("device envelope algorithm이 지원되지 않습니다");
  }
  return {
    algorithm: input.algorithm,
    encapsulatedKey: bytes(input.encapsulatedKey, "encapsulatedKey", 65),
    ciphertext: rangedBytes(input.ciphertext, "ciphertext", 17, 1_024),
  };
}

export function parseContentKeyWrapper(value: unknown): ContentKeyWrapperWire {
  const input = record(value, "wrapper는 객체여야 합니다");
  exactKeys(input, [
    "wrapperType", "wrapperRef", "contentKeyVersion", "kdfVersion", "publicSaltOrInput",
    "nonce", "authTag", "encapsulatedKey", "wrappedContentKey",
  ]);
  if (input.wrapperType === "device") {
    if (input.kdfVersion !== "hpke-p256-v1") {
      throw new E2eeContractError("device wrapper의 kdfVersion은 hpke-p256-v1이어야 합니다");
    }
    if (input.publicSaltOrInput !== null) throw new E2eeContractError("device wrapper의 publicSaltOrInput은 null이어야 합니다");
    if (input.nonce !== null) throw new E2eeContractError("device wrapper의 nonce는 null이어야 합니다");
    if (input.authTag !== null) throw new E2eeContractError("device wrapper의 authTag는 null이어야 합니다");
    return {
      wrapperType: "device",
      wrapperRef: uuid(input.wrapperRef, "wrapperRef"),
      contentKeyVersion: positiveVersion(input.contentKeyVersion),
      kdfVersion: "hpke-p256-v1",
      publicSaltOrInput: null,
      nonce: null,
      authTag: null,
      encapsulatedKey: bytes(input.encapsulatedKey, "encapsulatedKey", 65),
      wrappedContentKey: rangedBytes(input.wrappedContentKey, "wrappedContentKey", 17, 1_024),
    };
  }
  if (input.wrapperType === "recovery") {
    if (input.kdfVersion !== "hkdf-sha256-v1") {
      throw new E2eeContractError("recovery wrapper의 kdfVersion은 hkdf-sha256-v1이어야 합니다");
    }
    if (input.encapsulatedKey !== null) throw new E2eeContractError("recovery wrapper의 encapsulatedKey는 null이어야 합니다");
    return {
      wrapperType: "recovery",
      wrapperRef: string(input.wrapperRef, "wrapperRef", 64),
      contentKeyVersion: positiveVersion(input.contentKeyVersion),
      kdfVersion: "hkdf-sha256-v1",
      publicSaltOrInput: bytes(input.publicSaltOrInput, "publicSaltOrInput", 32),
      nonce: bytes(input.nonce, "nonce", 12),
      authTag: bytes(input.authTag, "authTag", 16),
      encapsulatedKey: null,
      wrappedContentKey: bytes(input.wrappedContentKey, "wrappedContentKey", 32),
    };
  }
  throw new E2eeContractError("wrapperType은 device 또는 recovery여야 합니다");
}
