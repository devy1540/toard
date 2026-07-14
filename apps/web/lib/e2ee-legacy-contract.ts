import { E2eeContractError, parseE2eePromptRecord, type E2eePromptRecordWire } from "./e2ee-contract";

export type LegacyMigrationSource = {
  id: string;
  dedupKey: string;
  sessionId: string | null;
  providerKey: string;
  turnRole: "user" | "assistant";
  ts: string;
  text: string;
  sourceDigest: string;
};

export type LegacyMigrationCommitItem = {
  id: string;
  sourceDigest: string;
  record: E2eePromptRecordWire;
};

export function parseLegacyMigrationCommit(value: unknown): LegacyMigrationCommitItem[] {
  const input = exactObject(value, ["items"]);
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 25) {
    throw new E2eeContractError("legacy migration 배치는 1~25건이어야 합니다");
  }
  return input.items.map((raw) => {
    const item = exactObject(raw, ["id", "sourceDigest", "record"]);
    return {
      id: decimalId(item.id),
      sourceDigest: digest(item.sourceDigest),
      record: parseE2eePromptRecord(item.record),
    };
  });
}

function exactObject(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new E2eeContractError("legacy migration 값은 객체여야 합니다");
  }
  const object = value as Record<string, unknown>;
  const allowedSet = new Set(allowed);
  const extra = Object.keys(object).find((key) => !allowedSet.has(key));
  if (extra) throw new E2eeContractError(`허용되지 않은 필드: ${extra}`);
  return object;
}

function decimalId(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    throw new E2eeContractError("id는 양의 10진수 문자열이어야 합니다");
  }
  return value;
}

function digest(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new E2eeContractError("sourceDigest는 32바이트 base64url이어야 합니다");
  }
  const decoded = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=");
  if (decoded.length !== 32) {
    throw new E2eeContractError("sourceDigest는 32바이트 base64url이어야 합니다");
  }
  return value;
}
