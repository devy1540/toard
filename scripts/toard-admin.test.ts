import assert from "node:assert/strict";
import test from "node:test";
import type { ManagedContentRuntime } from "../apps/web/lib/managed-content-runtime";
import { RewrapError } from "../apps/web/lib/provider-rewrap";
import { ServerContentMigrationError } from "../apps/web/lib/server-content-migration";
import { runCli, type AdminCliDependencies } from "./toard-admin";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";

function deps(overrides: Partial<AdminCliDependencies> = {}): AdminCliDependencies {
  return {
    async runtime() {
      return {
        registry: {
          active: { name: "local", fingerprint: "local:old" },
          migration: { name: "aws-kms", fingerprint: "aws:new" },
        },
      } as ManagedContentRuntime;
    },
    db: {
      async query(sql: string) {
        if (sql.includes("content_encryption_status")) return { rows: [{ server_records: "2", e2ee_records: "3", managed_records: "4", active_user_keys: "5", pending_user_keys: "0", retiring_user_keys: "1" }] };
        if (sql.includes("DISTINCT user_id") && sql.includes("prompt_records")) return { rows: [{ user_id: USER_A }] };
        if (sql.includes("managed_content_keys")) return { rows: [{ user_id: USER_A }, { user_id: USER_B }] };
        throw new Error("unexpected query");
      },
    },
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
    ["encryption", "rewrap-provider", "--from", "local", "--to", "aws-kms"],
    deps({ async rewrapUser() { throw new RewrapError("SECRET_IN_CODE"); } }),
  );
  assert.equal(rewrap.exitCode, 1);
  assert.match(rewrap.stderr, /REWRAP_FAILED/);
  assert.equal(rewrap.stderr.includes("SECRET_IN_CODE"), false);
});

test("migrate-server drains each ordered user and stops a zero-progress busy loop", async () => {
  const batches: string[] = [];
  const remainingByUser = new Map([[USER_A, [1, 0]], [USER_B, [2]]]);
  const custom = deps({
    db: { async query() { return { rows: [{ user_id: USER_B }, { user_id: USER_A }] }; } },
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

test("rewrap-provider requires exact configured names, continues per-user failures, and sanitizes errors", async () => {
  const result = await runCli([
    "encryption", "rewrap-provider", "--from", "local", "--to", "aws-kms",
  ], deps());
  assert.equal(result.exitCode, 1);
  assert.match(result.stdout, /migrated=1 failed=1/);
  assert.match(result.stderr, new RegExp(`${USER_B} REWRAP_FAILED`));
  assert.equal(result.stderr.includes("raw secret stack"), false);

  const wrong = await runCli([
    "encryption", "rewrap-provider", "--from", "gcp-kms", "--to", "aws-kms",
  ], deps());
  assert.equal(wrong.exitCode, 2);
});
