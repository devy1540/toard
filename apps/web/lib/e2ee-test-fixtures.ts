import type {
  ContentDeviceWire,
  ContentKeyWrapperWire,
  DeviceEnvelopeWire,
  E2eePromptRecordWire,
} from "./e2ee-contract";

const b64 = (length: number): string => Buffer.alloc(length, 7).toString("base64url");

export const VALID_E2EE_RECORD: E2eePromptRecordWire = {
  schema: "e2ee_v1",
  algorithm: "AES-256-GCM",
  aadVersion: 1,
  contentOwnerId: "018f47d0-4d47-7b04-950b-7d18a86e1b43",
  contentKeyVersion: 1,
  dedupKey: "dedup-1",
  sessionId: "session-1",
  providerKey: "codex",
  turnRole: "user",
  ts: "2026-07-14T00:00:00.000Z",
  wrappedDek: b64(32),
  dekWrapIv: b64(12),
  dekWrapAuthTag: b64(16),
  iv: b64(12),
  ciphertext: b64(24),
  authTag: b64(16),
};

export const VALID_BROWSER: ContentDeviceWire = {
  kind: "browser",
  label: "Chrome on Mac",
  platform: "macOS",
  publicKey: b64(65),
  algorithmVersion: "hpke-p256-v1",
};

export const VALID_DEVICE: ContentDeviceWire = {
  ...VALID_BROWSER,
  kind: "shim",
  label: "MacBook",
};

export const VALID_DEVICE_ENVELOPE: DeviceEnvelopeWire = {
  algorithm: "hpke-p256-hkdf-sha256-aes256gcm-v1",
  encapsulatedKey: b64(65),
  ciphertext: b64(48),
};

export const VALID_DEVICE_WRAPPER: ContentKeyWrapperWire = {
  wrapperType: "device",
  wrapperRef: "018f47d0-4d47-7b04-950b-7d18a86e1b44",
  contentKeyVersion: 1,
  kdfVersion: "hpke-p256-v1",
  publicSaltOrInput: null,
  nonce: null,
  authTag: null,
  encapsulatedKey: VALID_DEVICE_ENVELOPE.encapsulatedKey,
  wrappedContentKey: VALID_DEVICE_ENVELOPE.ciphertext,
};

export const VALID_RECOVERY_WRAPPER: ContentKeyWrapperWire = {
  wrapperType: "recovery",
  wrapperRef: "account",
  contentKeyVersion: 1,
  kdfVersion: "hkdf-sha256-v1",
  publicSaltOrInput: b64(32),
  nonce: b64(12),
  authTag: b64(16),
  encapsulatedKey: null,
  wrappedContentKey: b64(32),
};

export const VALID_ACTIVATION_INPUT = {
  recoveryConfirmed: true,
  device: VALID_DEVICE,
  wrappers: [VALID_RECOVERY_WRAPPER, VALID_DEVICE_WRAPPER],
};

export function createRecordingDb(options: { ownerUserId?: string } = {}) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  return {
    calls,
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      if (/SELECT[\s\S]+content_accounts/i.test(sql)) {
        return { rows: [{ user_id: options.ownerUserId ?? "user-1" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
  };
}
