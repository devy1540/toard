import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

test("login action과 Auth.js direct credentials 경로가 같은 공유 limiter를 우회하지 않는다", () => {
  const action = source("app/login/actions.ts");
  const auth = source("auth.ts");
  const credential = source("lib/credential-auth.ts");

  assert.match(action, /credentialClientIdentity\(await headers\(\)\)[\s\S]*CredentialRateLimitError/);
  assert.match(auth, /authorize: async \(creds, request\)[\s\S]*credentialClientIdentity\(request\.headers\)/);
  assert.match(auth, /CredentialRateLimitError[\s\S]*return null/);
  assert.ok(credential.indexOf("await consumeCredentialAttempt") < credential.indexOf("await verifyPassword"));
  assert.ok(credential.indexOf("await verifyPassword") < credential.indexOf("await clearCredentialAccountLimit"));
});

test("signup은 bcrypt 전에 IP/account/global budget을 소비하고 성공한 account만 해제한다", () => {
  const signup = source("app/signup/actions.ts");
  const consume = signup.indexOf("await consumeCredentialAttempt");
  const hash = signup.indexOf("hashPassword(password)");
  const insert = signup.indexOf("INSERT INTO users");
  const clear = signup.indexOf("await clearCredentialAccountLimit");

  assert.ok(consume >= 0 && consume < hash && hash < insert && insert < clear);
  assert.match(signup, /channel: "signup"[\s\S]*credentialClientIdentity\(await headers\(\)\)/);
  assert.match(signup, /CredentialRateLimitError[\s\S]*tooManyAttempts/);
});

test("credential rate-limit migration은 raw identity 대신 digest와 SECURITY DEFINER 함수만 app에 노출한다", () => {
  const migration = source("../../migrations/1700000052_credential_rate_limits.sql");
  const bootstrap = source("../../scripts/bootstrap-app-role.sql");

  assert.doesNotMatch(migration, /email\s+TEXT|ip_address|client_ip/i);
  assert.match(migration, /key_hash BYTEA[\s\S]*octet_length\(key_hash\) = 32/);
  assert.match(migration, /SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, public/g);
  assert.match(migration, /REVOKE ALL PRIVILEGES ON TABLE credential_rate_limits FROM PUBLIC/);
  assert.match(migration, /REVOKE ALL ON FUNCTION consume_credential_rate_limit/);
  assert.match(bootstrap, /REVOKE ALL PRIVILEGES ON TABLE public\.credential_rate_limits FROM toard_app/);
  assert.match(bootstrap, /REVOKE ALL ON FUNCTION public\.consume_credential_rate_limit\(TEXT, BYTEA\) FROM toard_app/);
  assert.match(bootstrap, /GRANT EXECUTE ON FUNCTION public\.consume_credential_rate_limits/);
});
