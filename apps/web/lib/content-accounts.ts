import { createHash, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";
import { withUserContext } from "./rls";
import {
  E2eeContractError,
  fromBase64Url,
  parseContentDevice,
  parseContentKeyWrapper,
  parseDeviceEnvelope,
  type ContentDeviceWire,
  type ContentKeyWrapperWire,
  type DeviceEnvelopeWire,
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
const APPROVAL_TTL_MS = 300_000;

export type ApprovalRequest = {
  id: string;
  deviceId: string;
  code: string;
  label: string;
  platform: string;
  createdAt: string;
  expiresAt: string;
};

export type PendingApprovalRequest = Omit<ApprovalRequest, "code"> & {
  publicKey: string;
};

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

export async function createApprovalRequest(
  userId: string,
  value: unknown,
  now = new Date(),
  db?: ContentAccountDb,
): Promise<ApprovalRequest> {
  validateUserId(userId);
  const device = parseContentDevice(value);
  if (device.kind !== "browser") throw new ContentAccountError("BROWSER_DEVICE_REQUIRED");
  const requestId = randomUUID();
  const deviceId = randomUUID();
  const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
  const expiresAt = new Date(now.getTime() + APPROVAL_TTL_MS);
  return runInContentContext(userId, db, async (tx) => {
    const accountResult = await tx.query(
      `SELECT state FROM content_accounts WHERE user_id = $1 FOR UPDATE`,
      [userId],
    );
    if (accountResult.rows[0]?.state !== "active") {
      throw new ContentAccountError("E2EE_ACCOUNT_NOT_ACTIVE");
    }
    await tx.query(
      `INSERT INTO content_devices
         (id, user_id, kind, label, platform, public_key, algorithm_version)
       VALUES ($1, $2, 'browser', $3, $4, $5, 'hpke-p256-v1')`,
      [deviceId, userId, device.label, device.platform, fromBase64Url(device.publicKey, "publicKey")],
    );
    await tx.query(
      `INSERT INTO content_device_approval_requests
         (id, user_id, requested_device_id, confirmation_code_hash, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [requestId, userId, deviceId, approvalCodeHash(requestId, code), now, expiresAt],
    );
    return {
      id: requestId,
      deviceId,
      code,
      label: device.label,
      platform: device.platform,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
  });
}

export async function listPendingApprovalRequests(
  userId: string,
  now = new Date(),
  db?: ContentAccountDb,
): Promise<PendingApprovalRequest[]> {
  validateUserId(userId);
  const result = await runInContentContext(userId, db, (tx) =>
    tx.query(
      `SELECT request.id, request.requested_device_id, request.created_at, request.expires_at,
              device.label, device.platform, device.public_key
       FROM content_device_approval_requests request
       JOIN content_devices device ON device.id = request.requested_device_id
       WHERE request.user_id = $1 AND request.approved_at IS NULL
         AND request.consumed_at IS NULL AND request.expires_at >= $2
         AND device.revoked_at IS NULL
       ORDER BY request.created_at ASC`,
      [userId, now],
    ),
  );
  return result.rows.map((row) => ({
    id: requiredString(row.id),
    deviceId: requiredString(row.requested_device_id),
    label: requiredString(row.label),
    platform: requiredString(row.platform),
    publicKey: requiredBuffer(row.public_key).toString("base64url"),
    createdAt: requiredDate(row.created_at).toISOString(),
    expiresAt: requiredDate(row.expires_at).toISOString(),
  }));
}

export async function approveRequest(
  userId: string,
  requestId: string,
  code: string,
  value: unknown,
  now = new Date(),
  db?: ContentAccountDb,
): Promise<{ approved: true; deviceId: string }> {
  validateUserId(userId);
  validateUuid(requestId, "INVALID_APPROVAL_REQUEST_ID");
  if (!/^\d{6}$/.test(code)) throw new ContentAccountError("DEVICE_APPROVAL_CODE_INVALID");
  const envelope = parseDeviceEnvelope(value);
  return runInContentContext(userId, db, async (tx) => {
    const result = await tx.query(
      `SELECT request.requested_device_id, request.confirmation_code_hash, request.expires_at,
              request.approved_at, request.consumed_at, account.active_key_version
       FROM content_device_approval_requests request
       JOIN content_accounts account ON account.user_id = request.user_id AND account.state = 'active'
       WHERE request.id = $1 AND request.user_id = $2
       FOR UPDATE`,
      [requestId, userId],
    );
    const row = result.rows[0];
    if (!row) throw new ContentAccountError("DEVICE_APPROVAL_NOT_FOUND");
    if (requiredDate(row.expires_at).getTime() < now.getTime()) {
      throw new ContentAccountError("DEVICE_APPROVAL_EXPIRED");
    }
    if (row.consumed_at != null) throw new ContentAccountError("DEVICE_APPROVAL_CONSUMED");
    if (row.approved_at != null) throw new ContentAccountError("DEVICE_APPROVAL_ALREADY_APPROVED");
    const supplied = approvalCodeHash(requestId, code);
    const expected = requiredBuffer(row.confirmation_code_hash);
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
      throw new ContentAccountError("DEVICE_APPROVAL_CODE_INVALID");
    }
    const deviceId = requiredString(row.requested_device_id);
    const keyVersion = requiredNumber(row.active_key_version);
    await tx.query(
      `UPDATE content_device_approval_requests
       SET encapsulated_key = $3, encrypted_envelope = $4, approved_at = $5
       WHERE id = $1 AND user_id = $2`,
      [
        requestId,
        userId,
        fromBase64Url(envelope.encapsulatedKey, "encapsulatedKey"),
        fromBase64Url(envelope.ciphertext, "ciphertext"),
        now,
      ],
    );
    await tx.query(
      `UPDATE content_devices SET approved_at = $3 WHERE id = $1 AND user_id = $2`,
      [deviceId, userId, now],
    );
    await insertWrapper(tx, userId, {
      wrapperType: "device",
      wrapperRef: deviceId,
      contentKeyVersion: keyVersion,
      kdfVersion: "hpke-p256-v1",
      publicSaltOrInput: null,
      nonce: null,
      authTag: null,
      encapsulatedKey: envelope.encapsulatedKey,
      wrappedContentKey: envelope.ciphertext,
    });
    return { approved: true, deviceId };
  });
}

export async function consumeApprovedEnvelope(
  userId: string,
  requestId: string,
  now = new Date(),
  db?: ContentAccountDb,
): Promise<{ deviceId: string; envelope: DeviceEnvelopeWire }> {
  validateUserId(userId);
  validateUuid(requestId, "INVALID_APPROVAL_REQUEST_ID");
  return runInContentContext(userId, db, async (tx) => {
    const result = await tx.query(
      `SELECT requested_device_id, expires_at, approved_at, consumed_at,
              encapsulated_key, encrypted_envelope
       FROM content_device_approval_requests
       WHERE id = $1 AND user_id = $2
       FOR UPDATE`,
      [requestId, userId],
    );
    const row = result.rows[0];
    if (!row) throw new ContentAccountError("DEVICE_APPROVAL_NOT_FOUND");
    if (requiredDate(row.expires_at).getTime() < now.getTime()) {
      throw new ContentAccountError("DEVICE_APPROVAL_EXPIRED");
    }
    if (row.consumed_at != null) throw new ContentAccountError("DEVICE_APPROVAL_CONSUMED");
    if (row.approved_at == null) throw new ContentAccountError("DEVICE_APPROVAL_PENDING");
    const envelope = {
      algorithm: "hpke-p256-hkdf-sha256-aes256gcm-v1" as const,
      encapsulatedKey: requiredBuffer(row.encapsulated_key).toString("base64url"),
      ciphertext: requiredBuffer(row.encrypted_envelope).toString("base64url"),
    };
    await tx.query(
      `UPDATE content_device_approval_requests SET consumed_at = $3
       WHERE id = $1 AND user_id = $2 AND consumed_at IS NULL`,
      [requestId, userId, now],
    );
    return { deviceId: requiredString(row.requested_device_id), envelope };
  });
}

export async function getDeviceWrapper(
  userId: string,
  deviceId: string,
  db?: ContentAccountDb,
): Promise<ContentKeyWrapperWire> {
  validateUuid(deviceId, "INVALID_DEVICE_ID");
  const result = await runInContentContext(userId, db, (tx) =>
    tx.query(
      `SELECT wrapper.content_key_version, wrapper.encapsulated_key, wrapper.wrapped_content_key
       FROM content_devices device
       JOIN content_accounts account ON account.user_id = device.user_id AND account.state = 'active'
       JOIN content_key_wrappers wrapper ON wrapper.user_id = device.user_id
         AND wrapper.wrapper_type = 'device' AND wrapper.wrapper_ref = device.id::text
         AND wrapper.content_key_version = account.active_key_version AND wrapper.revoked_at IS NULL
       WHERE device.id = $1 AND device.user_id = $2
         AND device.approved_at IS NOT NULL AND device.revoked_at IS NULL`,
      [deviceId, userId],
    ),
  );
  const row = result.rows[0];
  if (!row) throw new ContentAccountError("DEVICE_WRAPPER_NOT_FOUND");
  return {
    wrapperType: "device", wrapperRef: deviceId,
    contentKeyVersion: requiredNumber(row.content_key_version), kdfVersion: "hpke-p256-v1",
    publicSaltOrInput: null, nonce: null, authTag: null,
    encapsulatedKey: requiredBuffer(row.encapsulated_key).toString("base64url"),
    wrappedContentKey: requiredBuffer(row.wrapped_content_key).toString("base64url"),
  };
}

export async function getRecoveryWrapper(
  userId: string,
  db?: ContentAccountDb,
): Promise<{ contentOwnerId: string; wrapper: ContentKeyWrapperWire }> {
  const result = await runInContentContext(userId, db, (tx) =>
    tx.query(
      `SELECT account.content_owner_id, wrapper.wrapper_ref, wrapper.content_key_version, wrapper.public_salt_or_input,
              wrapper.nonce, wrapper.auth_tag, wrapper.wrapped_content_key
       FROM content_accounts account
       JOIN content_key_wrappers wrapper ON wrapper.user_id = account.user_id
         AND wrapper.wrapper_type = 'recovery'
         AND wrapper.content_key_version = account.active_key_version AND wrapper.revoked_at IS NULL
       WHERE account.user_id = $1 AND account.state = 'active'`,
      [userId],
    ),
  );
  const row = result.rows[0];
  if (!row) throw new ContentAccountError("RECOVERY_WRAPPER_NOT_FOUND");
  return {
    contentOwnerId: requiredString(row.content_owner_id),
    wrapper: {
      wrapperType: "recovery", wrapperRef: requiredString(row.wrapper_ref),
      contentKeyVersion: requiredNumber(row.content_key_version), kdfVersion: "hkdf-sha256-v1",
      publicSaltOrInput: requiredBuffer(row.public_salt_or_input).toString("base64url"),
      nonce: requiredBuffer(row.nonce).toString("base64url"),
      authTag: requiredBuffer(row.auth_tag).toString("base64url"), encapsulatedKey: null,
      wrappedContentKey: requiredBuffer(row.wrapped_content_key).toString("base64url"),
    },
  };
}

export async function registerRecoveredBrowser(
  userId: string,
  value: unknown,
  db?: ContentAccountDb,
): Promise<{ approved: true; deviceId: string }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ContentAccountError("INVALID_RECOVERY_COMPLETION");
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !["device", "deviceWrapper"].includes(key))) {
    throw new ContentAccountError("INVALID_RECOVERY_COMPLETION");
  }
  const device = parseContentDevice(input.device);
  const wrapper = parseContentKeyWrapper(input.deviceWrapper);
  if (device.kind !== "browser" || wrapper.wrapperType !== "device") {
    throw new ContentAccountError("INVALID_RECOVERY_COMPLETION");
  }
  validateUuid(wrapper.wrapperRef, "INVALID_DEVICE_ID");
  return runInContentContext(userId, db, async (tx) => {
    const accountResult = await tx.query(
      `SELECT active_key_version, state FROM content_accounts WHERE user_id = $1 FOR UPDATE`,
      [userId],
    );
    const account = accountResult.rows[0];
    if (account?.state !== "active") throw new ContentAccountError("E2EE_ACCOUNT_NOT_ACTIVE");
    if (requiredNumber(account.active_key_version) !== wrapper.contentKeyVersion) {
      throw new ContentAccountError("CONTENT_KEY_VERSION_MISMATCH");
    }
    await tx.query(
      `INSERT INTO content_devices
         (id, user_id, kind, label, platform, public_key, algorithm_version, approved_at)
       VALUES ($1, $2, 'browser', $3, $4, $5, 'hpke-p256-v1', now())`,
      [wrapper.wrapperRef, userId, device.label, device.platform, fromBase64Url(device.publicKey, "publicKey")],
    );
    await insertWrapper(tx, userId, wrapper);
    return { approved: true, deviceId: wrapper.wrapperRef };
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

function validateUuid(value: string, code: string): void {
  if (!UUID.test(value)) throw new ContentAccountError(code);
}

function approvalCodeHash(requestId: string, code: string): Buffer {
  return createHash("sha256").update(`${requestId}:${code}`, "utf8").digest();
}

function requiredString(value: unknown): string {
  if (typeof value !== "string") throw new ContentAccountError("INVALID_CONTENT_ACCOUNT_STATE");
  return value;
}

function requiredBuffer(value: unknown): Buffer {
  if (!Buffer.isBuffer(value)) throw new ContentAccountError("INVALID_CONTENT_ACCOUNT_STATE");
  return value;
}

function requiredDate(value: unknown): Date {
  const date = value instanceof Date ? value : new Date(requiredString(value));
  if (Number.isNaN(date.getTime())) throw new ContentAccountError("INVALID_CONTENT_ACCOUNT_STATE");
  return date;
}

function requiredNumber(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new ContentAccountError("INVALID_CONTENT_ACCOUNT_STATE");
  }
  return number;
}

async function runInContentContext<T>(
  userId: string,
  db: ContentAccountDb | undefined,
  fn: (tx: ContentAccountDb) => Promise<T>,
): Promise<T> {
  if (db) return fn(db);
  return withUserContext(userId, (tx: PoolClient) => fn(tx));
}
