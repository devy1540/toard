// PromptRecord 와이어 포맷 (shim 본문 수집 → POST /api/v1/prompts).
// UsageEvent(wire.ts)와 형제 계약이지만 본문(text)을 실어 나른다.
// userId 는 본문에 없음 — 서버가 토큰으로 확정(§10.1). 암호화는 서버 몫이라 여기선 평문 text.
// (shim 이 실제로 붙으면 core 로 승격 + golden fixture 로 드리프트 검증 예정)
import {
  E2EE_MAX_CIPHERTEXT_BYTES,
  E2eeContractError,
  parseE2eePromptRecordsBody,
  type E2eePromptRecordWire,
} from "./e2ee-contract";

export class PromptWireError extends Error {
  constructor(
    message: string,
    /** 몇 번째 레코드에서 실패했는지 (단건 파싱은 undefined) */
    public readonly index?: number,
  ) {
    super(index === undefined ? message : `records[${index}]: ${message}`);
    this.name = "PromptWireError";
  }
}

export interface PromptRecordWire {
  dedupKey: string;
  sessionId: string | null;
  providerKey: string;
  turnRole: "user" | "assistant";
  ts: Date;
  text: string;
  agent?: PromptAgentWire | null;
}

export interface PromptAgentWire {
  id: string;
  parentId: string | null;
  depth: number | null;
  name: string | null;
  role: string | null;
}

export interface PromptAgentMetadataReconciliationWire {
  dedupKey: string;
  providerKey: string;
  agent: PromptAgentWire;
}

const SHA256_DEDUP_KEY = /^[a-f0-9]{64}$/;
const AGENT_METADATA_RECONCILIATION_PROVIDERS = new Set([
  "claude_code",
  "codex",
  "cursor",
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nonEmptyString(v: unknown, field: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new PromptWireError(`${field} 는 비어있지 않은 문자열이어야 합니다`);
  }
  return v;
}

function nullableString(v: unknown, field: string): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") throw new PromptWireError(`${field} 는 문자열 또는 null 이어야 합니다`);
  return v;
}

function boundedNullableString(v: unknown, field: string, max: number): string | null {
  const value = nullableString(v, field);
  if (value !== null && (value.length === 0 || value.length > max)) {
    throw new PromptWireError(`${field} 는 1~${max}자 문자열 또는 null 이어야 합니다`);
  }
  return value;
}

export function parsePromptAgentWire(v: unknown): PromptAgentWire | null {
  if (v === null || v === undefined) return null;
  if (!isRecord(v)) throw new PromptWireError("agent 는 객체 또는 null 이어야 합니다");
  const id = boundedNullableString(v.id, "agent.id", 255);
  if (id === null) throw new PromptWireError("agent.id 는 비어있지 않은 문자열이어야 합니다");
  const parentId = boundedNullableString(v.parentId, "agent.parentId", 255);
  const name = boundedNullableString(v.name, "agent.name", 100);
  const role = boundedNullableString(v.role, "agent.role", 100);
  let depth: number | null = null;
  if (v.depth !== null && v.depth !== undefined) {
    if (!Number.isSafeInteger(v.depth) || Number(v.depth) < 1 || Number(v.depth) > 32) {
      throw new PromptWireError("agent.depth 는 1~32 정수 또는 null 이어야 합니다");
    }
    depth = Number(v.depth);
  }
  return { id, parentId, depth, name, role };
}

/**
 * 과거 prompt_records의 서브에이전트 메타데이터만 보정하는 본문을 파싱한다.
 * 원문·세션·시각은 받지 않고, 기존 수집 때 계산한 정확한 dedupKey만 허용한다.
 */
