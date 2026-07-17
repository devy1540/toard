import { randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { KeyProviderRegistry } from "./key-management/registry";
import type {
  KeyContext,
  KeyProviderName,
  WrappedUserKey,
} from "./key-management/types";
import { UserKeyCache } from "./key-management/user-key-cache";
import {
  recordKeySecurityEvent,
  type KeySecurityEvent,
} from "./key-management/observability";
import { withUserContext } from "./rls";

const USER_KEY_LENGTH = 32;
const FIRST_KEY_VERSION = 1;

type QueryResultLike = {
  rows: Record<string, unknown>[];
  rowCount?: number | null;
};

export type ManagedUserKeyDatabase = {
  query(sql: string, params?: unknown[]): Promise<QueryResultLike>;
};

export type ManagedUserKeyState = "active" | "pending" | "retiring";

export type ManagedUserKeyRow = {
  userId: string;
  keyVersion: number;
  provider: KeyProviderName;
  providerKeyRef: string;
  providerFingerprint: string;
  wrappedUserKey: Buffer;
  wrapperMetadata: Record<string, string>;
  state: ManagedUserKeyState;
};

type RunInUserContext = <T>(
  userId: string,
  fn: (db: ManagedUserKeyDatabase) => Promise<T>,
) => Promise<T>;

type ManagedUserKeyServiceOptions = {
  installationId: string;
  registry: KeyProviderRegistry;
  cache: UserKeyCache;
  runInUserContext?: RunInUserContext;
  randomBytes?: (size: number) => Buffer;
  recordSecurityEvent?: (
    event: KeySecurityEvent,
    db: ManagedUserKeyDatabase,
  ) => Promise<void>;
};

const PROVIDER_NAMES = new Set<KeyProviderName>([
  "local",
  "aws-kms",
  "gcp-kms",
  "azure-key-vault",
  "vault-transit",
  "openbao-transit",
]);

const defaultRunInUserContext: RunInUserContext = (userId, fn) =>
  withUserContext(userId, (tx: PoolClient) => fn(tx));

export class ManagedUserKeyService {
  private readonly installationId: string;
  private readonly registry: KeyProviderRegistry;
  private readonly cache: UserKeyCache;
  private readonly runInUserContext: RunInUserContext;
  private readonly generateRandomBytes: (size: number) => Buffer;
  private readonly recordSecurityEvent: NonNullable<ManagedUserKeyServiceOptions["recordSecurityEvent"]>;

  constructor(options: ManagedUserKeyServiceOptions) {
    this.installationId = options.installationId;
    this.registry = options.registry;
    this.cache = options.cache;
    this.runInUserContext = options.runInUserContext ?? defaultRunInUserContext;
    this.generateRandomBytes = options.randomBytes ?? randomBytes;
    this.recordSecurityEvent = options.recordSecurityEvent ?? recordKeySecurityEvent;
  }

  async withActiveUserKey<T>(
    userId: string,
    fn: (key: Buffer, version: number) => Promise<T> | T,
  ): Promise<T> {
    const row = await this.loadOrCreateActive(userId);
    return this.withRowKey(userId, row, (key) => fn(key, row.keyVersion));
  }

  async withUserKeyVersion<T>(
    userId: string,
    keyVersion: number,
    fn: (key: Buffer) => Promise<T> | T,
  ): Promise<T> {
    const row = await this.loadVersion(userId, keyVersion);
    return this.withRowKey(userId, row, fn);
  }

  /** provider rewrap 성공 뒤 정확한 이전 wrapper cache 항목만 제거한다. */
  evict(userId: string, keyVersion: number, providerFingerprint: string): void {
    this.cache.evict([
      this.installationId,
      userId,
      keyVersion,
      providerFingerprint,
    ].join(":"));
  }

  private async withRowKey<T>(
    userId: string,
    row: ManagedUserKeyRow,
    fn: (key: Buffer) => Promise<T> | T,
  ): Promise<T> {
    const context = this.keyContext(userId, row.keyVersion);
    const wrapped = toWrappedUserKey(row);
    const provider = this.registry.resolveWrappedKey(wrapped);
    const providerName = provider.name;
    const providerFingerprint = provider.fingerprint;
    const cacheKey = [
      this.installationId,
      userId,
      row.keyVersion,
      providerFingerprint,
    ].join(":");
    return this.cache.withKey(
      cacheKey,
      async () => provider.unwrapKey(wrapped, context),
      fn,
      {
        provider: providerName,
        fingerprint: providerFingerprint,
        operation: "unwrap",
      },
    );
  }

  private async loadOrCreateActive(userId: string): Promise<ManagedUserKeyRow> {
    return this.runInUserContext(userId, async (db) => {
      // start audit와 신규 wrapper insert는 같은 distribution lock으로 직렬화한다.
      // active 조회를 lock 밖에서 하면 start와 insert 사이에 old wrapper가 생길 수 있다.
      await db.query("SELECT lock_managed_content_key_distribution()");
      const fence = await latestMigrationTarget(db);
      const current = await selectActiveUserKey(db, userId);
      if (current) return current;

      const generated = this.generateRandomBytes(USER_KEY_LENGTH);
      try {
        if (!Buffer.isBuffer(generated) || generated.length !== USER_KEY_LENGTH) {
          throw new Error("USER_KEY_LENGTH_INVALID");
        }
        const context = this.keyContext(userId, FIRST_KEY_VERSION);
        const provider = fence
          ? this.registry.resolveIdentity(fence.provider, fence.providerFingerprint)
          : this.registry.active;
        if (!provider) throw new Error("MANAGED_USER_KEY_MIGRATION_TARGET_MISSING");
        const wrapped = await provider.wrapKey(generated, context);
        const row = rowFromWrapped(userId, FIRST_KEY_VERSION, wrapped);
        const inserted = await db.query(
          `INSERT INTO managed_content_keys
             (user_id, key_version, provider, provider_key_ref, provider_fingerprint,
              wrapped_user_key, wrapper_metadata, context_version, state)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 1, 'active')
           ON CONFLICT DO NOTHING`,
          [
            userId,
            row.keyVersion,
            row.provider,
            row.providerKeyRef,
            row.providerFingerprint,
            row.wrappedUserKey,
            JSON.stringify(row.wrapperMetadata),
          ],
        );
        if (inserted.rowCount === 1) {
          await this.recordSecurityEvent({
            eventType: "user_key_created",
            userId,
            provider: row.provider,
            providerFingerprint: row.providerFingerprint,
            keyVersion: row.keyVersion,
            actorUserId: null,
            appInstanceId: this.installationId,
          }, db);
          return row;
        }

        const winner = await selectActiveUserKey(db, userId);
        if (!winner) throw new Error("MANAGED_USER_KEY_CREATE_RACE_LOST");
        return winner;
      } finally {
        if (Buffer.isBuffer(generated)) generated.fill(0);
      }
    });
  }

  private async loadVersion(
    userId: string,
    keyVersion: number,
  ): Promise<ManagedUserKeyRow> {
    return this.runInUserContext(userId, async (db) => {
      const result = await db.query(
        `SELECT user_id AS "userId",
                key_version AS "keyVersion",
                provider,
                provider_key_ref AS "providerKeyRef",
                provider_fingerprint AS "providerFingerprint",
                wrapped_user_key AS "wrappedUserKey",
                wrapper_metadata AS "wrapperMetadata",
                state
           FROM managed_content_keys
          WHERE user_id = $1
            AND key_version = $2
            AND state IN ('active', 'retiring')
          ORDER BY CASE state WHEN 'active' THEN 0 ELSE 1 END ASC,
                   created_at DESC,
                   id DESC`,
        [userId, keyVersion],
      );
      const rows = result.rows.map(parseManagedUserKeyRow);
      const active = rows.find((row) => row.state === "active");
      if (active) {
        // active가 현재 registry에 존재하면 deterministic primary다. unwrap 실패는
        // retiring fallback 사유가 아니므로 그대로 fail-closed 한다.
        if (isResolvable(this.registry, active)) return active;
      }
      const retiring = rows.find((row) => (
        row.state === "retiring" && isResolvable(this.registry, row)
      ));
      if (retiring) return retiring;
      throw new Error("MANAGED_USER_KEY_NOT_FOUND");
    });
  }

  private keyContext(userId: string, keyVersion: number): KeyContext {
    return {
      installationId: this.installationId,
      userId,
      keyVersion,
      purpose: "prompt-history",
    };
  }
}

type MigrationTarget = {
  provider: KeyProviderName;
  providerFingerprint: string;
};

async function latestMigrationTarget(
  db: ManagedUserKeyDatabase,
): Promise<MigrationTarget | null> {
  const result = await db.query(
    `SELECT provider, provider_fingerprint AS "providerFingerprint"
       FROM latest_managed_content_write_fence()`,
  );
  const row = result.rows[0];
  if (!row) return null;
  const provider = requiredProvider(row.provider);
  const providerFingerprint = requiredString(row.providerFingerprint);
  if (!new RegExp(`^${provider}:[0-9a-f]{24}$`).test(providerFingerprint)) {
    throw new Error("MANAGED_USER_KEY_MIGRATION_TARGET_INVALID");
  }
  return { provider, providerFingerprint };
}

function isResolvable(
  registry: KeyProviderRegistry,
  row: ManagedUserKeyRow,
): boolean {
  try {
    registry.resolveWrappedKey(toWrappedUserKey(row));
    return true;
  } catch (error) {
    if (error instanceof Error && error.message === "KEY_PROVIDER_NOT_REGISTERED") {
      return false;
    }
    throw error;
  }
}

async function selectActiveUserKey(
  db: ManagedUserKeyDatabase,
  userId: string,
): Promise<ManagedUserKeyRow | null> {
  const result = await db.query(
    `SELECT user_id AS "userId",
            key_version AS "keyVersion",
            provider,
            provider_key_ref AS "providerKeyRef",
            provider_fingerprint AS "providerFingerprint",
            wrapped_user_key AS "wrappedUserKey",
            wrapper_metadata AS "wrapperMetadata",
            state
       FROM managed_content_keys
      WHERE user_id = $1
        AND state = 'active'
      LIMIT 1`,
    [userId],
  );
  return result.rows[0] ? parseManagedUserKeyRow(result.rows[0]) : null;
}

function rowFromWrapped(
  userId: string,
  keyVersion: number,
  wrapped: WrappedUserKey,
): ManagedUserKeyRow {
  return parseManagedUserKeyRow({
    userId,
    keyVersion,
    provider: wrapped.provider,
    providerKeyRef: wrapped.keyRef,
    providerFingerprint: wrapped.fingerprint,
    wrappedUserKey: wrapped.ciphertext,
    wrapperMetadata: wrapped.metadata,
    state: "active",
  });
}

function toWrappedUserKey(row: ManagedUserKeyRow): WrappedUserKey {
  return {
    provider: row.provider,
    keyRef: row.providerKeyRef,
    fingerprint: row.providerFingerprint,
    ciphertext: row.wrappedUserKey,
    metadata: row.wrapperMetadata,
  };
}

function parseManagedUserKeyRow(row: Record<string, unknown>): ManagedUserKeyRow {
  const userId = requiredString(row.userId);
  const keyVersion = requiredPositiveInteger(row.keyVersion);
  const provider = requiredProvider(row.provider);
  const providerKeyRef = requiredString(row.providerKeyRef);
  const providerFingerprint = requiredString(row.providerFingerprint);
  const wrappedUserKey = requiredBuffer(row.wrappedUserKey);
  const wrapperMetadata = requiredStringRecord(row.wrapperMetadata);
  const state = requiredState(row.state);
  return {
    userId,
    keyVersion,
    provider,
    providerKeyRef,
    providerFingerprint,
    wrappedUserKey,
    wrapperMetadata,
    state,
  };
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("MANAGED_USER_KEY_ROW_INVALID");
  }
  return value;
}

function requiredPositiveInteger(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error("MANAGED_USER_KEY_ROW_INVALID");
  }
  return parsed;
}

function requiredProvider(value: unknown): KeyProviderName {
  if (typeof value !== "string" || !PROVIDER_NAMES.has(value as KeyProviderName)) {
    throw new Error("MANAGED_USER_KEY_ROW_INVALID");
  }
  return value as KeyProviderName;
}

function requiredBuffer(value: unknown): Buffer {
  if (!Buffer.isBuffer(value) || value.length === 0) {
    throw new Error("MANAGED_USER_KEY_ROW_INVALID");
  }
  return value;
}

function requiredStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("MANAGED_USER_KEY_ROW_INVALID");
  }
  const entries = Object.entries(value);
  if (entries.some(([, entry]) => typeof entry !== "string")) {
    throw new Error("MANAGED_USER_KEY_ROW_INVALID");
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function requiredState(value: unknown): ManagedUserKeyState {
  if (value !== "active" && value !== "pending" && value !== "retiring") {
    throw new Error("MANAGED_USER_KEY_ROW_INVALID");
  }
  return value;
}
