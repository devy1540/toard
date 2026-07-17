import { timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";
import { decryptManagedContent } from "./managed-content-crypto";
import type { ManagedContentRuntime } from "./managed-content-runtime";
import type { ManagedUserKeyRow } from "./managed-user-keys";
import type { KeyContext, KeyProviderName, WrappedUserKey } from "./key-management/types";
import { withUserContext } from "./rls";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEY_BYTES = 32;
const PROVIDERS = new Set<KeyProviderName>([
  "local", "aws-kms", "gcp-kms", "azure-key-vault", "vault-transit", "openbao-transit",
]);

type QueryResultLike = { rows: Record<string, unknown>[]; rowCount?: number | null };
type ActiveWrapperSnapshot = ManagedUserKeyRow & { id: string; contextVersion: number };

/** db 주입 시 각 BEGIN/COMMIT 구간 동안 동일한 PostgreSQL session이어야 한다. */
export type RewrapDb = { query(sql: string, params?: unknown[]): Promise<QueryResultLike> };

const rewrapErrors = new WeakSet<object>();

export class RewrapError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "RewrapError";
    rewrapErrors.add(this);
  }
}

export function rewrapErrorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && rewrapErrors.has(error)
    ? (error as RewrapError).code
    : null;
}

export async function rewrapUserKey(
  userId: string,
  runtime: ManagedContentRuntime,
  db?: RewrapDb,
): Promise<{ state: "already-current" | "migrated" }> {
  assertUserId(userId);
  const target = runtime.registry.migration;
  if (!target) throw new RewrapError("MIGRATION_PROVIDER_MISSING");

  let uck: Buffer | undefined;
  let wrapInput: Buffer | undefined;
  let verified: Buffer | undefined;
  let oldWrappedInput: WrappedUserKey | undefined;
  let verificationWrapped: WrappedUserKey | undefined;
  let providerPendingCiphertext: Buffer | undefined;
  try {
    const active = await runUserTransaction(userId, db, (tx) => loadActiveWrapper(userId, tx));
    if (active.providerFingerprint === target.fingerprint) return { state: "already-current" };
    if (typeof runtime.userKeys.evict !== "function") {
      throw new RewrapError("CACHE_EVICTION_UNAVAILABLE");
    }
    const evictOldCacheKey = runtime.userKeys.evict.bind(runtime.userKeys);

    const wrappedActive = toWrapped(active);
    const oldProvider = runtime.registry.resolveWrappedKey(wrappedActive);
    const context = keyContext(runtime.installationId, active);
    oldWrappedInput = cloneWrapped(wrappedActive);
    uck = await oldProvider.unwrapKey(oldWrappedInput, context);
    assertKey(uck, "ACTIVE_WRAPPER_INVALID");

    wrapInput = Buffer.from(uck);
    const providerPending = await target.wrapKey(wrapInput, context);
    providerPendingCiphertext = Buffer.isBuffer(providerPending.ciphertext)
      ? providerPending.ciphertext
      : undefined;
    const pending = validatePending(providerPending, target);
    verificationWrapped = cloneWrapped(pending);
    verified = await target.unwrapKey(verificationWrapped, context);
    assertKey(verified, "PENDING_WRAPPER_INVALID");
    if (!timingSafeEqual(uck, verified)) {
      throw new RewrapError("PENDING_WRAPPER_MISMATCH");
    }

    await runUserTransaction(userId, db, async (tx) => {
      await verifyManagedCanary(userId, active.keyVersion, uck!, runtime.installationId, tx);
    });
    await runUserTransaction(userId, db, (tx) => promotePendingWrapper(userId, active, pending, tx));
    evictOldCacheKey(userId, active.keyVersion, active.providerFingerprint);
    return { state: "migrated" };
  } catch (error) {
    if (rewrapErrorCode(error)) throw error;
    throw new RewrapError("REWRAP_FAILED");
  } finally {
    zeroDistinct([verified, wrapInput, uck]);
    zeroDistinct([
      verificationWrapped?.ciphertext,
      oldWrappedInput?.ciphertext,
      providerPendingCiphertext,
    ]);
  }
}

