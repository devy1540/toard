import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import enAuth from "../messages/en/auth.json";
import enDashboard from "../messages/en/dashboard.json";
import enSettings from "../messages/en/settings.json";
import koAuth from "../messages/ko/auth.json";
import koDashboard from "../messages/ko/dashboard.json";
import koSettings from "../messages/ko/settings.json";

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

test("MFA catalogs are symmetric in Korean and English", () => {
  assert.deepEqual(Object.keys(koAuth.login).sort(), Object.keys(enAuth.login).sort());
  assert.deepEqual(Object.keys(koAuth.errors).sort(), Object.keys(enAuth.errors).sort());
  assert.deepEqual(Object.keys(koSettings.mfa).sort(), Object.keys(enSettings.mfa).sort());
  assert.deepEqual(Object.keys(koSettings.mfa.errors).sort(), Object.keys(enSettings.mfa.errors).sort());
  assert.deepEqual(Object.keys(koDashboard.history.mfa).sort(), Object.keys(enDashboard.history.mfa).sort());
});

test("password login switches to a passkey challenge without keeping the password in state", () => {
  const action = source("app/login/actions.ts");
  const form = source("app/login/login-form.tsx");
  const auth = source("auth.ts");
  assert.match(action, /verifyCredentialUser[\s\S]*isCredentialMfaRequired/);
  assert.match(action, /credential-challenge/);
  assert.match(action, /finishPasskeyAuthentication/);
  const challengeBranch = form.indexOf('state.step === "passkey"');
  const credentialForm = form.indexOf('name="email"');
  assert.ok(challengeBranch >= 0 && challengeBranch < credentialForm);
  assert.match(form, /startAuthentication/);
  assert.doesNotMatch(form.slice(challengeBranch, credentialForm), /name="password"/);
  assert.match(auth, /verifyCredentialUser[\s\S]*isCredentialMfaRequired/);
  assert.match(auth, /credential-ticket/);
});

test("settings expose independent password-login and history protection switches", () => {
  const panel = source("app/(dashboard)/settings/mfa-settings-panel.tsx");
  assert.match(panel, /setLoginRequired/);
  assert.match(panel, /setHistoryRequired/);
  assert.match(panel, /disabled=!\{?hasPassword\}?|disabled=\{!hasPassword\}/);
  assert.match(panel, /startRegistration/);
  assert.match(panel, /startAuthentication/);
  assert.doesNotMatch(panel, /TOTP|recoveryCodes|otpauth/);
});

test("history gate runs before server history reads and both content routes return MFA_REQUIRED", () => {
  const page = source("app/(dashboard)/history/page.tsx");
  const gate = page.indexOf("getHistoryMfaGate(userId)");
  assert.ok(gate >= 0 && gate < page.indexOf("getE2eeContentStatus(userId)"));
  assert.ok(gate < page.indexOf("getMyHistorySessions("));
  for (const path of [
    "app/api/content/history/sessions/route.ts",
    "app/api/content/history/sessions/[key]/route.ts",
  ]) {
    const route = source(path);
    assert.match(route, /getHistoryMfaGate\(userId\)/);
    assert.match(route, /problem\(403, "MFA_REQUIRED"\)/);
  }
});

test("sign-out clears the history step-up cookie", () => {
  const menu = source("components/dashboard/user-menu.tsx");
  assert.ok(menu.indexOf("clearHistoryMfaAccess()") < menu.indexOf("signOut({"));
});

test("history step-up is bound to the current login session", () => {
  const auth = source("auth.ts");
  const gate = source("lib/history-mfa.ts");
  assert.match(auth, /token\.mfaSid/);
  assert.match(auth, /session\.mfaSessionId/);
  assert.match(gate, /payload\.nonce === sessionId/);
});
