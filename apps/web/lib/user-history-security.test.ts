import assert from "node:assert/strict";
import test from "node:test";
import {
  getUserHistorySecurityStatus,
  type UserHistorySecurityDb,
  type UserHistorySecurityRunInContext,
} from "./user-history-security";

const USER_ID = "018f47d0-4d47-7b04-950b-7d18a86e1b43";
const managedEnv = {
  TOARD_KEY_ACTIVE_PROVIDER: "local",
  TOARD_KEY_ACTIVE_LOCAL_KEK_FILE: "/run/secrets/toard-local-kek",
};

type Fixtures = {
  keys?: Array<Record<string, unknown>>;
  counts?: Record<string, unknown>;
  account?: Record<string, unknown> | null;
  migration?: Record<string, unknown> | null;
  devices?: Array<Record<string, unknown>>;
};

function fixtureContext(fixtures: Fixtures = {}) {
  const calls: Array<{ sql: string; params?: readonly unknown[] }> = [];
  const db: UserHistorySecurityDb = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes("FROM managed_content_keys")) {
        return { rows: fixtures.keys ?? [] };
      }
      if (sql.includes("FROM prompt_records")) {
        return {
          rows: [
            fixtures.counts ?? {
              managed_records: "0",
              e2ee_records: "0",
              server_records: "0",
            },
          ],
        };
      }
      if (sql.includes("LEFT JOIN content_accounts")) {
        return {
          rows: [
            {
              account_state: fixtures.account?.state ?? null,
              recovery_confirmed_at:
                fixtures.account?.recovery_confirmed_at ?? null,
              migration_state: fixtures.migration?.state ?? null,
            },
          ],
        };
      }
      if (sql.includes("FROM content_devices")) {
        return { rows: fixtures.devices ?? [] };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  const contextUsers: string[] = [];
  const runInContext: UserHistorySecurityRunInContext = async (userId, action) => {
    contextUsers.push(userId);
    return action(db);
  };
  return { calls, contextUsers, runInContext };
}

test("configured user without a key is ready and exposes no provider material", async () => {
  const context = fixtureContext();
  const status = await getUserHistorySecurityStatus(USER_ID, {
    env: managedEnv,
    runInContext: context.runInContext,
  });

  assert.deepEqual(status, {
    managed: {
      configured: true,
      state: "ready",
      activeKeyVersion: null,
      managedRecords: 0,
    },
    legacy: null,
  });
  assert.equal("provider" in status.managed, false);
  assert.deepEqual(context.contextUsers, [USER_ID]);
  assert.equal(
    context.calls.every((call) => call.params?.[0] === USER_ID),
    true,
  );
});

test("active managed key is protected and returns only its version", async () => {
  const context = fixtureContext({
    keys: [
      {
        state: "active",
        key_version: 3,
        provider: "aws-kms",
        provider_key_ref: "secret-key-ref",
        provider_fingerprint: "aws-kms:secret",
        wrapped_user_key: Buffer.from("secret"),
      },
    ],
    counts: {
      managed_records: "4",
      e2ee_records: "0",
      server_records: "0",
    },
  });

  const status = await getUserHistorySecurityStatus(USER_ID, {
    env: managedEnv,
    runInContext: context.runInContext,
  });

  assert.deepEqual(status.managed, {
    configured: true,
    state: "protected",
    activeKeyVersion: 3,
    managedRecords: 4,
  });
  assert.doesNotMatch(JSON.stringify(status), /aws|secret|wrapped|fingerprint/i);
});

test("pending managed key takes transitioning precedence", async () => {
  const context = fixtureContext({
    keys: [
      { state: "active", key_version: 2 },
      { state: "pending", key_version: 3 },
    ],
  });

  const status = await getUserHistorySecurityStatus(USER_ID, {
    env: managedEnv,
    runInContext: context.runInContext,
  });

  assert.equal(status.managed.state, "transitioning");
  assert.equal(status.managed.activeKeyVersion, 2);
});

