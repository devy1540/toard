import { createHash, timingSafeEqual, type Hash } from "node:crypto";
import type { PoolClient } from "pg";
import { decryptContent, type EncryptedContent } from "./legacy-content-crypto";
import {
  decryptManagedContent,
  encryptManagedContent,
  type ManagedEncryptedContent,
} from "./managed-content-crypto";
import type { ManagedContentRuntime } from "./managed-content-runtime";
import type { PromptRecordWire } from "./prompt-wire";
import { withUserContext } from "./rls";

const MAX_BATCH_SIZE = 25;
const LEGACY_KEY_VERSION = 1;
const LEGACY_KEK_BYTES = 32;
const LEGACY_WRAPPED_DEK_BYTES = 60;
const DEK_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type QueryResultLike = {
  rows: Record<string, unknown>[];
  rowCount?: number | null;
};

/** `db` 주입 시 BEGIN부터 COMMIT까지 같은 PostgreSQL session에 고정돼야 한다. */
export type ServerMigrationDb = {
  query(sql: string, params?: unknown[]): Promise<QueryResultLike>;
};

export class ServerContentMigrationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ServerContentMigrationError";
  }
}

export async function migrateServerContentBatch(
  userId: string,
  limit: number,
  runtime: ManagedContentRuntime,
  legacyKek: Buffer,
  db?: ServerMigrationDb,
): Promise<{ migrated: number; remaining: number }> {
  assertUserId(userId);
  const bounded = boundedLimit(limit);
  if (!Buffer.isBuffer(legacyKek) || legacyKek.length !== LEGACY_KEK_BYTES) {
    throw new ServerContentMigrationError("INVALID_LEGACY_KEK");
  }

  const legacyKekCopy = Buffer.from(legacyKek);
  try {
    return await runtime.userKeys.withActiveUserKey(userId, async (uck, keyVersion) => {
      if (
        !Buffer.isBuffer(uck)
        || uck.length !== DEK_BYTES
        || !Number.isSafeInteger(keyVersion)
        || keyVersion < 1
        || keyVersion > 32_767
      ) {
        throw new ServerContentMigrationError("MANAGED_USER_KEY_INVALID");
      }
      const uckCopy = Buffer.from(uck);
      try {
        return await runUserTransaction(userId, db, async (tx) => {
          const source = await tx.query(
            `SELECT id,user_id,dedup_key,session_id,provider_key,turn_role,ts,key_version,
                    wrapped_dek,iv,ciphertext,auth_tag
               FROM prompt_records
              WHERE user_id=$1 AND encryption_scheme='server_v1'
              ORDER BY id ASC
              LIMIT $2
              FOR UPDATE SKIP LOCKED`,
            [userId, bounded],
          );

          for (const sourceRow of source.rows) {
            await migrateRow(
              tx,
              sourceRow,
              userId,
              runtime.installationId,
              keyVersion,
              legacyKekCopy,
              uckCopy,
            );
          }

          const remainingResult = await tx.query(
            `SELECT COUNT(*)::int AS count
               FROM prompt_records
              WHERE user_id=$1 AND encryption_scheme='server_v1'`,
            [userId],
          );
          const remaining = nonNegativeCount(remainingResult.rows[0]?.count);
          return { migrated: source.rows.length, remaining };
        });
      } finally {
        uckCopy.fill(0);
      }
    });
  } catch (error) {
    if (error instanceof ServerContentMigrationError) throw error;
    throw new ServerContentMigrationError("SERVER_CONTENT_MIGRATION_FAILED");
  } finally {
    legacyKekCopy.fill(0);
  }
}

/**
 * RLS 대상이 아닌 users.id만 전역 열거하고, server_v1 존재 여부는 같은 고정
 * client의 사용자별 transaction에서 app.current_user_id를 설정한 뒤 확인한다.
 */
