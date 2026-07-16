export const E2EE_MANAGED_MIGRATION_MAX_ITEMS = 25;
export const E2EE_MANAGED_MIGRATION_MAX_TEXT_BYTES = 1_048_576;
export const E2EE_MANAGED_MIGRATION_MAX_BODY_BYTES = 4_194_304;

export type E2eeManagedCommitItem = { id: string; sourceDigest: string; text: string };
export type E2eeManagedMigrationStateInput =
  | { action: "block"; confirmation: "KEY_UNAVAILABLE" }
  | { action: "resume" };

export class MigrationContractError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "MigrationContractError";
  }
}

const CONTRACT_CODES = new Set([
  "INVALID_MIGRATION_BATCH", "MIGRATION_ITEMS_MUST_BE_1~25", "DUPLICATE_ID",
  "INVALID_MIGRATION_ID", "INVALID_SOURCE_DIGEST", "INVALID_MIGRATION_TEXT",
  "INVALID_MIGRATION_LIMIT", "BLOCK_CONFIRMATION_REQUIRED", "INVALID_MIGRATION_ACTION",
  "INVALID_MIGRATION_STATE",
]);

export function migrationContractErrorCode(error: unknown): string | null {
  try {
    if (!(error instanceof MigrationContractError)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    return typeof descriptor?.value === "string" && CONTRACT_CODES.has(descriptor.value)
      ? descriptor.value
      : null;
  } catch { return null; }
}

export function parseE2eeManagedCommit(value: unknown): E2eeManagedCommitItem[] {
  try {
    const root = exactPlainObject(value, ["items"]);
    const items = ownData(root, "items");
    if (!Array.isArray(items) || items.length < 1 || items.length > E2EE_MANAGED_MIGRATION_MAX_ITEMS) {
      throw new MigrationContractError("MIGRATION_ITEMS_MUST_BE_1~25");
    }
    const seen = new Set<string>();
    return items.map((raw) => {
      const input = exactPlainObject(raw, ["id", "sourceDigest", "text"]);
      const id = positiveDecimal(ownData(input, "id"));
      if (seen.has(id)) throw new MigrationContractError("DUPLICATE_ID");
      seen.add(id);
      return {
        id,
        sourceDigest: digest(ownData(input, "sourceDigest")),
        text: boundedText(ownData(input, "text")),
      };
    });
  } catch (error) {
    const code = migrationContractErrorCode(error);
    if (code) throw new MigrationContractError(code);
    throw new MigrationContractError("INVALID_MIGRATION_BATCH");
  }
}

export function parseE2eeManagedLimit(value: string | null): number {
  if (value === null) return E2EE_MANAGED_MIGRATION_MAX_ITEMS;
  if (!/^-?(?:0|[1-9][0-9]*)$/.test(value)) throw new MigrationContractError("INVALID_MIGRATION_LIMIT");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new MigrationContractError("INVALID_MIGRATION_LIMIT");
  return Math.min(E2EE_MANAGED_MIGRATION_MAX_ITEMS, Math.max(1, parsed));
}

export function parseE2eeManagedState(value: unknown): E2eeManagedMigrationStateInput {
  try {
    const input = exactPlainObject(value, ["action", "confirmation"], true);
    const action = ownData(input, "action");
    if (action === "block") {
      if (!hasOwn(input, "confirmation") || ownData(input, "confirmation") !== "KEY_UNAVAILABLE") {
        throw new MigrationContractError("BLOCK_CONFIRMATION_REQUIRED");
      }
      exactKeys(input, ["action", "confirmation"]);
      return { action, confirmation: "KEY_UNAVAILABLE" };
    }
    if (action === "resume") {
      exactKeys(input, ["action"]);
      return { action };
    }
    throw new MigrationContractError("INVALID_MIGRATION_ACTION");
  } catch (error) {
    const code = migrationContractErrorCode(error);
    if (code) throw new MigrationContractError(code);
    throw new MigrationContractError("INVALID_MIGRATION_STATE");
  }
}

function exactPlainObject(
  value: unknown,
  allowed: readonly string[],
  allowMissing = false,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MigrationContractError("INVALID_MIGRATION_BATCH");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new MigrationContractError("INVALID_MIGRATION_BATCH");
  }
  const input = value as Record<string, unknown>;
  exactKeys(input, allowed);
  if (!allowMissing) {
    for (const key of allowed) if (!hasOwn(input, key)) throw new MigrationContractError("INVALID_MIGRATION_BATCH");
  }
  return input;
}

function exactKeys(input: Record<string, unknown>, allowed: readonly string[]): void {
  const keys = Object.keys(input);
  if (keys.some((key) => !allowed.includes(key))) throw new MigrationContractError("INVALID_MIGRATION_BATCH");
}

function ownData(input: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
    throw new MigrationContractError("INVALID_MIGRATION_BATCH");
  }
  return descriptor.value;
}

function hasOwn(input: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, key);
}

function positiveDecimal(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
    throw new MigrationContractError("INVALID_MIGRATION_ID");
  }
  try {
    const parsed = BigInt(value);
    if (parsed > 9_223_372_036_854_775_807n) throw new Error();
  } catch {
    throw new MigrationContractError("INVALID_MIGRATION_ID");
  }
  return value;
}

function digest(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new MigrationContractError("INVALID_SOURCE_DIGEST");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== 32 || decoded.toString("base64url") !== value) {
    throw new MigrationContractError("INVALID_SOURCE_DIGEST");
  }
  return value;
}

function boundedText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || !wellFormedUnicode(value)) {
    throw new MigrationContractError("INVALID_MIGRATION_TEXT");
  }
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < 1 || bytes > E2EE_MANAGED_MIGRATION_MAX_TEXT_BYTES) {
    throw new MigrationContractError("INVALID_MIGRATION_TEXT");
  }
  return value;
}

function wellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}
