import { createHash, timingSafeEqual, type Hash } from "node:crypto";
import type { PoolClient } from "pg";
import { decryptManagedContent, encryptManagedContent } from "./managed-content-crypto";
import type { ManagedContentRuntime } from "./managed-content-runtime";
import {
  E2EE_MANAGED_MIGRATION_MAX_BODY_BYTES,
  migrationContractErrorCode,
  parseE2eeManagedCommit,
  parseE2eeManagedState,
  type E2eeManagedCommitItem,
  type E2eeManagedMigrationStateInput,
} from "./e2ee-to-managed-contract";
import type { E2eePromptRecordWire } from "./e2ee-contract";
import type { PromptRecordWire } from "./prompt-wire";
import { withUserContext } from "./rls";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_CIPHERTEXT = 1_048_576;
const MAX_VERSION = 32_767;

type QueryResultLike = { rows: Record<string, unknown>[]; rowCount?: number | null };
export type E2eeMigrationDb = { query(sql: string, params?: unknown[]): Promise<QueryResultLike> };

export type E2eeManagedMigrationSource = {
  id: string;
  sourceDigest: string;
  record: E2eePromptRecordWire;
};

const migrationErrorBrand = new WeakMap<object, string>();

export class E2eeManagedMigrationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "E2eeManagedMigrationError";
    migrationErrorBrand.set(this, code);
  }
}

const MIGRATION_CODES = new Set([
  "INVALID_USER_ID", "INVALID_MIGRATION_LIMIT", "MIGRATION_NOT_FOUND",
  "MIGRATION_STATE_CORRUPT", "MIGRATION_PAGE_TOO_LARGE", "MIGRATION_NOT_RUNNABLE",
  "E2EE_SOURCE_CORRUPT", "E2EE_SOURCE_CHANGED", "MANAGED_KEY_INVALID",
  "MANAGED_KEY_UNAVAILABLE", "MANAGED_ROUND_TRIP_FAILED", "MIGRATION_STATE_CHANGED",
  "CONTENT_ACCOUNT_STATE_CHANGED", "BLOCK_CONFIRMATION_REQUIRED",
  "INVALID_MIGRATION_STATE", "MIGRATION_FAILED",
]);

export function e2eeManagedMigrationErrorCode(error: unknown): string | null {
  try {
    if ((typeof error !== "object" && typeof error !== "function") || error === null) return null;
    const code = migrationErrorBrand.get(error);
    return typeof code === "string" && MIGRATION_CODES.has(code)
      ? code
      : null;
  } catch { return null; }
}

const MIGRATION_CONFLICT_CODES = new Set([
  "MIGRATION_NOT_FOUND", "MIGRATION_NOT_RUNNABLE", "E2EE_SOURCE_CHANGED",
  "MIGRATION_STATE_CHANGED", "CONTENT_ACCOUNT_STATE_CHANGED",
]);

export function e2eeManagedMigrationHttpStatus(code: string): 409 | 413 | 503 {
  if (code === "MIGRATION_PAGE_TOO_LARGE") return 413;
  return MIGRATION_CONFLICT_CODES.has(code) ? 409 : 503;
}

export async function getE2eeManagedMigrationStatus(userId: string, db?: E2eeMigrationDb) {
  assertUserId(userId);
  try { return await runUserTransaction(userId, db, async (tx) => {
    const result = await tx.query(
      `SELECT migration.state, migration.started_at, migration.completed_at,
              migration.blocked_at, migration.blocked_reason,
              progress.e2ee_records, progress.migrated_records
         FROM content_e2ee_migrations migration
         CROSS JOIN LATERAL get_content_e2ee_migration_progress(migration.user_id) progress
        WHERE migration.user_id=$1
        `,
      [userId],
    );
    const row = result.rows[0];
    if (!row) throw new E2eeManagedMigrationError("MIGRATION_NOT_FOUND");
    const state = migrationState(row.state);
    return {
      state,
      e2eeRecords: count(row.e2ee_records),
      migratedRecords: count(row.migrated_records),
      startedAt: nullableIso(row.started_at),
      completedAt: nullableIso(row.completed_at),
      blockedAt: nullableIso(row.blocked_at),
      blockedReason: row.blocked_reason === "key_unavailable" ? "key_unavailable" as const : null,
    };
  }); } catch (error) { throw safeServiceError(error); }
}

