import { timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";
import { withUserContext } from "./rls";
import {
  E2eeContractError,
  fromBase64Url,
  parseContentDevice,
  parseContentKeyWrapper,
  type ContentDeviceWire,
  type ContentKeyWrapperWire,
} from "./e2ee-contract";

type ContentAccountState = "pending" | "active";

export type PreparedContentAccount = {
  contentOwnerId: string;
  recoverySalt: string;
  activeKeyVersion: number;
  state: ContentAccountState;
};

export type ContentActivationInput = {
  recoveryConfirmed: true;
  device: ContentDeviceWire;
  wrappers: [ContentKeyWrapperWire, ContentKeyWrapperWire];
};

type QueryResultLike = { rows: Record<string, unknown>[]; rowCount?: number | null };
export type ContentAccountDb = {
  query(sql: string, params?: unknown[]): Promise<QueryResultLike>;
};

export class ContentAccountError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ContentAccountError";
  }
}

const ACTIVATION_FIELDS = ["recoveryConfirmed", "device", "wrappers"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseActivationInput(value: unknown): ContentActivationInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new E2eeContractError("활성화 입력은 객체여야 합니다");
  }
  const record = value as Record<string, unknown>;
  for (const field of Object.keys(record)) {
    if (!ACTIVATION_FIELDS.includes(field as (typeof ACTIVATION_FIELDS)[number])) {
      throw new E2eeContractError(`허용되지 않은 필드: ${field}`);
    }
  }
  if (record.recoveryConfirmed !== true) {
    throw new ContentAccountError("RECOVERY_CONFIRMATION_REQUIRED");
  }
  if (!Array.isArray(record.wrappers) || record.wrappers.length !== 2) {
    throw new ContentAccountError("DEVICE_AND_RECOVERY_WRAPPERS_REQUIRED");
  }

  const device = parseContentDevice(record.device);
  const wrappers = record.wrappers.map(parseContentKeyWrapper) as [
    ContentKeyWrapperWire,
    ContentKeyWrapperWire,
  ];
  const deviceWrappers = wrappers.filter((wrapper) => wrapper.wrapperType === "device");
  const recoveryWrappers = wrappers.filter((wrapper) => wrapper.wrapperType === "recovery");
  if (deviceWrappers.length !== 1 || recoveryWrappers.length !== 1) {
    throw new ContentAccountError("DEVICE_AND_RECOVERY_WRAPPERS_REQUIRED");
  }
  if (!UUID.test(deviceWrappers[0]!.wrapperRef)) {
    throw new ContentAccountError("INVALID_DEVICE_ID");
  }

  return { recoveryConfirmed: true, device, wrappers };
}

export async function prepareContentAccount(
  userId: string,
  db?: ContentAccountDb,
): Promise<PreparedContentAccount> {
  validateUserId(userId);
  return runInContentContext(userId, db, async (tx) => {
    const result = await tx.query(
      `INSERT INTO content_accounts (user_id)
       VALUES ($1)
       ON CONFLICT (user_id) DO UPDATE
         SET updated_at = content_accounts.updated_at
       RETURNING content_owner_id, recovery_salt, active_key_version, state`,
      [userId],
    );
    return mapPreparedAccount(result.rows[0]);
  });
}