test("completed empty E2EE migration hides legacy details", async () => {
  const context = fixtureContext({
    account: { state: "migrated" },
    migration: { state: "complete" },
  });

  const status = await getUserHistorySecurityStatus(USER_ID, {
    env: managedEnv,
    runInContext: context.runInContext,
  });

  assert.equal(status.legacy, null);
  assert.equal(
    context.calls.some((call) => call.sql.includes("FROM content_devices")),
    false,
  );
});

test("blocked E2EE migration returns approved devices without key material", async () => {
  const context = fixtureContext({
    account: {
      state: "active",
      recovery_confirmed_at: new Date("2026-07-14T00:00:00.000Z"),
    },
    migration: { state: "blocked" },
    counts: {
      managed_records: "2",
      e2ee_records: "1",
      server_records: "0",
    },
    devices: [
      {
        id: "018f47d0-4d47-7b04-950b-7d18a86e1b44",
        kind: "shim",
        label: "MacBook",
        platform: "macos",
        last_used_at: new Date("2026-07-18T00:00:00.000Z"),
        public_key: Buffer.from("secret"),
      },
    ],
  });

  const status = await getUserHistorySecurityStatus(USER_ID, {
    env: managedEnv,
    runInContext: context.runInContext,
  });

  assert.equal(status.legacy?.state, "blocked");
  assert.equal(status.legacy?.e2eeRecords, 1);
  assert.deepEqual(status.legacy?.devices, [
    {
      id: "018f47d0-4d47-7b04-950b-7d18a86e1b44",
      kind: "shim",
      label: "MacBook",
      platform: "macos",
      lastUsedAt: new Date("2026-07-18T00:00:00.000Z"),
    },
  ]);
  assert.doesNotMatch(JSON.stringify(status), /public_key|secret|wrapped/i);
});

test("managed records without a configured provider require attention", async () => {
  const context = fixtureContext({
    counts: {
      managed_records: "1",
      e2ee_records: "0",
      server_records: "0",
    },
  });

  const status = await getUserHistorySecurityStatus(USER_ID, {
    env: {},
    runInContext: context.runInContext,
  });

  assert.deepEqual(status.managed, {
    configured: false,
    state: "attention",
    activeKeyVersion: null,
    managedRecords: 1,
  });
});

test("managed records without an active key require attention even when configured", async () => {
  const context = fixtureContext({
    counts: {
      managed_records: "1",
      e2ee_records: "0",
      server_records: "0",
    },
  });

  const status = await getUserHistorySecurityStatus(USER_ID, {
    env: managedEnv,
    runInContext: context.runInContext,
  });

  assert.deepEqual(status.managed, {
    configured: true,
    state: "attention",
    activeKeyVersion: null,
    managedRecords: 1,
  });
});

test("server-only legacy records do not load or expose E2EE recovery context", async () => {
  const context = fixtureContext({
    counts: {
      managed_records: "0",
      e2ee_records: "0",
      server_records: "1",
    },
  });

  const status = await getUserHistorySecurityStatus(USER_ID, {
    env: managedEnv,
    runInContext: context.runInContext,
  });

  assert.deepEqual(status.legacy, {
    state: "migrating",
    hasE2eeContext: false,
    e2eeRecords: 0,
    serverRecords: 1,
    recoveryConfirmedAt: null,
    devices: [],
  });
  assert.equal(
    context.calls.some((call) => call.sql.includes("FROM content_devices")),
    false,
  );
});

test("malformed key state fails closed instead of reporting a transition", async () => {
  const context = fixtureContext({
    keys: [{ state: null, key_version: 1 }],
  });

  await assert.rejects(
    getUserHistorySecurityStatus(USER_ID, {
      env: managedEnv,
      runInContext: context.runInContext,
    }),
    /USER_HISTORY_SECURITY_INVALID_KEY_STATE/,
  );
});