export async function getE2eeManagedMigrationPage(
  userId: string,
  limit = 25,
  db?: E2eeMigrationDb,
): Promise<{ records: E2eeManagedMigrationSource[] }> {
  assertUserId(userId);
  if (!Number.isFinite(limit) || !Number.isInteger(limit)) throw new E2eeManagedMigrationError("INVALID_MIGRATION_LIMIT");
  const bounded = Math.min(25, Math.max(1, limit));
  try { return await runUserTransaction(userId, db, async (tx) => {
    const result = await tx.query(
      `SELECT record.id,record.user_id,record.dedup_key,record.session_id,
              record.provider_key,record.turn_role,record.ts,record.encryption_scheme,
              record.key_version,record.content_owner_id,record.content_key_version,
              record.wrapped_dek,record.dek_wrap_iv,record.dek_wrap_auth_tag,
              record.iv,record.ciphertext,record.auth_tag,record.aad_version
         FROM prompt_records record
        WHERE record.user_id=$1 AND record.encryption_scheme='e2ee_v1'
        ORDER BY record.id ASC LIMIT $2`,
      [userId, bounded],
    );
    const records: E2eeManagedMigrationSource[] = [];
    for (const row of result.rows) {
      const source = toMigrationSource(row, userId);
      const candidate = { records: [...records, source] };
      if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > E2EE_MANAGED_MIGRATION_MAX_BODY_BYTES) {
        if (records.length === 0) throw new E2eeManagedMigrationError("MIGRATION_PAGE_TOO_LARGE");
        break;
      }
      records.push(source);
    }
    return { records };
  }); } catch (error) { throw safeServiceError(error); }
}

export async function commitE2eeManagedBatch(
  userId: string,
  rawItems: E2eeManagedCommitItem[],
  runtime: ManagedContentRuntime,
  db?: E2eeMigrationDb,
): Promise<{ migrated: number; remaining: number; complete: boolean }> {
  assertUserId(userId);
  const items = parseE2eeManagedCommit({ items: rawItems });
  try {
    return await runtime.userKeys.withActiveUserKey(userId, async (uck, keyVersion) => {
      assertManagedKey(uck, keyVersion);
      const key = Buffer.from(uck);
      try {
        try { return await runUserTransaction(userId, db, async (tx) => {
          const running = await tx.query(
            `UPDATE content_e2ee_migrations
                SET state='running', started_at=COALESCE(started_at, now()),
                    completed_at=NULL, blocked_at=NULL, blocked_reason=NULL,
                    last_error_code=NULL, updated_at=now()
              WHERE user_id=$1 AND state IN ('pending','running')`,
            [userId],
          );
          if (running.rowCount !== 1) throw new E2eeManagedMigrationError("MIGRATION_NOT_RUNNABLE");

          for (const item of items) {
            const locked = await tx.query(
              `SELECT record.id,record.user_id,record.dedup_key,record.session_id,
                      record.provider_key,record.turn_role,record.ts,record.encryption_scheme,
                      record.key_version,record.content_owner_id,record.content_key_version,
                      record.wrapped_dek,record.dek_wrap_iv,record.dek_wrap_auth_tag,
                      record.iv,record.ciphertext,record.auth_tag,record.aad_version
                 FROM prompt_records record
                WHERE record.id=$1 AND record.user_id=$2 AND record.encryption_scheme='e2ee_v1'
                FOR UPDATE OF record`,
              [item.id, userId],
            );
            const source = locked.rows[0];
            if (!source) throw new E2eeManagedMigrationError("E2EE_SOURCE_CHANGED");
            assertDigest(source, item.sourceDigest, userId);
            await replaceSource(tx, source, item, runtime.installationId, userId, keyVersion, key);
          }

          const remainingResult = await tx.query(
            `SELECT COUNT(*)::int AS count
               FROM prompt_records record
              WHERE record.user_id=$1 AND record.encryption_scheme='e2ee_v1'`,
            [userId],
          );
          const remaining = count(remainingResult.rows[0]?.count);
          if (remaining === 0) {
            const completed = await tx.query(
              `UPDATE content_e2ee_migrations
                  SET state='complete', completed_at=now(), blocked_at=NULL,
                      blocked_reason=NULL, last_error_code=NULL, updated_at=now()
                WHERE user_id=$1 AND state='running'`,
              [userId],
            );
            if (completed.rowCount !== 1) throw new E2eeManagedMigrationError("MIGRATION_STATE_CHANGED");
            const account = await tx.query(
              `UPDATE content_accounts SET state='migrated', updated_at=now()
                WHERE user_id=$1 AND state IN ('active','migrated')`,
              [userId],
            );
            if (account.rowCount !== 1) throw new E2eeManagedMigrationError("CONTENT_ACCOUNT_STATE_CHANGED");
          }
          return { migrated: items.length, remaining, complete: remaining === 0 };
        }); } catch (error) { throw safeServiceError(error); }
      } finally {
        key.fill(0);
      }
    });
  } catch (error) {
    const code = e2eeManagedMigrationErrorCode(error);
    if (code) throw new E2eeManagedMigrationError(code);
    throw new E2eeManagedMigrationError("MANAGED_KEY_UNAVAILABLE");
  }
}

