import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { decryptContent, type EncryptedContent } from "./content-crypto";
import { E2EE_MAX_CIPHERTEXT_BYTES, fromBase64Url } from "./e2ee-contract";
import {
  LEGACY_MIGRATION_MAX_BATCH_SIZE,
  boundLegacyMigrationPage,
  parseLegacyMigrationCommit,
  type LegacyMigrationCommitItem,
  type LegacyMigrationSource,
} from "./e2ee-legacy-contract";
import { withUserContext } from "./rls";

type QueryResultLike = { rows: Record<string, unknown>[]; rowCount?: number | null };
export type LegacyMigrationDb = {
  query(sql: string, params?: unknown[]): Promise<QueryResultLike>;
};

export class LegacyMigrationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "LegacyMigrationError";
  }
}

export async function getLegacyMigrationStatus(
  userId: string,
  kekAvailable: boolean,
  db?: LegacyMigrationDb,
) {
  const result = await runInContext(userId, db, (tx) => tx.query(
    `SELECT account.content_owner_id, account.active_key_version,
            COUNT(record.id) FILTER (WHERE record.encryption_scheme='server_v1') AS legacy_records,
            COUNT(record.id) FILTER (
              WHERE record.encryption_scheme='server_v1'
                AND octet_length(record.ciphertext) <= $2
            ) AS migratable_records,
            COUNT(record.id) FILTER (WHERE record.encryption_scheme='e2ee_v1') AS e2ee_records
       FROM content_accounts account
       LEFT JOIN prompt_records record ON record.user_id=account.user_id
      WHERE account.user_id=$1 AND account.state='active'
      GROUP BY account.content_owner_id, account.active_key_version`,
    [userId, E2EE_MAX_CIPHERTEXT_BYTES],
  ));
  const row = result.rows[0];
  if (!row) throw new LegacyMigrationError("E2EE_ACCOUNT_NOT_ACTIVE");
  const legacyRecords = asCount(row.legacy_records);
  const migratableRecords = asCount(row.migratable_records);
  const blockedRecords = legacyRecords - migratableRecords;
  const e2eeRecords = asCount(row.e2ee_records);
  return {
    state: legacyRecords === 0
      ? "complete" as const
      : kekAvailable && migratableRecords > 0
        ? "pending" as const
        : "blocked" as const,
    contentOwnerId: asString(row.content_owner_id),
    contentKeyVersion: asPositiveInt(row.active_key_version),
    legacyRecords,
    migratableRecords,
    blockedRecords,
    e2eeRecords,
    totalRecords: legacyRecords + e2eeRecords,
  };
}

export async function getLegacyMigrationPage(
  userId: string,
  deviceId: string,
  kek: Buffer,
  limit = 25,
  db?: LegacyMigrationDb,
): Promise<{ records: LegacyMigrationSource[] }> {
  const bounded = Number.isSafeInteger(limit) ? Math.min(LEGACY_MIGRATION_MAX_BATCH_SIZE, Math.max(1, limit)) : 25;
  return runInContext(userId, db, async (tx) => {
    await assertApprovedBrowser(tx, userId, deviceId);
    const result = await tx.query(
      `SELECT id, dedup_key, session_id, provider_key, turn_role, ts,
              key_version, wrapped_dek, iv, ciphertext, auth_tag
         FROM prompt_records
        WHERE user_id=$1 AND encryption_scheme='server_v1'
          AND octet_length(ciphertext) <= $3
        ORDER BY id ASC
        LIMIT $2`,
      [userId, bounded, E2EE_MAX_CIPHERTEXT_BYTES],
    );
    return { records: boundLegacyMigrationPage(result.rows.map((row) => legacySource(row, kek))) };
  });
}

export async function commitLegacyMigrationBatch(
  userId: string,
  deviceId: string,
  rawItems: LegacyMigrationCommitItem[],
  kek: Buffer,
  db?: LegacyMigrationDb,
): Promise<{ migrated: number; alreadyMigrated: number }> {
  const items = parseLegacyMigrationCommit({ items: rawItems });
  return runInContext(userId, db, async (tx) => {
    const account = await assertApprovedBrowser(tx, userId, deviceId);
    let migrated = 0;
    let alreadyMigrated = 0;
    for (const item of items) {
      const result = await tx.query(
        `SELECT id, dedup_key, session_id, provider_key, turn_role, ts, encryption_scheme,
                key_version, wrapped_dek, iv, ciphertext, auth_tag
           FROM prompt_records
          WHERE id=$1 AND user_id=$2
          FOR UPDATE`,
        [item.id, userId],
      );
      const row = result.rows[0];
      if (!row) throw new LegacyMigrationError("LEGACY_SOURCE_NOT_FOUND");
      if (row.encryption_scheme === "e2ee_v1") {
        alreadyMigrated += 1;
        continue;
      }
      if (row.encryption_scheme !== "server_v1") throw new LegacyMigrationError("LEGACY_SOURCE_CHANGED");
      const text = decryptLegacy(row, kek);
      const digest = createHash("sha256").update(text, "utf8").digest("base64url");
      if (digest !== item.sourceDigest) throw new LegacyMigrationError("LEGACY_SOURCE_CHANGED");
      assertMetadata(row, item);
      if (
        item.record.contentOwnerId !== account.contentOwnerId
        || item.record.contentKeyVersion !== account.contentKeyVersion
      ) {
        throw new LegacyMigrationError("CONTENT_KEY_VERSION_MISMATCH");
      }
      const update = await tx.query(
        `UPDATE prompt_records
            SET key_version=$3, wrapped_dek=$4, iv=$5, ciphertext=$6, auth_tag=$7,
                encryption_scheme='e2ee_v1', content_owner_id=$8, content_key_version=$3,
                dek_wrap_iv=$9, dek_wrap_auth_tag=$10, aad_version=1
          WHERE id=$1 AND user_id=$2 AND encryption_scheme='server_v1'`,
        [
          item.id,
          userId,
          item.record.contentKeyVersion,
          fromBase64Url(item.record.wrappedDek, "wrappedDek"),
          fromBase64Url(item.record.iv, "iv"),
          fromBase64Url(item.record.ciphertext, "ciphertext"),
          fromBase64Url(item.record.authTag, "authTag"),
          item.record.contentOwnerId,
          fromBase64Url(item.record.dekWrapIv, "dekWrapIv"),
          fromBase64Url(item.record.dekWrapAuthTag, "dekWrapAuthTag"),
        ],
      );
      if (update.rowCount !== 1) throw new LegacyMigrationError("LEGACY_SOURCE_CHANGED");
      migrated += 1;
    }
    return { migrated, alreadyMigrated };
  });
}

