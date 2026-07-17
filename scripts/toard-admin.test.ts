import assert from "node:assert/strict";
import test from "node:test";
import type { ManagedContentRuntime } from "../apps/web/lib/managed-content-runtime";
import { RewrapError } from "../apps/web/lib/provider-rewrap";
import { ServerContentMigrationError } from "../apps/web/lib/server-content-migration";
import { runCli, type AdminCliDependencies, type AdminDbLease } from "./toard-admin";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const OLD_FINGERPRINT = "local:111111111111111111111111";
const TARGET_FINGERPRINT = "aws-kms:222222222222222222222222";
const ROTATED_LOCAL_FINGERPRINT = "local:333333333333333333333333";

function deps(overrides: Partial<AdminCliDependencies> = {}): AdminCliDependencies {
  let currentUser: string | null = null;
  const db = {
    async query(sql: string, params: unknown[] = []) {
      if (sql.includes("content_encryption_status")) return { rows: [{
        server_records: "2", e2ee_records: "3", managed_records: "4",
        active_user_keys: "5", pending_user_keys: "0", retiring_user_keys: "1",
        wrapper_distribution: [
          { provider: "local", provider_fingerprint: OLD_FINGERPRINT, state: "active", wrapper_count: "5" },
          { provider: "local", provider_fingerprint: OLD_FINGERPRINT, state: "retiring", wrapper_count: "1" },
        ],
      }] };
      if (/SELECT EXISTS[\s\S]*role='admin'/i.test(sql)) return { rows: [{ is_admin: currentUser === USER_A }] };
      if (/INSERT INTO content_key_security_events/i.test(sql)) return { rows: [], rowCount: 1 };
      if (sql.includes("FROM users")) return { rows: [{ id: USER_B }, { id: USER_A }] };
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
      if (sql.startsWith("SELECT set_config")) { currentUser = String(params[0]); return { rows: [] }; }
      if (sql.includes("SELECT EXISTS") && (sql.includes("prompt_records") || sql.includes("managed_content_keys"))) {
        assert.equal(params[0], currentUser);
        return { rows: [{ eligible: true }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  return {
    async runtime() {
      return {
        installationId: "019f7250-dc4d-78fd-98e8-a5465d0f5b69",
        registry: {
          active: { name: "local", fingerprint: OLD_FINGERPRINT },
          migration: { name: "aws-kms", fingerprint: TARGET_FINGERPRINT },
        },
      } as ManagedContentRuntime;
    },
    async acquireDb(): Promise<AdminDbLease> { return { db, release() {} }; },
    loadLegacyKek: () => Buffer.alloc(32, 0x42),
    async migrateServerBatch() { return { migrated: 1, remaining: 0 }; },
    async rewrapUser(userId) {
      if (userId === USER_B) throw Object.assign(new Error("raw secret stack"), { code: "not-trusted" });
      return { state: "migrated" };
    },
    async close() {},
    ...overrides,
  };
}

test("CLI accepts exact commands and status emits aggregate counts only", async () => {
  process.env.TOARD_CONTENT_KEK_B64 = "TOP-SECRET-ENV";
  const result = await runCli(["encryption", "status"], deps());
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    activeUserKeys: 5,
    e2eeRecords: 3,
    managedRecords: 4,
    pendingUserKeys: 0,
    retiringUserKeys: 1,
    serverRecords: 2,
    wrapperDistribution: [
      { provider: "local", providerFingerprint: OLD_FINGERPRINT, state: "active", count: 5 },
      { provider: "local", providerFingerprint: OLD_FINGERPRINT, state: "retiring", count: 1 },
    ],
    providerMigration: {
      old: { provider: "local", providerFingerprint: OLD_FINGERPRINT },
      target: { provider: "aws-kms", providerFingerprint: TARGET_FINGERPRINT },
      totalActiveWrappers: 5,
      oldActiveWrappers: 5,
      targetActiveWrappers: 0,
      pendingWrappers: 0,
      unexpectedActiveWrappers: 0,
      removalReady: false,
    },
  });
  assert.equal(result.stdout.includes("TOP-SECRET-ENV"), false);
  assert.equal(result.stderr, "");
});

test("CLI rejects unknown, duplicate, missing, and extra arguments with usage exit 2", async () => {
  const invalid = [
    ["encryption", "unknown"],
    ["encryption", "status", "extra"],
    ["encryption", "migrate-server"],
    ["encryption", "migrate-server", "--batch-size", "25", "--batch-size", "25"],
    ["encryption", "migrate-server", "--batch-size", "0"],
    ["encryption", "migrate-server", "--batch-size", "1e1"],
    ["encryption", "migrate-server", "--batch-size", "01"],
    ["encryption", "migrate-server", "--batch-size", "+1"],
    ["encryption", "migrate-server", "--batch-size", " 1"],
    ["encryption", "rewrap-provider", "--from", "local", "--to"],
    ["encryption", "rewrap-provider", "--from", "local", "--from", "local", "--to", "aws-kms"],
    ["other", "status"],
  ];
  for (const argv of invalid) {
    const result = await runCli(argv, deps());
    assert.equal(result.exitCode, 2, argv.join(" "));
    assert.match(result.stderr, /^Usage:/);
  }
});

test("CLI never prints arbitrary codes even when exported error classes are constructed directly", async () => {
  const server = await runCli(
    ["encryption", "migrate-server", "--batch-size", "25"],
    deps({ async migrateServerBatch() { throw new ServerContentMigrationError("SECRET_IN_CODE"); } }),
  );
  assert.equal(server.exitCode, 1);
  assert.match(server.stderr, /SERVER_MIGRATION_FAILED/);
  assert.equal(server.stderr.includes("SECRET_IN_CODE"), false);

  const rewrap = await runCli(
    ["encryption", "rewrap-provider", "--from", "local", "--to", "aws-kms", "--actor-user-id", USER_A],
    deps({ async rewrapUser() { throw new RewrapError("SECRET_IN_CODE"); } }),
  );
  assert.equal(rewrap.exitCode, 1);
  assert.match(rewrap.stderr, /REWRAP_FAILED/);
  assert.equal(rewrap.stderr.includes("SECRET_IN_CODE"), false);
  assert.equal(rewrap.stderr.includes(USER_A), false, "authenticated actor must never be printed");
});

test("plaintext wrapper rejection exposes only its fixed non-secret operational code", async () => {
  const result = await runCli(
    ["encryption", "rewrap-provider", "--from", "local", "--to", "aws-kms", "--actor-user-id", USER_A],
    deps({ async rewrapUser() { throw new RewrapError("PENDING_WRAPPER_PLAINTEXT"); } }),
  );
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /PENDING_WRAPPER_PLAINTEXT/);
});

test("migrate-server drains each ordered user and stops a zero-progress busy loop", async () => {
  const batches: string[] = [];
  const remainingByUser = new Map([[USER_A, [1, 0]], [USER_B, [2]]]);
  const custom = deps({
    async migrateServerBatch(userId, batchSize) {
      assert.equal(batchSize, 25);
      batches.push(userId);
      const remaining = remainingByUser.get(userId)!.shift()!;
      return { migrated: userId === USER_B ? 0 : 1, remaining };
    },
  });
  const result = await runCli(["encryption", "migrate-server", "--batch-size", "25"], custom);
  assert.equal(result.exitCode, 1);
  assert.deepEqual(batches, [USER_A, USER_A, USER_B]);
  assert.match(result.stderr, new RegExp(`${USER_B} ZERO_PROGRESS`));
  assert.equal(result.stderr.includes("TOP-SECRET"), false);
});

test("CLI acquires a fixed client lease for enumeration and each atomic user operation and releases on failure", async () => {
  let acquired = 0;
  let released = 0;
  const seenDbs = new Set<object>();
  let currentUser: string | null = null;
  const acquireDb = async (): Promise<AdminDbLease> => {
    acquired += 1;
    const db = {
      async query(sql: string, params: unknown[] = []) {
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
        if (sql.startsWith("SELECT set_config")) { currentUser = String(params[0]); return { rows: [] }; }
        if (/SELECT EXISTS[\s\S]*role='admin'/i.test(sql)) return { rows: [{ is_admin: currentUser === USER_A }] };
        if (/INSERT INTO content_key_security_events/i.test(sql)) return { rows: [], rowCount: 1 };
        if (sql.includes("FROM users")) return { rows: [{ id: USER_A }, { id: USER_B }] };
        if (sql.includes("SELECT EXISTS")) return { rows: [{ eligible: true }] };
        throw new Error(`unexpected query: ${sql}`);
      },
    };
    seenDbs.add(db);
    return { db, release() { released += 1; } };
  };
  const result = await runCli(
    ["encryption", "rewrap-provider", "--from", "local", "--to", "aws-kms", "--actor-user-id", USER_A],
    deps({
      acquireDb,
      async rewrapUser(userId, _runtime, db) {
        assert.equal(seenDbs.has(db), true);
        if (userId === USER_B) throw new RewrapError("REWRAP_FAILED");
        return { state: "migrated" };
      },
    }),
  );
  assert.equal(result.exitCode, 1);
  assert.equal(acquired, 4, "one audit lease, one enumeration lease, and one lease per eligible user");
  assert.equal(released, acquired);
});

test("SIGINT observed after an atomic batch stops before the next batch and user", async () => {
  const controller = new AbortController();
  const legacyKek = Buffer.alloc(32, 0x7a);
  const batches: string[] = [];
  let released = 0;
  const result = await runCli(
    ["encryption", "migrate-server", "--batch-size", "25"],
    deps({
      signal: controller.signal,
      loadLegacyKek: () => legacyKek,
      async acquireDb() {
        let currentUser: string | null = null;
        return {
          db: { async query(sql: string, params: unknown[] = []) {
            if (sql.includes("FROM users")) return { rows: [{ id: USER_A }, { id: USER_B }] };
            if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
            if (sql.startsWith("SELECT set_config")) { currentUser = String(params[0]); return { rows: [] }; }
            if (sql.includes("SELECT EXISTS")) return { rows: [{ eligible: currentUser === USER_A || currentUser === USER_B }] };
            throw new Error(`unexpected query: ${sql}`);
          } },
          release() { released += 1; },
        };
      },
      async migrateServerBatch(userId) {
        batches.push(userId);
        controller.abort();
        return { migrated: 1, remaining: 1 };
      },
    }),
  );
  assert.equal(result.exitCode, 1);
  assert.deepEqual(batches, [USER_A]);
  assert.match(result.stderr, new RegExp(`${USER_A} INTERRUPTED`));
  assert.equal(result.stderr.includes(USER_B), false);
  assert.equal(legacyKek.every((byte) => byte === 0), true);
  assert.equal(released, 2, "enumeration and first batch leases are both released");
});

test("rewrap-provider requires exact configured names, continues per-user failures, and sanitizes errors", async () => {
  const result = await runCli([
    "encryption", "rewrap-provider", "--from", "local", "--to", "aws-kms", "--actor-user-id", USER_A,
  ], deps());
  assert.equal(result.exitCode, 1);
  assert.match(result.stdout, /migrated=1 failed=1/);
  assert.match(result.stderr, /REWRAP_FAILED/);
  assert.doesNotMatch(result.stderr, new RegExp(`${USER_A}|${USER_B}`));
  assert.equal(result.stderr.includes("raw secret stack"), false);

  const wrong = await runCli([
    "encryption", "rewrap-provider", "--from", "gcp-kms", "--to", "aws-kms", "--actor-user-id", USER_A,
  ], deps());
  assert.equal(wrong.exitCode, 2);
});

test("rewrap-provider requires an exact admin actor and records started before enumeration plus completed after readiness", async () => {
  const events: Array<{ type: string; appInstanceId: string }> = [];
  let enumerated = false;
  let installationReads = 0;
  const zeroUser = deps({
    async runtime() {
      const current = {
        registry: {
          active: { name: "local", fingerprint: OLD_FINGERPRINT },
          migration: { name: "aws-kms", fingerprint: TARGET_FINGERPRINT },
        },
      } as ManagedContentRuntime;
      Object.defineProperty(current, "installationId", {
        get() {
          installationReads += 1;
          return installationReads === 1
            ? "019f7250-dc4d-78fd-98e8-a5465d0f5b69"
            : "029f7250-dc4d-78fd-98e8-a5465d0f5b69";
        },
      });
      return current;
    },
    async acquireDb() {
      return {
        db: { async query(sql: string, params: unknown[] = []) {
          if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
          if (sql.startsWith("SELECT set_config")) return { rows: [] };
          if (/SELECT EXISTS[\s\S]*role='admin'/i.test(sql)) return { rows: [{ is_admin: true }] };
          if (/lock_managed_content_key_distribution/i.test(sql)) return { rows: [{}] };
          if (/INSERT INTO content_key_security_events/i.test(sql)) {
            events.push({ type: String(params[0]), appInstanceId: String(params[6]) });
            return { rows: [], rowCount: 1 };
          }
          if (/FROM users/i.test(sql)) { enumerated = true; return { rows: [] }; }
          if (/FROM managed_content_key_distribution/i.test(sql)) return { rows: [{ wrapper_distribution: [] }] };
          if (/FROM content_encryption_status/i.test(sql)) return { rows: [{
            server_records: "0", e2ee_records: "0", managed_records: "0",
            active_user_keys: "0", pending_user_keys: "0", retiring_user_keys: "0",
            wrapper_distribution: [],
          }] };
          throw new Error(`unexpected query: ${sql}`);
        } },
        release() {},
      };
    },
  });

  const missingActor = await runCli(
    ["encryption", "rewrap-provider", "--from", "local", "--to", "aws-kms"],
    zeroUser,
  );
  assert.equal(missingActor.exitCode, 2);

  const result = await runCli([
    "encryption", "rewrap-provider", "--from", "local", "--to", "aws-kms",
    "--actor-user-id", USER_A,
  ], zeroUser);
  assert.equal(result.exitCode, 0);
  assert.equal(enumerated, true);
  assert.deepEqual(events, [
    { type: "provider_migration_started", appInstanceId: "019f7250-dc4d-78fd-98e8-a5465d0f5b69" },
    { type: "provider_migration_completed", appInstanceId: "019f7250-dc4d-78fd-98e8-a5465d0f5b69" },
  ]);
  assert.match(result.stdout, /migrated=0 failed=0/);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(USER_A));
});

test("non-admin, failure, interrupt, not-ready, and audit failure never record provider_migration_completed", async () => {
  async function scenario(options: {
    admin?: boolean;
    failAudit?: boolean;
    failCompletedAudit?: boolean;
    failUser?: boolean;
    interrupted?: boolean;
    ready?: boolean;
  }): Promise<{ result: Awaited<ReturnType<typeof runCli>>; events: string[]; enumerations: number }> {
    const events: string[] = [];
    let enumerations = 0;
    const controller = new AbortController();
    const custom = deps({
      signal: controller.signal,
      async runtime() {
        return {
          installationId: "019f7250-dc4d-78fd-98e8-a5465d0f5b69",
          registry: {
            active: { name: "local", fingerprint: OLD_FINGERPRINT },
            migration: { name: "aws-kms", fingerprint: TARGET_FINGERPRINT },
          },
        } as ManagedContentRuntime;
      },
      async acquireDb() {
        let currentUser: string | null = null;
        return {
          db: { async query(sql: string, params: unknown[] = []) {
            if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
            if (sql.startsWith("SELECT set_config")) { currentUser = String(params[0]); return { rows: [] }; }
            if (/SELECT EXISTS[\s\S]*role='admin'/i.test(sql)) return { rows: [{ is_admin: options.admin !== false && currentUser === USER_A }] };
            if (/lock_managed_content_key_distribution/i.test(sql)) return { rows: [{}] };
            if (/INSERT INTO content_key_security_events/i.test(sql)) {
              if (
                options.failAudit
                || (options.failCompletedAudit && params[0] === "provider_migration_completed")
              ) throw new Error("token=audit-secret");
              events.push(String(params[0]));
              if (options.interrupted && params[0] === "provider_migration_started") controller.abort();
              return { rows: [], rowCount: 1 };
            }
            if (/FROM users/i.test(sql)) { enumerations += 1; return { rows: [{ id: USER_B }] }; }
            if (/SELECT EXISTS/i.test(sql)) return { rows: [{ eligible: true }] };
            if (/FROM managed_content_key_distribution/i.test(sql)) return { rows: [{
              wrapper_distribution: options.ready === false
                ? [{ provider: "local", provider_fingerprint: OLD_FINGERPRINT, state: "active", wrapper_count: "1" }]
                : [
                    { provider: "aws-kms", provider_fingerprint: TARGET_FINGERPRINT, state: "active", wrapper_count: "1" },
                    { provider: "local", provider_fingerprint: OLD_FINGERPRINT, state: "retiring", wrapper_count: "1" },
                  ],
            }] };
            if (/FROM content_encryption_status/i.test(sql)) return { rows: [{
              server_records: "0", e2ee_records: "0", managed_records: "0",
              active_user_keys: "1", pending_user_keys: "0", retiring_user_keys: "1",
              wrapper_distribution: options.ready === false
                ? [{ provider: "local", provider_fingerprint: OLD_FINGERPRINT, state: "active", wrapper_count: "1" }]
                : [
                    { provider: "aws-kms", provider_fingerprint: TARGET_FINGERPRINT, state: "active", wrapper_count: "1" },
                    { provider: "local", provider_fingerprint: OLD_FINGERPRINT, state: "retiring", wrapper_count: "1" },
                  ],
            }] };
            throw new Error(`unexpected query: ${sql}`);
          } },
          release() {},
        };
      },
      async rewrapUser() {
        if (options.failUser) throw new Error("credential=user-secret");
        return { state: "migrated" };
      },
    });
    const result = await runCli([
      "encryption", "rewrap-provider", "--from", "local", "--to", "aws-kms",
      "--actor-user-id", USER_A,
    ], custom);
    assert.doesNotMatch(result.stdout + result.stderr, /audit-secret|user-secret|credential=|token=/i);
    return { result, events, enumerations };
  }

  const nonAdmin = await scenario({ admin: false });
  assert.equal(nonAdmin.result.exitCode, 1);
  assert.equal(nonAdmin.enumerations, 0);
  assert.deepEqual(nonAdmin.events, []);

  for (const options of [
    { failAudit: true },
    { failCompletedAudit: true },
    { failUser: true },
    { interrupted: true },
    { ready: false },
  ]) {
    const observed = await scenario(options);
    assert.equal(observed.result.exitCode, 1);
    assert.equal(observed.events.includes("provider_migration_completed"), false);
    if ("failCompletedAudit" in options) {
      assert.deepEqual(observed.events, ["provider_migration_started"]);
    }
  }
});

test("an interrupt observed during zero-user enumeration leaves started without completed", async () => {
  const controller = new AbortController();
  const events: string[] = [];
  let currentUser: string | null = null;
  const result = await runCli([
    "encryption", "rewrap-provider", "--from", "local", "--to", "aws-kms",
    "--actor-user-id", USER_A,
  ], deps({
    signal: controller.signal,
    async acquireDb() {
      return { db: { async query(sql: string, params: unknown[] = []) {
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
        if (sql.startsWith("SELECT set_config")) { currentUser = String(params[0]); return { rows: [] }; }
        if (/SELECT EXISTS[\s\S]*role='admin'/i.test(sql)) return { rows: [{ is_admin: currentUser === USER_A }] };
        if (/INSERT INTO content_key_security_events/i.test(sql)) {
          events.push(String(params[0]));
          return { rows: [], rowCount: 1 };
        }
        if (/FROM users/i.test(sql)) { controller.abort(); return { rows: [] }; }
        if (/FROM content_encryption_status/i.test(sql)) return { rows: [{
          server_records: "0", e2ee_records: "0", managed_records: "0",
          active_user_keys: "0", pending_user_keys: "0", retiring_user_keys: "0",
          wrapper_distribution: [],
        }] };
        throw new Error(`unexpected query: ${sql}`);
      } }, release() {} };
    },
  }));
  assert.equal(result.exitCode, 1);
  assert.deepEqual(events, ["provider_migration_started"]);
  assert.match(result.stderr, /INTERRUPTED/);
});

test("same-provider key-ref rotation is accepted only when runtime fingerprints differ", async () => {
  const events: string[] = [];
  let currentUser: string | null = null;
  const rotated = deps({
    async runtime() {
      return {
        installationId: "019f7250-dc4d-78fd-98e8-a5465d0f5b69",
        registry: {
          active: { name: "local", fingerprint: OLD_FINGERPRINT },
          migration: { name: "local", fingerprint: ROTATED_LOCAL_FINGERPRINT },
        },
      } as ManagedContentRuntime;
    },
    async acquireDb() {
      return { db: { async query(sql: string, params: unknown[] = []) {
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
        if (sql.startsWith("SELECT set_config")) { currentUser = String(params[0]); return { rows: [] }; }
        if (/SELECT EXISTS[\s\S]*role='admin'/i.test(sql)) return { rows: [{ is_admin: currentUser === USER_A }] };
        if (/lock_managed_content_key_distribution/i.test(sql)) return { rows: [{}] };
        if (/FROM managed_content_key_distribution/i.test(sql)) return { rows: [{ wrapper_distribution: [] }] };
        if (/INSERT INTO content_key_security_events/i.test(sql)) {
          events.push(String(params[0]));
          return { rows: [], rowCount: 1 };
        }
        if (/FROM users/i.test(sql)) return { rows: [] };
        throw new Error(`unexpected query: ${sql}`);
      } }, release() {} };
    },
  });

  const rotatedResult = await runCli([
    "encryption", "rewrap-provider", "--from", "local", "--to", "local",
    "--actor-user-id", USER_A,
  ], rotated);
  assert.equal(rotatedResult.exitCode, 0, rotatedResult.stderr);
  assert.deepEqual(events, ["provider_migration_started", "provider_migration_completed"]);

  const duplicate = await runCli([
    "encryption", "rewrap-provider", "--from", "local", "--to", "local",
    "--actor-user-id", USER_A,
  ], deps({
    async runtime() {
      return {
        installationId: "019f7250-dc4d-78fd-98e8-a5465d0f5b69",
        registry: {
          active: { name: "local", fingerprint: OLD_FINGERPRINT },
          migration: { name: "local", fingerprint: OLD_FINGERPRINT },
        },
      } as ManagedContentRuntime;
    },
  }));
  assert.notEqual(duplicate.exitCode, 0);
  assert.doesNotMatch(duplicate.stdout + duplicate.stderr, new RegExp(USER_A));
});

test("abort after the last user or during completion readiness leaves only started", async () => {
  for (const abortAt of ["last-user", "distribution", "completed-insert"] as const) {
    const controller = new AbortController();
    const committedEvents: string[] = [];
    let pendingEvents: string[] = [];
    let currentUser: string | null = null;
    const result = await runCli([
      "encryption", "rewrap-provider", "--from", "local", "--to", "aws-kms",
      "--actor-user-id", USER_A,
    ], deps({
      signal: controller.signal,
      async acquireDb() {
        return { db: { async query(sql: string, params: unknown[] = []) {
          if (sql === "BEGIN") { pendingEvents = []; return { rows: [] }; }
          if (sql === "COMMIT") { committedEvents.push(...pendingEvents); pendingEvents = []; return { rows: [] }; }
          if (sql === "ROLLBACK") { pendingEvents = []; return { rows: [] }; }
          if (sql.startsWith("SELECT set_config")) { currentUser = String(params[0]); return { rows: [] }; }
          if (/SELECT EXISTS[\s\S]*role='admin'/i.test(sql)) return { rows: [{ is_admin: currentUser === USER_A }] };
          if (/lock_managed_content_key_distribution/i.test(sql)) return { rows: [{}] };
          if (/FROM managed_content_key_distribution/i.test(sql)) {
            if (abortAt === "distribution") controller.abort();
            return { rows: [{ wrapper_distribution: [
              { provider: "aws-kms", provider_fingerprint: TARGET_FINGERPRINT, state: "active", wrapper_count: "1" },
              { provider: "local", provider_fingerprint: OLD_FINGERPRINT, state: "retiring", wrapper_count: "1" },
            ] }] };
          }
          if (/INSERT INTO content_key_security_events/i.test(sql)) {
            pendingEvents.push(String(params[0]));
            if (abortAt === "completed-insert" && params[0] === "provider_migration_completed") controller.abort();
            return { rows: [], rowCount: 1 };
          }
          if (/FROM users/i.test(sql)) return { rows: [{ id: USER_A }] };
          if (/SELECT EXISTS/i.test(sql)) return { rows: [{ eligible: true }] };
          throw new Error(`unexpected query: ${sql}`);
        } }, release() {} };
      },
      async rewrapUser() {
        if (abortAt === "last-user") controller.abort();
        return { state: "migrated" };
      },
    }));
    assert.equal(result.exitCode, 1, abortAt);
    assert.deepEqual(committedEvents, ["provider_migration_started"], abortAt);
    assert.match(result.stderr, /INTERRUPTED/, abortAt);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(USER_A));
  }
});