export async function getProviderRewrapUsers(
  provider: KeyProviderName,
  fingerprint: string,
  db: RewrapDb,
): Promise<string[]> {
  if (!PROVIDERS.has(provider) || !fingerprint) throw new RewrapError("INVALID_PROVIDER_FILTER");
  try {
    const result = await db.query(
      `SELECT user_id
         FROM managed_content_keys
        WHERE state='active' AND provider=$1 AND provider_fingerprint=$2
        ORDER BY user_id ASC`,
      [provider, fingerprint],
    );
    return result.rows.map((row) => {
      const userId = requiredString(row.user_id);
      assertUserId(userId);
      return userId;
    });
  } catch (error) {
    if (rewrapErrorCode(error)) throw error;
    throw new RewrapError("REWRAP_USER_ENUMERATION_FAILED");
  }
}

async function loadActiveWrapper(userId: string, db: RewrapDb): Promise<ActiveWrapperSnapshot> {
  const result = await db.query(
    `SELECT id::text,
            user_id AS "userId", key_version AS "keyVersion", provider,
            provider_key_ref AS "providerKeyRef", provider_fingerprint AS "providerFingerprint",
            wrapped_user_key AS "wrappedUserKey", wrapper_metadata AS "wrapperMetadata",
            context_version AS "contextVersion", state
       FROM managed_content_keys
      WHERE user_id=$1 AND state='active'
      LIMIT 1`,
    [userId],
  );
  if (!result.rows[0]) throw new RewrapError("ACTIVE_WRAPPER_MISSING");
  return parseWrapper(result.rows[0], userId);
}

async function verifyManagedCanary(
  userId: string,
  keyVersion: number,
  uck: Buffer,
  installationId: string,
  db: RewrapDb,
): Promise<void> {
  const result = await db.query(
    `SELECT dedup_key AS "dedupKey", provider_key AS "providerKey", turn_role AS "turnRole", ts,
            encryption_scheme AS "encryptionScheme", content_key_version AS "contentKeyVersion",
            aad_version AS "aadVersion", wrapped_dek AS "wrappedDek",
            dek_wrap_iv AS "dekWrapIv", dek_wrap_auth_tag AS "dekWrapAuthTag",
            iv, ciphertext, auth_tag AS "authTag"
       FROM prompt_records
      WHERE user_id=$1 AND encryption_scheme='managed_v1' AND content_key_version=$2
      ORDER BY id ASC LIMIT 1`,
    [userId, keyVersion],
  );
  const row = result.rows[0];
  if (!row) throw new RewrapError("MANAGED_CANARY_MISSING");
  try {
    decryptManagedContent({
      dedupKey: requiredString(row.dedupKey),
      providerKey: requiredString(row.providerKey),
      turnRole: requiredRole(row.turnRole),
      ts: requiredDate(row.ts),
      encryptionScheme: row.encryptionScheme === "managed_v1" ? "managed_v1" : fail("MANAGED_CANARY_INVALID"),
      contentKeyVersion: requiredPositiveInteger(row.contentKeyVersion),
      aadVersion: row.aadVersion === 2 ? 2 : fail("MANAGED_CANARY_INVALID"),
      wrappedDek: requiredBuffer(row.wrappedDek),
      dekWrapIv: requiredBuffer(row.dekWrapIv),
      dekWrapAuthTag: requiredBuffer(row.dekWrapAuthTag),
      iv: requiredBuffer(row.iv),
      ciphertext: requiredBuffer(row.ciphertext),
      authTag: requiredBuffer(row.authTag),
    }, uck, installationId, userId);
  } catch {
    throw new RewrapError("MANAGED_CANARY_INVALID");
  }
}