export async function setE2eeManagedMigrationState(
  userId: string,
  rawInput: E2eeManagedMigrationStateInput,
  db?: E2eeMigrationDb,
): Promise<{ state: "blocked" | "pending" }> {
  assertUserId(userId);
  let input: E2eeManagedMigrationStateInput;
  try { input = parseE2eeManagedState(rawInput); }
  catch (error) {
    const code = migrationContractErrorCode(error) ?? "INVALID_MIGRATION_STATE";
    throw new E2eeManagedMigrationError(code === "BLOCK_CONFIRMATION_REQUIRED" ? code : "INVALID_MIGRATION_STATE");
  }
  try { return await runUserTransaction(userId, db, async (tx) => {
    if (input.action === "block") {
      const result = await tx.query(
        `UPDATE content_e2ee_migrations
            SET state='blocked', started_at=COALESCE(started_at, now()),
                completed_at=NULL, blocked_at=now(), blocked_reason='key_unavailable',
                last_error_code=NULL, updated_at=now()
          WHERE user_id=$1 AND state<>'complete'`,
        [userId],
      );
      if (result.rowCount !== 1) throw new E2eeManagedMigrationError("MIGRATION_STATE_CHANGED");
      return { state: "blocked" };
    }
    const result = await tx.query(
      `UPDATE content_e2ee_migrations
          SET state='pending', completed_at=NULL, blocked_at=NULL, blocked_reason=NULL,
              last_error_code=NULL, updated_at=now()
        WHERE user_id=$1 AND state='blocked'`,
      [userId],
    );
    if (result.rowCount !== 1) throw new E2eeManagedMigrationError("MIGRATION_STATE_CHANGED");
    return { state: "pending" };
  }); } catch (error) { throw safeServiceError(error); }
}

export function e2eeSourceDigest(row: Record<string, unknown>): string {
  try {
    validateSource(row);
    const hash = createHash("sha256");
    field(hash, "schema", "string", Buffer.from("e2ee-source-v1"));
    for (const [name, type, value] of [
      ["id", "decimal", decimal(row.id)], ["user_id", "uuid", text(row.user_id)],
      ["dedup_key", "string", text(row.dedup_key)],
      ["session_id", row.session_id == null ? "null" : "string", row.session_id == null ? "" : text(row.session_id)],
      ["provider_key", "string", text(row.provider_key)], ["turn_role", "role", text(row.turn_role)],
      ["ts", "timestamp", iso(row.ts)], ["encryption_scheme", "string", "e2ee_v1"],
      ["key_version", "integer", integer(row.key_version).toString()],
      ["content_owner_id", "uuid", text(row.content_owner_id)],
      ["content_key_version", "integer", integer(row.content_key_version).toString()],
      ["aad_version", "integer", "1"],
    ] as const) field(hash, name, type, Buffer.from(value, "utf8"));
    for (const [name, length, max] of [
      ["wrapped_dek", 32, 32], ["dek_wrap_iv", 12, 12], ["dek_wrap_auth_tag", 16, 16],
      ["iv", 12, 12], ["ciphertext", 1, MAX_CIPHERTEXT], ["auth_tag", 16, 16],
    ] as const) field(hash, name, "bytes", bytes(row[name], length, max));
    return hash.digest("base64url");
  } catch {
    throw new E2eeManagedMigrationError("E2EE_SOURCE_CORRUPT");
  }
}

