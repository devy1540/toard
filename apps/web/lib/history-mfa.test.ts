import assert from "node:assert/strict";
import test from "node:test";
import { createSignedMfaToken } from "./mfa";
import { isHistoryMfaTokenValid } from "./history-mfa";
import type { MfaStatus } from "./mfa-store";

const secret = "test-auth-secret-with-enough-entropy";
const protectedStatus: MfaStatus = {
  enrolled: true,
  loginRequired: false,
  historyRequired: true,
  version: 4,
  passkeys: [{ id: "key-1", label: "Passkey", createdAt: new Date(0).toISOString(), lastUsedAt: null, backedUp: true }],
};

test("history MFA accepts only the same user, session, and current policy version", () => {
  const token = createSignedMfaToken(
    {
      purpose: "history-access",
      userId: "user-1",
      mfaVersion: 4,
      expiresAt: 2_000,
      nonce: "nonce",
    },
    secret,
  );
  assert.equal(isHistoryMfaTokenValid(token, "user-1", protectedStatus, "nonce", 1_000, secret), true);
  assert.equal(isHistoryMfaTokenValid(token, "user-2", protectedStatus, "nonce", 1_000, secret), false);
  assert.equal(isHistoryMfaTokenValid(token, "user-1", protectedStatus, "new-session", 1_000, secret), false);
  assert.equal(
    isHistoryMfaTokenValid(token, "user-1", { ...protectedStatus, version: 5 }, "nonce", 1_000, secret),
    false,
  );
  assert.equal(isHistoryMfaTokenValid(token, "user-1", protectedStatus, "nonce", 2_000, secret), false);
});

test("history without an enabled policy does not require a cookie", () => {
  assert.equal(
    isHistoryMfaTokenValid(undefined, "user-1", { ...protectedStatus, historyRequired: false }, undefined, 1_000, secret),
    true,
  );
});