async function assertApprovedBrowser(tx: LegacyMigrationDb, userId: string, deviceId: string) {
  const result = await tx.query(
    `SELECT account.content_owner_id, account.active_key_version
       FROM content_devices device
       JOIN content_accounts account ON account.user_id=device.user_id AND account.state='active'
      WHERE device.id=$1 AND device.user_id=$2 AND device.kind='browser'
        AND device.approved_at IS NOT NULL AND device.revoked_at IS NULL`,
    [deviceId, userId],
  );
  const row = result.rows[0];
  if (!row) throw new LegacyMigrationError("CONTENT_DEVICE_UNAPPROVED");
  return {
    contentOwnerId: asString(row.content_owner_id),
    contentKeyVersion: asPositiveInt(row.active_key_version),
  };
}

function legacySource(row: Record<string, unknown>, kek: Buffer): LegacyMigrationSource {
  const text = decryptLegacy(row, kek);
  const role = row.turn_role;
  if (role !== "user" && role !== "assistant") throw new LegacyMigrationError("LEGACY_SOURCE_CORRUPT");
  return {
    id: asString(row.id),
    dedupKey: asString(row.dedup_key),
    sessionId: row.session_id == null ? null : asString(row.session_id),
    providerKey: asString(row.provider_key),
    turnRole: role,
    ts: asDate(row.ts).toISOString(),
    text,
    sourceDigest: createHash("sha256").update(text, "utf8").digest("base64url"),
  };
}

function decryptLegacy(row: Record<string, unknown>, kek: Buffer): string {
  try {
    return decryptContent({
      keyVersion: asPositiveInt(row.key_version),
      wrappedDek: asBuffer(row.wrapped_dek),
      iv: asBuffer(row.iv),
      ciphertext: asBuffer(row.ciphertext),
      authTag: asBuffer(row.auth_tag),
    } satisfies EncryptedContent, kek);
  } catch {
    throw new LegacyMigrationError("LEGACY_SOURCE_CORRUPT");
  }
}

function assertMetadata(row: Record<string, unknown>, item: LegacyMigrationCommitItem): void {
  const sessionId = row.session_id == null ? null : asString(row.session_id);
  if (
    asString(row.dedup_key) !== item.record.dedupKey
    || sessionId !== item.record.sessionId
    || asString(row.provider_key) !== item.record.providerKey
    || row.turn_role !== item.record.turnRole
    || asDate(row.ts).toISOString() !== item.record.ts
  ) throw new LegacyMigrationError("LEGACY_SOURCE_CHANGED");
}

async function runInContext<T>(
  userId: string,
  db: LegacyMigrationDb | undefined,
  fn: (tx: LegacyMigrationDb) => Promise<T>,
): Promise<T> {
  if (!userId) throw new LegacyMigrationError("INVALID_USER_ID");
  if (db) return fn(db);
  return withUserContext(userId, (tx: PoolClient) => fn(tx));
}

function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "bigint") return value.toString();
  throw new LegacyMigrationError("LEGACY_SOURCE_CORRUPT");
}

function asPositiveInt(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new LegacyMigrationError("LEGACY_SOURCE_CORRUPT");
  return parsed;
}

function asCount(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new LegacyMigrationError("LEGACY_SOURCE_CORRUPT");
  return parsed;
}

function asDate(value: unknown): Date {
  const date = value instanceof Date ? value : new Date(asString(value));
  if (Number.isNaN(date.getTime())) throw new LegacyMigrationError("LEGACY_SOURCE_CORRUPT");
  return date;
}

function asBuffer(value: unknown): Buffer {
  if (!Buffer.isBuffer(value)) throw new LegacyMigrationError("LEGACY_SOURCE_CORRUPT");
  return value;
}