async function replaceSource(
  tx: E2eeMigrationDb,
  source: Record<string, unknown>,
  item: E2eeManagedCommitItem,
  installationId: string,
  userId: string,
  keyVersion: number,
  key: Buffer,
): Promise<void> {
  const record = promptRecord(source, item.text, userId);
  try {
    const encrypted = encryptManagedContent(record, key, installationId, userId, keyVersion);
    const roundTrip = decryptManagedContent({ ...record, ...encrypted }, key, installationId, userId);
    assertPlaintextEqual(item.text, roundTrip);
    const update = await tx.query(
      `UPDATE prompt_records
          SET key_version=$3, wrapped_dek=$4, iv=$5, ciphertext=$6, auth_tag=$7,
              encryption_scheme='managed_v1', content_owner_id=NULL,
              content_key_version=$3, dek_wrap_iv=$8, dek_wrap_auth_tag=$9, aad_version=$10
        WHERE id=$1 AND user_id=$2 AND encryption_scheme='e2ee_v1'`,
      [item.id, userId, encrypted.contentKeyVersion, encrypted.wrappedDek, encrypted.iv,
        encrypted.ciphertext, encrypted.authTag, encrypted.dekWrapIv,
        encrypted.dekWrapAuthTag, encrypted.aadVersion],
    );
    if (update.rowCount !== 1) throw new E2eeManagedMigrationError("E2EE_SOURCE_CHANGED");
  } catch (error) {
    if (error instanceof E2eeManagedMigrationError) throw error;
    throw new E2eeManagedMigrationError("MANAGED_ROUND_TRIP_FAILED");
  }
}

function toMigrationSource(row: Record<string, unknown>, userId: string): E2eeManagedMigrationSource {
  validateSource(row, userId);
  return {
    id: decimal(row.id),
    sourceDigest: e2eeSourceDigest(row),
    record: {
      schema: "e2ee_v1", algorithm: "AES-256-GCM", aadVersion: 1,
      contentOwnerId: text(row.content_owner_id), contentKeyVersion: integer(row.content_key_version),
      dedupKey: text(row.dedup_key), sessionId: row.session_id == null ? null : text(row.session_id),
      providerKey: text(row.provider_key), turnRole: role(row.turn_role), ts: iso(row.ts),
      wrappedDek: bytes(row.wrapped_dek, 32, 32).toString("base64url"),
      dekWrapIv: bytes(row.dek_wrap_iv, 12, 12).toString("base64url"),
      dekWrapAuthTag: bytes(row.dek_wrap_auth_tag, 16, 16).toString("base64url"),
      iv: bytes(row.iv, 12, 12).toString("base64url"),
      ciphertext: bytes(row.ciphertext, 1, MAX_CIPHERTEXT).toString("base64url"),
      authTag: bytes(row.auth_tag, 16, 16).toString("base64url"),
    },
  };
}

function validateSource(row: Record<string, unknown>, expectedUserId?: string): void {
  if (row.encryption_scheme !== "e2ee_v1" || integer(row.key_version) !== integer(row.content_key_version)
    || integer(row.aad_version) !== 1 || !UUID.test(text(row.content_owner_id))
    || !UUID.test(text(row.user_id)) || (expectedUserId && row.user_id !== expectedUserId)) {
    throw new E2eeManagedMigrationError("E2EE_SOURCE_CORRUPT");
  }
  decimal(row.id); boundedString(row.dedup_key, 255); boundedString(row.provider_key, 100); role(row.turn_role); iso(row.ts);
  if (row.session_id != null) boundedString(row.session_id, 255);
  bytes(row.wrapped_dek, 32, 32); bytes(row.dek_wrap_iv, 12, 12); bytes(row.dek_wrap_auth_tag, 16, 16);
  bytes(row.iv, 12, 12); bytes(row.ciphertext, 1, MAX_CIPHERTEXT); bytes(row.auth_tag, 16, 16);
}

function promptRecord(row: Record<string, unknown>, plaintext: string, userId: string): PromptRecordWire {
  validateSource(row, userId);
  return { dedupKey: boundedString(row.dedup_key, 255), sessionId: row.session_id == null ? null : boundedString(row.session_id, 255),
    providerKey: boundedString(row.provider_key, 100), turnRole: role(row.turn_role), ts: new Date(iso(row.ts)), text: plaintext };
}

