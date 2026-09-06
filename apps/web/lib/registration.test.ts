import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { canSignInWithOAuth, createOAuthMember, registrationMode } from "./registration";

test("registration defaults and unknown values are invitation-only", () => {
  for (const mode of [undefined, "", "open", "true", "verified_oauth_typo"]) {
    assert.equal(registrationMode({ AUTH_REGISTRATION_MODE: mode }), "invite_only");
  }
  assert.equal(registrationMode({ AUTH_REGISTRATION_MODE: "verified_oauth" }), "verified_oauth");
});

test("a domain-shaped address alone cannot admit an uninvited identity", async () => {
  const pool = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Pool;
  assert.equal(await canSignInWithOAuth(pool, "someone@example.com", "invite_only"), false);
});

test("existing users remain admitted after switching registration off", async () => {
  const pool = { query: async () => ({ rows: [{}], rowCount: 1 }) } as unknown as Pool;
  assert.equal(await canSignInWithOAuth(pool, "member@example.com", "invite_only"), true);
});

test("an established OAuth account still signs in after its verified email changes", async () => {
  const pool = { query: async (sql: string) => {
    assert.match(sql, /FROM accounts/);
    return { rows: [{}], rowCount: 1 };
  } } as unknown as Pool;
  assert.equal(await canSignInWithOAuth(pool, "changed@example.com", "invite_only", { provider: "github", providerAccountId: "123" }), true);
});

test("adapter rejects missing verification before opening a DB connection", async () => {
  const pool = { connect: async () => { throw new Error("must not access DB"); } } as unknown as Pool;
  for (const verified of [undefined, false]) {
    await assert.rejects(createOAuthMember(pool, { email: "member@example.com", toardEmailVerified: verified }), /VERIFIED_EMAIL_REQUIRED/);
  }
});

test("admission is rechecked during createUser and cannot outlive the invitation", async () => {
  const calls: string[] = [];
  let released = false;
  const pool = { connect: async () => ({
    query: async (sql: string) => { calls.push(sql); return { rows: [], rowCount: 0 }; },
    release: () => { released = true; },
  }) } as unknown as Pool;
  await assert.rejects(createOAuthMember(pool, { email: "member@example.com", toardEmailVerified: true }, "invite_only"), /INVITATION_REQUIRED/);
  assert.equal(calls.at(-1), "ROLLBACK");
  assert.equal(calls.some((sql) => sql.includes("INSERT INTO users")), false);
  assert.equal(released, true);
});