async function promotePendingWrapper(
  userId: string,
  snapshot: ActiveWrapperSnapshot,
  pending: WrappedUserKey,
  db: RewrapDb,
): Promise<void> {
  const lockedResult = await db.query(
    `SELECT id::text,
            user_id AS "userId", key_version AS "keyVersion", provider,
            provider_key_ref AS "providerKeyRef", provider_fingerprint AS "providerFingerprint",
            wrapped_user_key AS "wrappedUserKey", wrapper_metadata AS "wrapperMetadata",
            context_version AS "contextVersion", state
       FROM managed_content_keys
      WHERE user_id=$1 AND state='active'
      LIMIT 1 FOR UPDATE`,
    [userId],
  );
  const locked = lockedResult.rows[0] ? parseWrapper(lockedResult.rows[0], userId) : null;
  if (!locked || !sameWrapper(snapshot, locked)) throw new RewrapError("ACTIVE_WRAPPER_CHANGED");

  const inserted = await db.query(
    `INSERT INTO managed_content_keys
       (user_id,key_version,provider,provider_key_ref,provider_fingerprint,
        wrapped_user_key,wrapper_metadata,context_version,state,verified_at)
     VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,1,'pending',now())
     ON CONFLICT (user_id,key_version,provider_fingerprint) DO UPDATE
       SET provider=EXCLUDED.provider,
           provider_key_ref=EXCLUDED.provider_key_ref,
           wrapped_user_key=EXCLUDED.wrapped_user_key,
           wrapper_metadata=EXCLUDED.wrapper_metadata,
           verified_at=EXCLUDED.verified_at,
           retired_at=NULL,
           state='pending'
       WHERE managed_content_keys.state IN ('pending','retiring')`,
    [userId, snapshot.keyVersion, pending.provider, pending.keyRef, pending.fingerprint,
      pending.ciphertext, JSON.stringify(pending.metadata)],
  );
  if (inserted.rowCount !== 1) throw new RewrapError("PENDING_WRAPPER_CONFLICT");
  const retired = await db.query(
    `UPDATE managed_content_keys
        SET state='retiring', retired_at=now()
      WHERE id=$1 AND user_id=$2 AND state='active'`,
    [snapshot.id, userId],
  );
  if (retired.rowCount !== 1) throw new RewrapError("ACTIVE_WRAPPER_CHANGED");
  const activated = await db.query(
    `UPDATE managed_content_keys
        SET state='active'
      WHERE user_id=$1 AND key_version=$2 AND provider_fingerprint=$3 AND state='pending'`,
    [userId, snapshot.keyVersion, pending.fingerprint],
  );
  if (activated.rowCount !== 1) throw new RewrapError("PENDING_WRAPPER_CONFLICT");
}

