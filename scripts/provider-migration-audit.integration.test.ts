import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import { Client, Pool } from "pg";
import type { ManagedContentRuntime } from "../apps/web/lib/managed-content-runtime";
import { RewrapError } from "../apps/web/lib/provider-rewrap";
import { ManagedUserKeyService } from "../apps/web/lib/managed-user-keys";
import { UserKeyCache } from "../apps/web/lib/key-management/user-key-cache";
import { KeyProviderRegistry } from "../apps/web/lib/key-management/registry";
import type { KeyManagementProvider } from "../apps/web/lib/key-management/types";
import { createPoolLeaseFactory, runCli } from "./toard-admin";

const execFileAsync = promisify(execFile);
const INSTALLATION_ID = "019f7250-dc4d-78fd-98e8-a5465d0f5b69";
const OLD = "local:111111111111111111111111";
const TARGET = "aws-kms:222222222222222222222222";
const ROTATED_LOCAL = "local:333333333333333333333333";

async function waitUntil(predicate: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

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
      health: { async check() { return { status: "healthy" as const, latencyMs: 0, checkedAt: new Date() }; } },
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

    await admin.query("DELETE FROM managed_content_keys; DELETE FROM content_key_security_events");
    await admin.query(`
      CREATE TABLE provider_completion_proof(
        target_active bigint NOT NULL,
        old_active bigint NOT NULL,
        pending bigint NOT NULL,
        unexpected_active bigint NOT NULL
      );
      CREATE FUNCTION capture_provider_completion_proof() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
      BEGIN
        IF NEW.event_type='provider_migration_completed' THEN
          INSERT INTO provider_completion_proof
          SELECT
            COALESCE(SUM(wrapper_count) FILTER (
              WHERE provider='aws-kms' AND provider_fingerprint='${TARGET}' AND state='active'
            ),0),
            COALESCE(SUM(wrapper_count) FILTER (
              WHERE provider='local' AND provider_fingerprint='${OLD}' AND state='active'
            ),0),
            COALESCE(SUM(wrapper_count) FILTER (WHERE state='pending'),0),
            COALESCE(SUM(wrapper_count) FILTER (
              WHERE state='active' AND NOT (
                provider='aws-kms' AND provider_fingerprint='${TARGET}'
              )
            ),0)
          FROM managed_content_key_distribution;
          PERFORM pg_sleep(1);
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER capture_provider_completion_proof_trigger
      BEFORE INSERT ON content_key_security_events
      FOR EACH ROW EXECUTE FUNCTION capture_provider_completion_proof();
    `);

    const concurrentUser = randomUUID();
    await admin.query("INSERT INTO users(id,email) VALUES($1,'concurrent-old@example.com')", [concurrentUser]);
    const completing = runCli(command(actor), {
      ...base,
      rewrapUser: async () => { throw new Error("zero-user must not rewrap"); },
    });
    await waitUntil(async () => (await admin!.query(`
      SELECT EXISTS(
        SELECT 1 FROM pg_locks
         WHERE locktype='advisory' AND granted AND objid=1700000039
      ) AND EXISTS(
        SELECT 1 FROM content_key_security_events
         WHERE event_type='provider_migration_started'
      ) AS locked
    `)).rows[0].locked === true, "completion distribution advisory lock");

    let writerSettled = false;
    const writer = admin.query(
      `INSERT INTO managed_content_keys
         (user_id,key_version,provider,provider_key_ref,provider_fingerprint,wrapped_user_key,wrapper_metadata,state)
       VALUES($1,1,'local','local:concurrent',$2,$3,'{}','active')`,
      [concurrentUser, OLD, Buffer.alloc(64, 0x51)],
    ).finally(() => { writerSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(writerSettled, false, "old-wrapper writer must serialize behind completion proof");
    const completedRace = await completing;
    assert.equal(completedRace.exitCode, 0, completedRace.stderr);
    await writer;
    assert.deepEqual((await admin.query("SELECT * FROM provider_completion_proof")).rows, [{
      target_active: "0", old_active: "0", pending: "0", unexpected_active: "0",
    }]);
    assert.deepEqual((await admin.query(`
      SELECT provider,provider_fingerprint,state,wrapper_count::text
        FROM managed_content_key_distribution ORDER BY provider,provider_fingerprint,state
    `)).rows, [{
      provider: "local", provider_fingerprint: OLD, state: "active", wrapper_count: "1",
    }]);

    await admin.query("DELETE FROM managed_content_keys; DELETE FROM content_key_security_events; DELETE FROM provider_completion_proof");
    const abort = new AbortController();
    const aborting = runCli(command(actor), {
      ...base,
      signal: abort.signal,
      rewrapUser: async () => { throw new Error("zero-user must not rewrap"); },
    });
    await waitUntil(async () => (await admin!.query(`
      SELECT EXISTS(
        SELECT 1 FROM pg_locks
         WHERE locktype='advisory' AND granted AND objid=1700000039
      ) AS locked
    `)).rows[0].locked === true, "aborting completion advisory lock");
    abort.abort();
    const aborted = await aborting;
    assert.equal(aborted.exitCode, 1);
    assert.match(aborted.stderr, /INTERRUPTED/);
    assert.deepEqual((await admin.query(
      "SELECT event_type FROM content_key_security_events ORDER BY id",
    )).rows, [{ event_type: "provider_migration_started" }]);
    assert.equal((await admin.query("SELECT COUNT(*)::int AS count FROM provider_completion_proof")).rows[0].count, 0);
    assert.doesNotMatch(aborted.stdout + aborted.stderr, new RegExp(actor));

    await admin.query("DROP TRIGGER capture_provider_completion_proof_trigger ON content_key_security_events");
    runtime.registry = {
      active: provider("local", OLD),
      migration: provider("local", ROTATED_LOCAL),
    } as ManagedContentRuntime["registry"];
    const sameProvider = await runCli([
      "encryption", "rewrap-provider", "--from", "local", "--to", "local",
      "--actor-user-id", actor,
    ], {
      ...base,
      rewrapUser: async () => { throw new Error("zero-user must not rewrap"); },
    });
    assert.equal(sameProvider.exitCode, 0, sameProvider.stderr);
    assert.deepEqual((await admin.query(
      "SELECT event_type,provider,provider_fingerprint FROM content_key_security_events ORDER BY id",
    )).rows.slice(-2), [
      { event_type: "provider_migration_started", provider: "local", provider_fingerprint: ROTATED_LOCAL },
      { event_type: "provider_migration_completed", provider: "local", provider_fingerprint: ROTATED_LOCAL },
    ]);

    // writer가 start fence보다 먼저 same advisory lock을 얻으면 old insert를 commit한 뒤에만
    // start가 기록되고, fence 뒤 target-only registry restart도 새 UCK를 target으로 만든다.
    await admin.query("DELETE FROM managed_content_keys; DELETE FROM content_key_security_events");
    const oldWriterUser = randomUUID();
    const targetOnlyUser = randomUUID();
    await admin.query(
      "INSERT INTO users(id,email) VALUES($1,'fence-old@example.com'),($2,'fence-target@example.com')",
      [oldWriterUser, targetOnlyUser],
    );
    runtime.registry = {
      active: provider("local", OLD),
      migration: provider("aws-kms", TARGET),
    } as ManagedContentRuntime["registry"];
    const writerLease = await pool.connect();
    try {
      await writerLease.query("BEGIN");
      await writerLease.query("SELECT set_config('app.current_user_id',$1,true)", [oldWriterUser]);
      await writerLease.query("SELECT lock_managed_content_key_distribution()");
      const rewrappedUsers: string[] = [];
      const starting = runCli(command(actor), {
        ...base,
        rewrapUser: async (userId) => {
          rewrappedUsers.push(userId);
          throw new RewrapError("REWRAP_FAILED");
        },
      });
      await waitUntil(async () => (await admin!.query(`
        SELECT EXISTS(
          SELECT 1 FROM pg_locks
           WHERE locktype='advisory' AND objid=1700000039 AND NOT granted
        ) AS waiting
      `)).rows[0].waiting === true, "started fence waiting behind old writer");
      await writerLease.query(
        `INSERT INTO managed_content_keys
           (user_id,key_version,provider,provider_key_ref,provider_fingerprint,wrapped_user_key,wrapper_metadata,state)
         VALUES($1,1,'local','local:old-writer',$2,$3,'{}','active')`,
        [oldWriterUser, OLD, Buffer.alloc(32, 0x41)],
      );
      await writerLease.query("COMMIT");
      const started = await starting;
      assert.equal(started.exitCode, 1);
      assert.ok(rewrappedUsers.includes(oldWriterUser));
      assert.deepEqual((await admin.query(
        "SELECT event_type,provider_fingerprint FROM content_key_security_events ORDER BY id",
      )).rows, [{ event_type: "provider_migration_started", provider_fingerprint: TARGET }]);
    } finally {
      await writerLease.query("ROLLBACK").catch(() => undefined);
      writerLease.release();
    }

    const targetOnly: KeyManagementProvider = {
      name: "aws-kms",
      keyRef: "aws:target-only",
      fingerprint: TARGET,
      async wrapKey(uck) {
        return { provider: this.name, keyRef: this.keyRef, fingerprint: this.fingerprint,
          ciphertext: Buffer.from(uck), metadata: { test: "target-only" } };
      },
      async unwrapKey(wrapped) { return Buffer.from(wrapped.ciphertext); },
      async healthCheck() { return { status: "healthy", latencyMs: 0, checkedAt: new Date() }; },
      async describeCredentialSource() { return { kind: "test", staticCredential: false }; },
    };
    const targetOnlyKeys = new ManagedUserKeyService({
      installationId: INSTALLATION_ID,
      registry: new KeyProviderRegistry(targetOnly, null),
      cache: new UserKeyCache({ ttlMs: 60_000 }),
      runInUserContext: async (userId, fn) => {
        const client = await pool!.connect();
        let began = false;
        try {
          await client.query("BEGIN");
          began = true;
          await client.query("SELECT set_config('app.current_user_id',$1,true)", [userId]);
          const value = await fn(client);
          await client.query("COMMIT");
          return value;
        } catch (error) {
          if (began) await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      },
    });
    await targetOnlyKeys.withActiveUserKey(targetOnlyUser, () => undefined);
    assert.deepEqual((await admin.query(
      "SELECT user_id::text,provider_fingerprint,state FROM managed_content_keys WHERE user_id IN ($1,$2) ORDER BY user_id",
      [oldWriterUser, targetOnlyUser],
    )).rows, [
      { user_id: oldWriterUser, provider_fingerprint: OLD, state: "active" },
      { user_id: targetOnlyUser, provider_fingerprint: TARGET, state: "active" },
    ].sort((left, right) => left.user_id.localeCompare(right.user_id)));
  } finally {
    await pool?.end().catch(() => undefined);
    await admin?.end().catch(() => undefined);
    await execFileAsync("docker", ["rm", "-f", container]).catch(() => undefined);
  }
});
