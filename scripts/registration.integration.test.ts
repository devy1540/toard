import assert from "node:assert/strict";
import test from "node:test";
import { createOAuthMember, canSignInWithOAuth } from "../apps/web/lib/registration";
import { acceptInvite, createInvite } from "../apps/web/lib/invites";
import { startTestPostgres } from "./test-support/postgres";

test("registration and invitation boundaries on PostgreSQL", { timeout: 120_000 }, async (t) => {
  const db = await startTestPostgres("registration");
  try {
    const admin = (await db.pool.query<{ id: string }>(
      "INSERT INTO users(email, role) VALUES ('admin@example.com', 'admin') RETURNING id",
    )).rows[0]!.id;
    const team = (await db.pool.query<{ id: string }>(
      "INSERT INTO teams(name) VALUES ('Invited team') RETURNING id",
    )).rows[0]!.id;
    const invite = async (email: string) => {
      const result = await createInvite(email, "member", team, admin, db.pool);
      assert.ok(result.ok);
      return result.token;
    };

    await t.test("uninvited domain claim never creates a user", async () => {
      assert.equal(await canSignInWithOAuth(db.pool, "uninvited@example.com", "invite_only"), false);
      await assert.rejects(createOAuthMember(db.pool, { email: "uninvited@example.com", toardEmailVerified: true }, "invite_only"), /INVITATION_REQUIRED/);
      assert.equal((await db.pool.query("SELECT 1 FROM users WHERE email='uninvited@example.com'")).rowCount, 0);
    });

    await t.test("verified OAuth consumes exactly one invitation and applies its role and team", async () => {
      const token = await invite("oauth@example.com");
      assert.equal(await canSignInWithOAuth(db.pool, "oauth@example.com", "invite_only"), true);
      await assert.rejects(createOAuthMember(db.pool, { email: "oauth@example.com", toardEmailVerified: false }, "invite_only"), /VERIFIED_EMAIL_REQUIRED/);
      const user = await createOAuthMember(db.pool, {
        email: "OAUTH@example.com", toardEmailVerified: true, role: "admin", teamId: "attacker-supplied",
      } as Parameters<typeof createOAuthMember>[1], "invite_only");
      const stored = (await db.pool.query("SELECT role, team_id, \"emailVerified\" FROM users WHERE id=$1", [user.id])).rows[0];
      assert.equal(stored.role, "member");
      assert.equal(stored.team_id, team);
      assert.ok(stored.emailVerified);
      assert.equal((await db.pool.query("SELECT team_id FROM user_team_assignments WHERE user_id=$1", [user.id])).rows[0].team_id, team);
      assert.equal(await acceptInvite(token, "Duplicate", "unused-test-hash", db.pool), null);
    });

    await t.test("concurrent password and OAuth acceptance grant one account only", async () => {
      const token = await invite("racing@example.com");
      const results = await Promise.allSettled([
        acceptInvite(token, "Invited", "test-hash", db.pool),
        createOAuthMember(db.pool, { email: "racing@example.com", toardEmailVerified: true }, "invite_only"),
      ]);
      assert.equal(results.filter((r) => r.status === "fulfilled" && r.value !== null).length, 1);
      assert.equal((await db.pool.query("SELECT 1 FROM users WHERE email='racing@example.com'")).rowCount, 1);
      assert.equal((await db.pool.query("SELECT 1 FROM invites WHERE email='racing@example.com' AND accepted_at IS NOT NULL")).rowCount, 1);
      assert.equal((await db.pool.query("SELECT 1 FROM user_team_assignments a JOIN users u ON u.id=a.user_id WHERE u.email='racing@example.com'")).rowCount, 1);
    });

    await t.test("expired invitation and another identity cannot consume the invitation", async () => {
      const token = await invite("expired@example.com");
      await db.pool.query("UPDATE invites SET expires_at=now()-interval '1 second' WHERE email='expired@example.com'");
      assert.equal(await acceptInvite(token, "Expired", "test-hash", db.pool), null);
      await assert.rejects(createOAuthMember(db.pool, { email: "expired@example.com", toardEmailVerified: true }, "invite_only"), /INVITATION_REQUIRED/);
      await invite("owner@example.com");
      await assert.rejects(createOAuthMember(db.pool, { email: "other@example.com", toardEmailVerified: true }, "invite_only"), /INVITATION_REQUIRED/);
      assert.equal((await db.pool.query("SELECT 1 FROM invites WHERE email='owner@example.com' AND accepted_at IS NULL")).rowCount, 1);
    });

    await t.test("explicit public OAuth registration stays unassigned and has no elevated role", async () => {
      const user = await createOAuthMember(db.pool, { email: "public@example.com", toardEmailVerified: true }, "verified_oauth");
      const stored = (await db.pool.query("SELECT role, team_id FROM users WHERE id=$1", [user.id])).rows[0];
      assert.deepEqual(stored, { role: "member", team_id: null });
      assert.equal(await canSignInWithOAuth(db.pool, user.email, "invite_only"), true);
      await assert.rejects(createOAuthMember(db.pool, { email: user.email, toardEmailVerified: true }, "verified_oauth"), /REGISTRATION_EMAIL_EXISTS/);
    });
  } finally {
    await db.close();
  }
});
