import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import { Client, Pool } from "pg";
import type { ManagedContentRuntime } from "../apps/web/lib/managed-content-runtime";
import { RewrapError } from "../apps/web/lib/provider-rewrap";
import type { KeyManagementProvider } from "../apps/web/lib/key-management/types";
import { createPoolLeaseFactory, runCli } from "./toard-admin";

const execFileAsync = promisify(execFile);
const INSTALLATION_ID = "019f7250-dc4d-78fd-98e8-a5465d0f5b69";
const OLD = "local:111111111111111111111111";
const TARGET = "aws-kms:222222222222222222222222";

async function waitForPostgres(connectionString: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let last: unknown;
  while (Date.now() < deadline) {
    const client = new Client({ connectionString, connectionTimeoutMillis: 1_000 });
    try { await client.connect(); await client.query("SELECT 1"); await client.end(); return; }
    catch (error) { last = error; await client.end().catch(() => undefined); await new Promise((resolve) => setTimeout(resolve, 200)); }
  }
  throw last;
}

async function migrationUps(): Promise<string[]> {
  const names = (await readdir("migrations")).filter((name) => /^17000000\d+.*\.sql$/.test(name)).sort();
  return Promise.all(names.map(async (name) => (await readFile(`migrations/${name}`, "utf8")).split("-- Down Migration", 1)[0]!));
}

async function bootstrap(container: string): Promise<void> {
  await execFileAsync("docker", ["cp", "scripts/bootstrap-app-role.sql", `${container}:/tmp/bootstrap-app-role.sql`]);
  await execFileAsync("docker", ["exec", container, "psql", "-U", "postgres", "-d", "toard",
    "-v", "app_password=integration-password", "-f", "/tmp/bootstrap-app-role.sql"]);
}

function provider(name: "local" | "aws-kms", fingerprint: string): KeyManagementProvider {
  return {
    name,
    keyRef: `${name}:test`,
    fingerprint,
    async wrapKey() { throw new Error("unused"); },
    async unwrapKey() { throw new Error("unused"); },
    async healthCheck() { return { status: "healthy", latencyMs: 0, checkedAt: new Date() }; },
    async describeCredentialSource() { return { kind: "test", staticCredential: false }; },
  };
}

test("provider migration audit authenticates the DB admin actor and completes only after aggregate readiness", { timeout: 180_000 }, async () => {
  const container = `toard-provider-audit-${randomUUID().slice(0, 8)}`;
  let admin: Client | null = null;
  let pool: Pool | null = null;
  try {
    await execFileAsync("docker", ["run", "-d", "--rm", "--name", container,
      "-e", "POSTGRES_PASSWORD=postgres", "-e", "POSTGRES_DB=toard",
      "-p", "127.0.0.1::5432", "postgres:16-alpine"]);
    const { stdout } = await execFileAsync("docker", ["port", container, "5432/tcp"]);
    const port = stdout.trim().match(/:(\d+)$/)?.[1];
    assert.ok(port);
    const adminUrl = `postgresql://postgres:postgres@127.0.0.1:${port}/toard`;
    await waitForPostgres(adminUrl);
    admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    for (const sql of await migrationUps()) await admin.query(sql);
    await bootstrap(container);

    const actor = randomUUID();
    const member = randomUUID();
    const missing = randomUUID();
    await admin.query(
      "INSERT INTO users(id,email,role) VALUES($1,'actor@example.com','admin'),($2,'member@example.com','member')",
      [actor, member],
    );
    pool = new Pool({
      connectionString: `postgresql://toard_app:integration-password@127.0.0.1:${port}/toard`,
      max: 2,
    });
    const runtime = {
      installationId: INSTALLATION_ID,
      registry: { active: provider("local", OLD), migration: provider("aws-kms", TARGET) },
    } as ManagedContentRuntime;
    const base = {
      runtime: async () => runtime,
      acquireDb: createPoolLeaseFactory(pool),
      loadLegacyKek: () => Buffer.alloc(32),
      migrateServerBatch: async () => { throw new Error("unused"); },
      close: async () => {},
    };
    const command = (actorId: string) => [
      "encryption", "rewrap-provider", "--from", "local", "--to", "aws-kms",
      "--actor-user-id", actorId,
    ];

    const zero = await runCli(command(actor), {
      ...base,
      rewrapUser: async () => { throw new Error("zero-user must not rewrap"); },
    });
    assert.equal(zero.exitCode, 0, zero.stderr);
    assert.deepEqual((await admin.query(
      "SELECT event_type,actor_user_id::text,provider,provider_fingerprint,app_instance_id FROM content_key_security_events ORDER BY id",
    )).rows, [
      { event_type: "provider_migration_started", actor_user_id: actor, provider: "aws-kms", provider_fingerprint: TARGET, app_instance_id: INSTALLATION_ID },
      { event_type: "provider_migration_completed", actor_user_id: actor, provider: "aws-kms", provider_fingerprint: TARGET, app_instance_id: INSTALLATION_ID },
    ]);
    await admin.query("DELETE FROM content_key_security_events");

    for (const invalidActor of [member, missing]) {
      const invalid = await runCli(command(invalidActor), {
        ...base,
        rewrapUser: async () => { throw new Error("must not enumerate"); },
      });
      assert.equal(invalid.exitCode, 1);
      assert.equal((await admin.query("SELECT COUNT(*)::int AS count FROM content_key_security_events")).rows[0].count, 0);
      assert.doesNotMatch(invalid.stdout + invalid.stderr, new RegExp(invalidActor));
    }

    const wrappedUser = randomUUID();
    await admin.query("INSERT INTO users(id,email) VALUES($1,'wrapped@example.com')", [wrappedUser]);
    await admin.query(
      `INSERT INTO managed_content_keys
         (user_id,key_version,provider,provider_key_ref,provider_fingerprint,wrapped_user_key,wrapper_metadata,state)
       VALUES($1,1,'local','local:test',$2,$3,'{}','active')`,
      [wrappedUser, OLD, Buffer.alloc(64, 0x42)],
    );
    const failed = await runCli(command(actor), {
      ...base,
      rewrapUser: async () => { throw new RewrapError("REWRAP_FAILED"); },
    });
    assert.equal(failed.exitCode, 1);
    assert.deepEqual((await admin.query("SELECT event_type FROM content_key_security_events ORDER BY id")).rows,
      [{ event_type: "provider_migration_started" }]);
    await admin.query("DELETE FROM content_key_security_events");

    const notReady = await runCli(command(actor), {
      ...base,
      rewrapUser: async () => ({ state: "migrated" as const }),
    });
    assert.equal(notReady.exitCode, 1);
    assert.deepEqual((await admin.query("SELECT event_type FROM content_key_security_events ORDER BY id")).rows,
      [{ event_type: "provider_migration_started" }]);
    assert.doesNotMatch(notReady.stdout + notReady.stderr, /actor@example|integration-password|local:test/i);
  } finally {
    await pool?.end().catch(() => undefined);
    await admin?.end().catch(() => undefined);
    await execFileAsync("docker", ["rm", "-f", container]).catch(() => undefined);
  }
});