export async function getServerContentMigrationUsers(
  db: ServerMigrationDb,
): Promise<string[]> {
  try {
    const result = await db.query("SELECT id::text AS id FROM users ORDER BY id ASC");
    const userIds = [...new Set(result.rows.map((row) => {
      if (typeof row.id !== "string") throw new ServerContentMigrationError("INVALID_USER_ID");
      assertUserId(row.id);
      return row.id;
    }))].sort();
    const eligible: string[] = [];
    for (const userId of userIds) {
      const hasServerRows = await runUserTransaction(userId, db, async (tx) => {
        const check = await tx.query(
          `SELECT EXISTS(
             SELECT 1 FROM prompt_records
              WHERE user_id=$1 AND encryption_scheme='server_v1'
           ) AS eligible`,
          [userId],
        );
        if (typeof check.rows[0]?.eligible !== "boolean") {
          throw new ServerContentMigrationError("SERVER_CONTENT_USER_ENUMERATION_FAILED");
        }
        return check.rows[0].eligible;
      });
      if (hasServerRows) eligible.push(userId);
    }
    return eligible;
  } catch (error) {
    if (error instanceof ServerContentMigrationError) throw error;
    throw new ServerContentMigrationError("SERVER_CONTENT_USER_ENUMERATION_FAILED");
  }
}

async function migrateRow(
  tx: ServerMigrationDb,
  sourceRow: Record<string, unknown>,
  userId: string,
  installationId: string,
  keyVersion: number,
  legacyKek: Buffer,
  uck: Buffer,
): Promise<void> {
  const id = positiveBigintString(sourceRow.id);
  if (sourceRow.user_id !== userId) {
    throw new ServerContentMigrationError("LEGACY_SOURCE_CORRUPT");
  }
  const record = legacyPromptRecord(sourceRow, legacyKek);
  try {
    const encrypted = encryptManagedContent(record, uck, installationId, userId, keyVersion);
    const roundTripText = decryptManagedContent(
      { ...record, ...encrypted },
      uck,
      installationId,
      userId,
    );
    assertServerSourceRoundTrip(record, roundTripText);
    await updateSameRow(tx, id, userId, encrypted);
  } catch (error) {
    if (error instanceof ServerContentMigrationError) throw error;
    throw new ServerContentMigrationError("MANAGED_ROUND_TRIP_FAILED");
  }
}

async function updateSameRow(
  tx: ServerMigrationDb,
  id: string,
  userId: string,
  encrypted: ManagedEncryptedContent,
): Promise<void> {
  const update = await tx.query(
    `UPDATE prompt_records
        SET key_version=$3, wrapped_dek=$4, iv=$5, ciphertext=$6, auth_tag=$7,
            encryption_scheme='managed_v1', content_owner_id=NULL,
            content_key_version=$3, dek_wrap_iv=$8, dek_wrap_auth_tag=$9, aad_version=$10
      WHERE id=$1 AND user_id=$2 AND encryption_scheme='server_v1'`,
    [
      id,
      userId,
      encrypted.contentKeyVersion,
      encrypted.wrappedDek,
      encrypted.iv,
      encrypted.ciphertext,
      encrypted.authTag,
      encrypted.dekWrapIv,
      encrypted.dekWrapAuthTag,
      encrypted.aadVersion,
    ],
  );
  if (update.rowCount !== 1) {
    throw new ServerContentMigrationError("SOURCE_CHANGED");
  }
}

function legacyPromptRecord(
  row: Record<string, unknown>,
  legacyKek: Buffer,
): PromptRecordWire {
  try {
    const encrypted: EncryptedContent = {
      keyVersion: exactInteger(row.key_version, LEGACY_KEY_VERSION),
      wrappedDek: exactBuffer(row.wrapped_dek, LEGACY_WRAPPED_DEK_BYTES),
      iv: exactBuffer(row.iv, IV_BYTES),
      ciphertext: nonEmptyBuffer(row.ciphertext),
      authTag: exactBuffer(row.auth_tag, TAG_BYTES),
    };
    const turnRole = row.turn_role;
    if (turnRole !== "user" && turnRole !== "assistant") {
      throw new Error("INVALID_ROLE");
    }
    return {
      dedupKey: nonEmptyString(row.dedup_key),
      sessionId: row.session_id == null ? null : stringValue(row.session_id),
      providerKey: nonEmptyString(row.provider_key),
      turnRole,
      ts: validDate(row.ts),
      text: decryptContent(encrypted, legacyKek),
    };
  } catch {
    throw new ServerContentMigrationError("LEGACY_SOURCE_CORRUPT");
  }
}