export function parsePromptAgentMetadataReconciliationBody(
  body: unknown,
): PromptAgentMetadataReconciliationWire[] {
  if (!isRecord(body) || !Array.isArray(body.records)) {
    throw new PromptWireError("records 배열이 필요합니다");
  }
  if (body.records.length > 1_000) {
    throw new PromptWireError("records는 최대 1000개입니다");
  }
  return body.records.map((item, index) => {
    try {
      if (!isRecord(item)) throw new PromptWireError("레코드는 객체여야 합니다");
      const dedupKey = nonEmptyString(item.dedupKey, "dedupKey");
      if (!SHA256_DEDUP_KEY.test(dedupKey)) {
        throw new PromptWireError("dedupKey는 64자리 소문자 SHA-256이어야 합니다");
      }
      const providerKey = nonEmptyString(item.providerKey, "providerKey");
      if (!AGENT_METADATA_RECONCILIATION_PROVIDERS.has(providerKey)) {
        throw new PromptWireError("providerKey는 claude_code, codex, cursor 중 하나여야 합니다");
      }
      const agent = parsePromptAgentWire(item.agent);
      if (agent === null) throw new PromptWireError("agent가 필요합니다");
      return { dedupKey, providerKey, agent };
    } catch (error) {
      if (error instanceof PromptWireError && error.index === undefined) {
        throw new PromptWireError(error.message.replace(/^records\[\d+\]: /, ""), index);
      }
      throw error;
    }
  });
}

/** 와이어 JSON(unknown) 1건 → PromptRecordWire. 실패 시 PromptWireError. */
export function parsePromptRecordWire(v: unknown): PromptRecordWire {
  if (!isRecord(v)) throw new PromptWireError("레코드는 객체여야 합니다");
  const dedupKey = nonEmptyString(v.dedupKey, "dedupKey");
  const providerKey = nonEmptyString(v.providerKey, "providerKey");
  const sessionId = nullableString(v.sessionId, "sessionId");
  const turnRole = nonEmptyString(v.turnRole, "turnRole");
  if (turnRole !== "user" && turnRole !== "assistant") {
    throw new PromptWireError("turnRole 는 'user' 또는 'assistant' 여야 합니다");
  }
  const tsRaw = nonEmptyString(v.ts, "ts");
  const ts = new Date(tsRaw);
  if (Number.isNaN(ts.getTime())) throw new PromptWireError(`ts 가 유효한 ISO 8601 이 아닙니다: ${tsRaw}`);
  const text = nonEmptyString(v.text, "text");
  if (new TextEncoder().encode(text).byteLength > E2EE_MAX_CIPHERTEXT_BYTES) {
    throw new PromptWireError(`text는 ${E2EE_MAX_CIPHERTEXT_BYTES} byte 이하여야 합니다`);
  }
  const agent = parsePromptAgentWire(v.agent);
  return { dedupKey, providerKey, sessionId, turnRole, ts, text, agent };
}

/** POST /api/v1/prompts 본문(PromptRecord[] JSON) 파싱. */
export function parsePromptRecordsBody(body: unknown): PromptRecordWire[] {
  if (!Array.isArray(body)) throw new PromptWireError("본문은 PromptRecord 배열이어야 합니다");
  return body.map((item, i) => {
    try {
      return parsePromptRecordWire(item);
    } catch (e) {
      if (e instanceof PromptWireError && e.index === undefined) {
        throw new PromptWireError(e.message.replace(/^records\[\d+\]: /, ""), i);
      }
      throw e;
    }
  });
}

export type ParsedPromptBatch =
  | { schema: "plaintext_v1"; records: PromptRecordWire[] }
  | { schema: "e2ee_v1"; records: E2eePromptRecordWire[] };

/** 첫 레코드 schema로 배치를 고정하고 plaintext/E2EE 혼합을 fail-closed 한다. */
export function parsePromptBatch(body: unknown): ParsedPromptBatch {
  if (!Array.isArray(body)) throw new PromptWireError("본문은 PromptRecord 배열이어야 합니다");
  if (body.length === 0) return { schema: "plaintext_v1", records: [] };
  const schemas = new Set(
    body.map((item) =>
      typeof item === "object" && item !== null && !Array.isArray(item)
        ? (item as Record<string, unknown>).schema
        : undefined,
    ),
  );
  if (schemas.has("e2ee_v1") && (schemas.size !== 1 || !schemas.has("e2ee_v1"))) {
    throw new PromptWireError("plaintext_v1과 e2ee_v1 레코드를 혼합할 수 없습니다");
  }
  if (schemas.size === 1 && schemas.has("e2ee_v1")) {
    try {
      return { schema: "e2ee_v1", records: parseE2eePromptRecordsBody(body) };
    } catch (error) {
      if (error instanceof E2eeContractError) throw new PromptWireError(error.message);
      throw error;
    }
  }
  if ([...schemas].some((schema) => schema !== undefined)) {
    throw new PromptWireError("지원하지 않는 prompt schema입니다");
  }
  return { schema: "plaintext_v1", records: parsePromptRecordsBody(body) };
}
