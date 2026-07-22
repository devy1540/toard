import assert from "node:assert/strict";
import test from "node:test";
import { createSignedMfaToken, verifySignedMfaToken } from "./mfa";

test("signed MFA tokens reject tampering, expiration, and a different purpose", () => {
  const secret = "test-auth-secret-with-enough-entropy";
  const token = createSignedMfaToken({
    purpose: "history-access", userId: "user-1", expiresAt: 2_000, mfaVersion: 3, nonce: "session-1",
  }, secret);
  assert.equal(verifySignedMfaToken(token, "history-access", 1_000, secret)?.userId, "user-1");
  assert.equal(verifySignedMfaToken(`${token}x`, "history-access", 1_000, secret), null);
  assert.equal(verifySignedMfaToken(`${token}.extra`, "history-access", 1_000, secret), null);
  assert.equal(verifySignedMfaToken(token, "credential-ticket", 1_000, secret), null);
  assert.equal(verifySignedMfaToken(token, "history-access", 2_000, secret), null);
});