export function serverSourceDigest(record: PromptRecordWire): Buffer {
  const hash = createHash("sha256");
  canonicalField(hash, "schema", "string", "server-source-v1");
  canonicalField(hash, "dedupKey", "string", record.dedupKey);
  canonicalField(
    hash,
    "sessionId",
    record.sessionId === null ? "null" : "string",
    record.sessionId ?? "",
  );
  canonicalField(hash, "providerKey", "string", record.providerKey);
  canonicalField(hash, "turnRole", "string", record.turnRole);
  canonicalField(hash, "ts", "string", intrinsicIso(record.ts));
  canonicalField(hash, "text", "string", record.text);
  return hash.digest();
}

export function assertServerSourceRoundTrip(
  source: PromptRecordWire,
  roundTripText: string,
): void {
  const sourceDigest = serverSourceDigest(source);
  const destinationDigest = serverSourceDigest({ ...source, text: roundTripText });
  try {
    if (
      sourceDigest.length !== destinationDigest.length
      || !timingSafeEqual(sourceDigest, destinationDigest)
    ) {
      throw new ServerContentMigrationError("MANAGED_ROUND_TRIP_FAILED");
    }
  } finally {
    sourceDigest.fill(0);
    destinationDigest.fill(0);
  }
}

function canonicalField(
  hash: Hash,
  name: string,
  type: "string" | "null",
  value: string,
): void {
  for (const part of [name, type, value]) {
    const bytes = Buffer.from(part, "utf8");
    const length = Buffer.allocUnsafe(4);
    try {
      length.writeUInt32BE(bytes.length);
      hash.update(length);
      hash.update(bytes);
    } finally {
      length.fill(0);
      bytes.fill(0);
    }
  }
}

async function runUserTransaction<T>(
  userId: string,
  db: ServerMigrationDb | undefined,
  fn: (tx: ServerMigrationDb) => Promise<T>,
): Promise<T> {
  if (!db) {
    return withUserContext(userId, (tx: PoolClient) => fn(tx));
  }

  let began = false;
  try {
    await db.query("BEGIN");
    began = true;
    await db.query("SELECT set_config('app.current_user_id', $1, true)", [userId]);
    const value = await fn(db);
    await db.query("COMMIT");
    return value;
  } catch (error) {
    if (began) {
      await db.query("ROLLBACK").catch(() => undefined);
    }
    throw error;
  }
}

function assertUserId(userId: string): void {
  if (!UUID.test(userId)) {
    throw new ServerContentMigrationError("INVALID_USER_ID");
  }
}

function boundedLimit(limit: number): number {
  if (!Number.isSafeInteger(limit)) {
    throw new ServerContentMigrationError("INVALID_LIMIT");
  }
  return Math.min(MAX_BATCH_SIZE, Math.max(1, limit));
}

function exactInteger(value: unknown, expected: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed !== expected) throw new Error("INVALID_INTEGER");
  return parsed;
}

function nonNegativeCount(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ServerContentMigrationError("LEGACY_SOURCE_CORRUPT");
  }
  return parsed;
}

function exactBuffer(value: unknown, length: number): Buffer {
  if (!Buffer.isBuffer(value) || value.length !== length) throw new Error("INVALID_BUFFER");
  return value;
}

function nonEmptyBuffer(value: unknown): Buffer {
  if (!Buffer.isBuffer(value) || value.length === 0) throw new Error("INVALID_BUFFER");
  return value;
}

function stringValue(value: unknown): string {
  if (typeof value !== "string") throw new Error("INVALID_STRING");
  return value;
}

function nonEmptyString(value: unknown): string {
  const parsed = stringValue(value);
  if (parsed.length === 0) throw new Error("INVALID_STRING");
  return parsed;
}

function positiveBigintString(value: unknown): string {
  const parsed = typeof value === "bigint" ? value.toString() : stringValue(value);
  if (!/^[1-9][0-9]*$/.test(parsed)) {
    throw new ServerContentMigrationError("LEGACY_SOURCE_CORRUPT");
  }
  return parsed;
}

function validDate(value: unknown): Date {
  const date = value instanceof Date ? new Date(Date.prototype.getTime.call(value)) : new Date(stringValue(value));
  if (!Number.isFinite(Date.prototype.getTime.call(date))) throw new Error("INVALID_DATE");
  return date;
}

function intrinsicIso(value: Date): string {
  try {
    return Date.prototype.toISOString.call(value);
  } catch {
    throw new ServerContentMigrationError("LEGACY_SOURCE_CORRUPT");
  }
}
