import { encryptManagedContent } from "@/lib/managed-content-crypto";
import type { ManagedContentRuntime } from "@/lib/managed-content-runtime";
import { withUserContext } from "@/lib/rls";
import type { PromptRecordWire } from "@/lib/prompt-wire";
import { fromBase64Url, type E2eePromptRecordWire } from "@/lib/e2ee-contract";
import type { PoolClient } from "pg";

// prompt_records 멱등 저장 (설계: RLS + at-rest 트랙).
// 각 레코드 본문을 서버에서 봉투 암호화한 뒤, RLS 컨텍스트(소유자=userId) 안에서 INSERT.
// dedup_key 충돌은 무시(멱등) — shim 재수집/레이스가 겹쳐도 안전.

export async function savePromptRecords(
  userId: string,
  records: PromptRecordWire[],
  kek: Buffer,
): Promise<{ inserted: number; deduped: number }> {
  if (records.length === 0) return { inserted: 0, deduped: 0 };
  const { encryptContent } = await import("@/lib/legacy-content-crypto");
  let inserted = 0;
  await withUserContext(userId, async (tx) => {
    for (const r of records) {
      const enc = encryptContent(r.text, kek);
      const res = await tx.query(
        `INSERT INTO prompt_records
           (dedup_key, user_id, session_id, provider_key, turn_role, ts,
            key_version, wrapped_dek, iv, ciphertext, auth_tag)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (dedup_key) DO NOTHING`,
        [
          r.dedupKey,
          userId,
          r.sessionId,
          r.providerKey,
          r.turnRole,
          r.ts,
          enc.keyVersion,
          enc.wrappedDek,
          enc.iv,
          enc.ciphertext,
          enc.authTag,
        ],
      );
      inserted += res.rowCount ?? 0;
    }
  });
  return { inserted, deduped: records.length - inserted };
}

export type PromptDb = {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
};

export async function saveManagedPromptRecords(
  userId: string,
  records: PromptRecordWire[],
  runtime: ManagedContentRuntime,
  db?: PromptDb,
): Promise<{ inserted: number; deduped: number }> {
  if (records.length === 0) return { inserted: 0, deduped: 0 };
  const snapshots = snapshotManagedPromptRecords(records);

  return runtime.userKeys.withActiveUserKey(userId, async (uck, keyVersion) => {
    const encrypted = snapshots.map((record) =>
      encryptManagedContent(
        record,
        uck,
        runtime.installationId,
        userId,
        keyVersion,
      ));

    return runPromptContext(userId, db, async (tx) => {
      let inserted = 0;
      for (let index = 0; index < snapshots.length; index += 1) {
        const record = snapshots[index]!;
        const enc = encrypted[index]!;
        const result = await tx.query(
          `INSERT INTO prompt_records
             (dedup_key, user_id, session_id, provider_key, turn_role, ts,
              key_version, wrapped_dek, iv, ciphertext, auth_tag,
              encryption_scheme, content_owner_id, content_key_version,
              dek_wrap_iv, dek_wrap_auth_tag, aad_version)
           VALUES ($1, $2, $3, $4, $5, $6,
                   $7, $8, $9, $10, $11,
                   'managed_v1', $12, $13, $14, $15, $16)
           ON CONFLICT (dedup_key) DO NOTHING`,
          [
            record.dedupKey,
            userId,
            record.sessionId,
            record.providerKey,
            record.turnRole,
            record.ts,
            enc.contentKeyVersion,
            enc.wrappedDek,
            enc.iv,
            enc.ciphertext,
            enc.authTag,
            null,
            enc.contentKeyVersion,
            enc.dekWrapIv,
            enc.dekWrapAuthTag,
            enc.aadVersion,
          ],
        );
        inserted += result.rowCount ?? 0;
      }
      return { inserted, deduped: snapshots.length - inserted };
    });
  });
}