function assertDigest(row: Record<string, unknown>, supplied: string, userId: string): void {
  validateSource(row, userId);
  const actual = Buffer.from(e2eeSourceDigest(row), "base64url");
  const expected = Buffer.from(supplied, "base64url");
  try {
    if (actual.length !== 32 || expected.length !== 32 || !timingSafeEqual(actual, expected)) {
      throw new E2eeManagedMigrationError("E2EE_SOURCE_CHANGED");
    }
  } finally { actual.fill(0); expected.fill(0); }
}

function assertPlaintextEqual(left: string, right: string): void {
  const a = createHash("sha256").update(left, "utf8").digest();
  const b = createHash("sha256").update(right, "utf8").digest();
  try { if (!timingSafeEqual(a, b)) throw new E2eeManagedMigrationError("MANAGED_ROUND_TRIP_FAILED"); }
  finally { a.fill(0); b.fill(0); }
}

function field(hash: Hash, name: string, type: string, value: Buffer): void {
  for (const item of [Buffer.from(name), Buffer.from(type), value]) {
    const length = Buffer.alloc(4);
    try { length.writeUInt32BE(item.length); hash.update(length); hash.update(item); }
    finally { length.fill(0); if (item !== value) item.fill(0); }
  }
}

async function runUserTransaction<T>(userId: string, db: E2eeMigrationDb | undefined, fn: (tx: E2eeMigrationDb) => Promise<T>): Promise<T> {
  if (!db) return withUserContext(userId, (tx: PoolClient) => fn(tx));
  let began = false;
  try {
    await db.query("BEGIN"); began = true;
    await db.query("SELECT set_config('app.current_user_id', $1, true)", [userId]);
    const result = await fn(db); await db.query("COMMIT"); return result;
  } catch (error) {
    if (began) await db.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

function assertUserId(userId: string): void { if (!UUID.test(userId)) throw new E2eeManagedMigrationError("INVALID_USER_ID"); }
function assertManagedKey(key: Buffer, version: number): void {
  if (!Buffer.isBuffer(key) || key.length !== 32 || !Number.isSafeInteger(version) || version < 1 || version > MAX_VERSION) {
    throw new E2eeManagedMigrationError("MANAGED_KEY_INVALID");
  }
}
function decimal(value: unknown): string { const out = typeof value === "bigint" ? value.toString() : text(value); if (!/^[1-9][0-9]*$/.test(out) || BigInt(out) > 9_223_372_036_854_775_807n) throw new Error(); return out; }
function text(value: unknown): string { if (typeof value !== "string") throw new Error(); return value; }
function boundedString(value: unknown, max: number): string { const out = text(value); if (!out || out.length > max) throw new Error(); return out; }
function integer(value: unknown): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > MAX_VERSION) throw new Error(); return value; }
function bytes(value: unknown, min: number, max: number): Buffer { if (!Buffer.isBuffer(value) || value.length < min || value.length > max) throw new Error(); return value; }
function role(value: unknown): "user" | "assistant" { if (value !== "user" && value !== "assistant") throw new Error(); return value; }
function iso(value: unknown): string { if (typeof value !== "object" || value === null) throw new Error(); let milliseconds: number; try { milliseconds = Date.prototype.getTime.call(value); } catch { throw new Error(); } if (!Number.isFinite(milliseconds)) throw new Error(); return Date.prototype.toISOString.call(new Date(milliseconds)); }
function nullableIso(value: unknown): string | null { return value == null ? null : iso(value); }
function count(value: unknown): number {
  if (typeof value === "number") {
    if (Number.isSafeInteger(value) && value >= 0) return value;
  } else if (typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new E2eeManagedMigrationError("MIGRATION_STATE_CORRUPT");
}
function migrationState(value: unknown): "pending" | "running" | "blocked" | "complete" { if (value === "pending" || value === "running" || value === "blocked" || value === "complete") return value; throw new E2eeManagedMigrationError("MIGRATION_STATE_CORRUPT"); }
function safeServiceError(error: unknown): E2eeManagedMigrationError {
  return new E2eeManagedMigrationError(e2eeManagedMigrationErrorCode(error) ?? "MIGRATION_FAILED");
}