export async function activateContentAccount(
  userId: string,
  value: unknown,
  db?: ContentAccountDb,
): Promise<{ state: "active"; contentOwnerId: string; activeKeyVersion: number; deviceId: string }> {
  validateUserId(userId);
  const input = parseActivationInput(value);
  const deviceWrapper = input.wrappers.find((wrapper) => wrapper.wrapperType === "device")!;
  const recoveryWrapper = input.wrappers.find((wrapper) => wrapper.wrapperType === "recovery")!;

  return runInContentContext(userId, db, async (tx) => {
    const accountResult = await tx.query(
      `SELECT content_owner_id, recovery_salt, active_key_version, state
       FROM content_accounts
       WHERE user_id = $1
       FOR UPDATE`,
      [userId],
    );
    const account = mapPreparedAccount(accountResult.rows[0]);
    if (
      deviceWrapper.contentKeyVersion !== account.activeKeyVersion ||
      recoveryWrapper.contentKeyVersion !== account.activeKeyVersion
    ) {
      throw new ContentAccountError("CONTENT_KEY_VERSION_MISMATCH");
    }
    const suppliedSalt = fromBase64Url(recoveryWrapper.publicSaltOrInput!, "publicSaltOrInput");
    const accountSalt = fromBase64Url(account.recoverySalt, "recoverySalt");
    if (suppliedSalt.length !== accountSalt.length || !timingSafeEqual(suppliedSalt, accountSalt)) {
      throw new ContentAccountError("RECOVERY_SALT_MISMATCH");
    }

    await tx.query(
      `INSERT INTO content_devices
         (id, user_id, kind, label, platform, public_key, algorithm_version, approved_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (id) DO NOTHING`,
      [
        deviceWrapper.wrapperRef,
        userId,
        input.device.kind,
        input.device.label,
        input.device.platform,
        fromBase64Url(input.device.publicKey, "publicKey"),
        input.device.algorithmVersion,
      ],
    );

    for (const wrapper of input.wrappers) {
      await insertWrapper(tx, userId, wrapper);
    }

    await tx.query(
      `UPDATE content_accounts
       SET state = 'active', recovery_confirmed_at = COALESCE(recovery_confirmed_at, now()), updated_at = now()
       WHERE user_id = $1`,
      [userId],
    );

    return {
      state: "active",
      contentOwnerId: account.contentOwnerId,
      activeKeyVersion: account.activeKeyVersion,
      deviceId: deviceWrapper.wrapperRef,
    };
  });
}

async function insertWrapper(
  tx: ContentAccountDb,
  userId: string,
  wrapper: ContentKeyWrapperWire,
): Promise<void> {
  await tx.query(
    `INSERT INTO content_key_wrappers
       (user_id, content_key_version, wrapper_type, wrapper_ref, kdf_version,
        public_salt_or_input, nonce, auth_tag, encapsulated_key, wrapped_content_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (user_id, content_key_version, wrapper_type, wrapper_ref)
       WHERE revoked_at IS NULL DO NOTHING`,
    [
      userId,
      wrapper.contentKeyVersion,
      wrapper.wrapperType,
      wrapper.wrapperRef,
      wrapper.kdfVersion,
      decodeNullable(wrapper.publicSaltOrInput, "publicSaltOrInput"),
      decodeNullable(wrapper.nonce, "nonce"),
      decodeNullable(wrapper.authTag, "authTag"),
      decodeNullable(wrapper.encapsulatedKey, "encapsulatedKey"),
      fromBase64Url(wrapper.wrappedContentKey, "wrappedContentKey"),
    ],
  );
}

function decodeNullable(value: string | null, field: string): Buffer | null {
  return value === null ? null : fromBase64Url(value, field);
}

function mapPreparedAccount(row: Record<string, unknown> | undefined): PreparedContentAccount {
  if (!row) throw new ContentAccountError("CONTENT_ACCOUNT_NOT_FOUND");
  const salt = row.recovery_salt;
  const recoverySalt =
    typeof salt === "string" ? salt : Buffer.isBuffer(salt) ? salt.toString("base64url") : null;
  if (
    typeof row.content_owner_id !== "string" ||
    typeof recoverySalt !== "string" ||
    (row.state !== "pending" && row.state !== "active") ||
    typeof row.active_key_version !== "number"
  ) {
    throw new ContentAccountError("INVALID_CONTENT_ACCOUNT_STATE");
  }
  return {
    contentOwnerId: row.content_owner_id,
    recoverySalt,
    activeKeyVersion: row.active_key_version,
    state: row.state,
  };
}

function validateUserId(userId: string): void {
  if (!userId) throw new ContentAccountError("INVALID_USER_ID");
}

async function runInContentContext<T>(
  userId: string,
  db: ContentAccountDb | undefined,
  fn: (tx: ContentAccountDb) => Promise<T>,
): Promise<T> {
  if (db) return fn(db);
  return withUserContext(userId, (tx: PoolClient) => fn(tx));
}