function snapshotManagedPromptRecords(
  records: PromptRecordWire[],
): readonly Readonly<PromptRecordWire>[] {
  try {
    return Object.freeze(records.map((record) => {
      if (
        typeof record !== "object"
        || record === null
        || typeof record.dedupKey !== "string"
        || (
          record.sessionId !== null
          && typeof record.sessionId !== "string"
        )
        || typeof record.providerKey !== "string"
        || (record.turnRole !== "user" && record.turnRole !== "assistant")
        || !(record.ts instanceof Date)
        || !Number.isFinite(record.ts.getTime())
        || typeof record.text !== "string"
      ) {
        throw new Error("INVALID_PROMPT_RECORD");
      }
      return Object.freeze({
        dedupKey: record.dedupKey,
        sessionId: record.sessionId,
        providerKey: record.providerKey,
        turnRole: record.turnRole,
        ts: new Date(record.ts.getTime()),
        text: record.text,
      });
    }));
  } catch {
    throw new Error("CONTENT_RECORD_SNAPSHOT_FAILED");
  }
}

export class E2eePromptSaveError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "E2eePromptSaveError";
  }
}

export async function saveE2eePromptRecords(
  userId: string,
  records: E2eePromptRecordWire[],
  db?: PromptDb,
): Promise<{ inserted: number; deduped: number }> {
  if (records.length === 0) return { inserted: 0, deduped: 0 };
  const ownerId = records[0]!.contentOwnerId;
  const keyVersion = records[0]!.contentKeyVersion;
  if (
    records.some(
      (record) =>
        record.contentOwnerId !== ownerId || record.contentKeyVersion !== keyVersion,
    )
  ) {
    throw new E2eePromptSaveError("MIXED_CONTENT_OWNER_OR_KEY_VERSION");
  }

  return runE2eeContext(userId, db, async (tx) => {
    const accountResult = await tx.query(
      `SELECT user_id, state, active_key_version
       FROM content_accounts
       WHERE content_owner_id = $1`,
      [ownerId],
    );
    const account = accountResult.rows[0] as
      | { user_id?: unknown; state?: unknown; active_key_version?: unknown }
      | undefined;
    if (!account || account.user_id !== userId) {
      throw new E2eePromptSaveError("CONTENT_OWNER_MISMATCH");
    }
    if (account.state !== "active" && account.state !== "migrated") {
      throw new E2eePromptSaveError("CONTENT_ACCOUNT_INACTIVE");
    }
    if (account.active_key_version !== keyVersion) {
      throw new E2eePromptSaveError("CONTENT_KEY_VERSION_MISMATCH");
    }

    let inserted = 0;
    for (const record of records) {
      const result = await tx.query(
        `INSERT INTO prompt_records
           (dedup_key, user_id, session_id, provider_key, turn_role, ts,
            key_version, wrapped_dek, iv, ciphertext, auth_tag,
            encryption_scheme, content_owner_id, content_key_version,
            dek_wrap_iv, dek_wrap_auth_tag, aad_version)
         VALUES ($1, $2, $3, $4, $5, $6,
                 $7, $8, $9, $10, $11,
                 'e2ee_v1', $12, $13, $14, $15, 1)
         ON CONFLICT (dedup_key) DO NOTHING`,
        [
          record.dedupKey,
          userId,
          record.sessionId,
          record.providerKey,
          record.turnRole,
          record.ts,
          record.contentKeyVersion,
          fromBase64Url(record.wrappedDek, "wrappedDek"),
          fromBase64Url(record.iv, "iv"),
          fromBase64Url(record.ciphertext, "ciphertext"),
          fromBase64Url(record.authTag, "authTag"),
          record.contentOwnerId,
          record.contentKeyVersion,
          fromBase64Url(record.dekWrapIv, "dekWrapIv"),
          fromBase64Url(record.dekWrapAuthTag, "dekWrapAuthTag"),
        ],
      );
      inserted += result.rowCount ?? 0;
    }
    return { inserted, deduped: records.length - inserted };
  });
}

async function runE2eeContext<T>(
  userId: string,
  db: PromptDb | undefined,
  fn: (tx: PromptDb) => Promise<T>,
): Promise<T> {
  return runPromptContext(userId, db, fn);
}

async function runPromptContext<T>(
  userId: string,
  db: PromptDb | undefined,
  fn: (tx: PromptDb) => Promise<T>,
): Promise<T> {
  if (db) return fn(db);
  return withUserContext(userId, (tx: PoolClient) => fn(tx));
}