async function runUserTransaction<T>(
  userId: string,
  db: RewrapDb | undefined,
  fn: (tx: RewrapDb) => Promise<T>,
): Promise<T> {
  if (!db) return withUserContext(userId, (tx: PoolClient) => fn(tx));
  let began = false;
  try {
    await db.query("BEGIN");
    began = true;
    await db.query("SELECT set_config('app.current_user_id', $1, true)", [userId]);
    const value = await fn(db);
    await db.query("COMMIT");
    return value;
  } catch (error) {
    if (began) await db.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

function parseWrapper(row: Record<string, unknown>, expectedUserId: string): ActiveWrapperSnapshot {
  const userId = requiredString(row.userId);
  const state = row.state;
  const provider = row.provider;
  if (userId !== expectedUserId || state !== "active" || typeof provider !== "string" || !PROVIDERS.has(provider as KeyProviderName)) {
    throw new RewrapError("ACTIVE_WRAPPER_INVALID");
  }
  return {
    id: requiredString(row.id), userId, keyVersion: requiredPositiveInteger(row.keyVersion),
    provider: provider as KeyProviderName, providerKeyRef: requiredString(row.providerKeyRef),
    providerFingerprint: requiredString(row.providerFingerprint), wrappedUserKey: requiredBuffer(row.wrappedUserKey),
    wrapperMetadata: requiredStringRecord(row.wrapperMetadata),
    contextVersion: requiredPositiveInteger(row.contextVersion), state: "active",
  };
}

function sameWrapper(left: ActiveWrapperSnapshot, right: ActiveWrapperSnapshot): boolean {
  return left.id === right.id && left.userId === right.userId && left.keyVersion === right.keyVersion
    && left.contextVersion === right.contextVersion
    && left.provider === right.provider && left.providerKeyRef === right.providerKeyRef
    && left.providerFingerprint === right.providerFingerprint
    && buffersEqual(left.wrappedUserKey, right.wrappedUserKey)
    && JSON.stringify(sortedRecord(left.wrapperMetadata)) === JSON.stringify(sortedRecord(right.wrapperMetadata));
}

function buffersEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function validatePending(wrapped: WrappedUserKey, target: ManagedContentRuntime["registry"]["active"]): WrappedUserKey {
  if (wrapped.provider !== target.name || wrapped.keyRef !== target.keyRef || wrapped.fingerprint !== target.fingerprint) {
    throw new RewrapError("PENDING_WRAPPER_INVALID");
  }
  return {
    ...wrapped,
    ciphertext: Buffer.from(requiredBuffer(wrapped.ciphertext)),
    metadata: { ...requiredStringRecord(wrapped.metadata) },
  };
}

function cloneWrapped(wrapped: WrappedUserKey): WrappedUserKey {
  return { ...wrapped, ciphertext: Buffer.from(wrapped.ciphertext), metadata: { ...wrapped.metadata } };
}

function toWrapped(row: ManagedUserKeyRow): WrappedUserKey {
  return { provider: row.provider, keyRef: row.providerKeyRef, fingerprint: row.providerFingerprint,
    ciphertext: row.wrappedUserKey, metadata: row.wrapperMetadata };
}

function keyContext(installationId: string, row: ManagedUserKeyRow): KeyContext {
  return { installationId, userId: row.userId, keyVersion: row.keyVersion, purpose: "prompt-history" };
}

function assertUserId(userId: string): void {
  if (!UUID.test(userId)) throw new RewrapError("INVALID_USER_ID");
}
function assertKey(value: unknown, code: string): asserts value is Buffer {
  if (!Buffer.isBuffer(value) || value.length !== KEY_BYTES) {
    if (Buffer.isBuffer(value)) value.fill(0);
    throw new RewrapError(code);
  }
}
function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new RewrapError("REWRAP_ROW_INVALID");
  return value;
}
function requiredPositiveInteger(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 32_767) throw new RewrapError("REWRAP_ROW_INVALID");
  return parsed;
}
function requiredBuffer(value: unknown): Buffer {
  if (!Buffer.isBuffer(value) || value.length === 0) throw new RewrapError("REWRAP_ROW_INVALID");
  return value;
}
function requiredStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RewrapError("REWRAP_ROW_INVALID");
  const entries = Object.entries(value);
  if (entries.some(([, item]) => typeof item !== "string")) throw new RewrapError("REWRAP_ROW_INVALID");
  return Object.fromEntries(entries) as Record<string, string>;
}
function requiredRole(value: unknown): "user" | "assistant" {
  if (value !== "user" && value !== "assistant") throw new RewrapError("REWRAP_ROW_INVALID");
  return value;
}
function requiredDate(value: unknown): Date {
  const date = value instanceof Date ? new Date(Date.prototype.getTime.call(value)) : new Date(requiredString(value));
  if (!Number.isFinite(date.getTime())) throw new RewrapError("REWRAP_ROW_INVALID");
  return date;
}
function sortedRecord(value: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}
function zeroDistinct(values: Array<Buffer | undefined>): void {
  const seen = new Set<Buffer>();
  for (const value of values) if (value && !seen.has(value)) { seen.add(value); value.fill(0); }
}
function fail(code: string): never { throw new RewrapError(code); }
