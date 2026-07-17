import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import { Client } from "pg";
import { ManagedUserKeyService } from "../apps/web/lib/managed-user-keys";
import { UserKeyCache } from "../apps/web/lib/key-management/user-key-cache";
import { KeyProviderRegistry } from "../apps/web/lib/key-management/registry";
import type { KeyManagementProvider } from "../apps/web/lib/key-management/types";

const execFileAsync = promisify(execFile);
const MIGRATION = "migrations/1700000040_managed_content_write_fence.sql";
const TARGET_A = "aws-kms:222222222222222222222222";
const TARGET_B = "gcp-kms:333333333333333333333333";

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

async function migrationUpsBefore40(): Promise<string[]> {
  const names = (await readdir("migrations"))
    .filter((name) => /^(\d+)_.*\.sql$/.test(name) && name < "1700000040")
    .sort();
  return Promise.all(names.map(async (name) => (
    await readFile(`migrations/${name}`, "utf8")
  ).split("-- Down Migration", 1)[0]!));
}

async function migrationUpsBefore(version: string): Promise<string[]> {
  const names = (await readdir("migrations"))
    .filter((name) => /^(\d+)_.*\.sql$/.test(name) && name < version)
    .sort();
  return Promise.all(names.map(async (name) => (
    await readFile(`migrations/${name}`, "utf8")
  ).split("-- Down Migration", 1)[0]!));
}

async function migrationUp(version: string): Promise<string> {
  return (await readFile(`migrations/${version}`, "utf8")).split("-- Down Migration", 1)[0]!;
}

async function migrationDown(version: string): Promise<string> {
  return (await readFile(`migrations/${version}`, "utf8")).split("-- Down Migration", 2)[1]!;
}

function provider(name: "local" | "aws-kms", fingerprint: string): KeyManagementProvider {
  return {
    name,
    keyRef: `${name}:test`,
    fingerprint,
    async wrapKey(uck) {
      return {
        provider: name,
        keyRef: `${name}:test`,
        fingerprint,
        ciphertext: Buffer.from(uck),
        metadata: { test: "write-fence" },
      };
    },
    async unwrapKey(wrapped) { return Buffer.from(wrapped.ciphertext); },
    async healthCheck() { return { status: "healthy", latencyMs: 0, checkedAt: new Date() }; },
    async describeCredentialSource() { return { kind: "test", staticCredential: false }; },
  };
}

async function bootstrap(container: string): Promise<void> {
  await execFileAsync("docker", ["cp", "scripts/bootstrap-app-role.sql", `${container}:/tmp/bootstrap-app-role.sql`]);
  await execFileAsync("docker", ["exec", container, "psql", "-U", "postgres", "-d", "toard",
    "-v", "app_password=integration-password", "-f", "/tmp/bootstrap-app-role.sql"]);
}

test("migration 40 exposes only latest started provider identity to toard_app and orders fences by id", { timeout: 180_000 }, async () => {
  const source = await readFile(MIGRATION, "utf8");
  const [up = "", down = ""] = source.split("-- Down Migration", 2);
  assert.ok(up && down);
  const container = `toard-write-fence-${randomUUID().slice(0, 8)}`;
  let admin: Client | null = null;
  let app: Client | null = null;
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
    for (const sql of await migrationUpsBefore40()) await admin.query(sql);
    await admin.query(up);
    await bootstrap(container);

    const actor = randomUUID();
    const member = randomUUID();
    await admin.query(
      "INSERT INTO users(id,email,role) VALUES($1,'fence-admin@example.com','admin'),($2,'fence-member@example.com','member')",
      [actor, member],
    );
    await admin.query(
      `INSERT INTO content_key_security_events
         (event_type,user_id,provider,provider_fingerprint,key_version,actor_user_id,app_instance_id)
       VALUES
         ('provider_migration_started',NULL,'aws-kms',$1,NULL,$3,'instance-a'),
         ('provider_migration_started',NULL,'gcp-kms',$2,NULL,$3,'instance-b')`,
      [TARGET_A, TARGET_B, actor],
    );

    assert.equal((await admin.query(
      "SELECT has_function_privilege('toard_app','latest_managed_content_write_fence()','EXECUTE') AS ok",
    )).rows[0].ok, true);
    assert.equal((await admin.query(
      "SELECT has_function_privilege('public','latest_managed_content_write_fence()','EXECUTE') AS ok",
    )).rows[0].ok, false);

    app = new Client({ connectionString: `postgresql://toard_app:integration-password@127.0.0.1:${port}/toard` });
    await app.connect();
    await app.query("BEGIN");
    await app.query("SELECT set_config('app.current_user_id',$1,true)", [member]);
    assert.deepEqual((await app.query("SELECT * FROM latest_managed_content_write_fence()")).rows, [{
      provider: "gcp-kms", provider_fingerprint: TARGET_B,
    }]);
    assert.deepEqual((await app.query(
      "SELECT provider,provider_fingerprint,actor_user_id FROM content_key_security_events WHERE event_type='provider_migration_started'",
    )).rows, []);
    await app.query("ROLLBACK");

    await admin.query(down);
    assert.equal((await admin.query(
      "SELECT to_regprocedure('latest_managed_content_write_fence()') IS NULL AS missing",
    )).rows[0].missing, true);
  } finally {
    await app?.end().catch(() => undefined);
    await admin?.end().catch(() => undefined);
    await execFileAsync("docker", ["rm", "-f", container]).catch(() => undefined);
  }
});

test("migration 40 fence works when migrations 37-40 are owned by a NOSUPERUSER NOBYPASSRLS role", { timeout: 180_000 }, async () => {
  const container = `toard-write-fence-owner-${randomUUID().slice(0, 8)}`;
  let admin: Client | null = null;
  let owner: Client | null = null;
  let app: Client | null = null;
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
    for (const sql of await migrationUpsBefore("1700000037")) await admin.query(sql);

    await admin.query("CREATE ROLE migration_owner LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT PASSWORD 'migration-owner-password'");
    await admin.query("ALTER SCHEMA public OWNER TO migration_owner");
    await admin.query("ALTER TABLE users OWNER TO migration_owner");
    await admin.query("ALTER TABLE managed_content_keys OWNER TO migration_owner");
    owner = new Client({ connectionString: `postgresql://migration_owner:migration-owner-password@127.0.0.1:${port}/toard` });
    await owner.connect();
    for (const version of [
      "1700000037_content_key_operations.sql",
      "1700000039_managed_key_distribution.sql",
      "1700000040_managed_content_write_fence.sql",
    ]) await owner.query(await migrationUp(version));
    assert.deepEqual((await admin.query(`
      SELECT role.rolsuper, role.rolbypassrls,
             pg_catalog.pg_get_userbyid(schema.nspowner) AS schema_owner,
             pg_catalog.pg_get_userbyid(table_relation.relowner) AS table_owner,
             pg_catalog.pg_get_userbyid(function_relation.proowner) AS function_owner
        FROM pg_catalog.pg_roles role
        CROSS JOIN pg_catalog.pg_namespace schema
        CROSS JOIN pg_catalog.pg_class table_relation
        CROSS JOIN pg_catalog.pg_proc function_relation
       WHERE role.rolname='migration_owner'
         AND schema.nspname='public'
         AND table_relation.oid='public.content_key_security_events'::pg_catalog.regclass
         AND function_relation.oid='public.latest_managed_content_write_fence()'::pg_catalog.regprocedure
    `)).rows, [{
      rolsuper: false,
      rolbypassrls: false,
      schema_owner: "migration_owner",
      table_owner: "migration_owner",
      function_owner: "migration_owner",
    }]);
    await bootstrap(container);

    const actor = randomUUID();
    const member = randomUUID();
    await admin.query(
      "INSERT INTO users(id,email,role) VALUES($1,'owner-fence-admin@example.com','admin'),($2,'owner-fence-member@example.com','member')",
      [actor, member],
    );
    await admin.query(
      `INSERT INTO content_key_security_events
         (event_type,user_id,provider,provider_fingerprint,key_version,actor_user_id,app_instance_id)
       VALUES('provider_migration_started',NULL,'aws-kms',$1,NULL,$2,'owner-fence')`,
      [TARGET_A, actor],
    );

    app = new Client({ connectionString: `postgresql://toard_app:integration-password@127.0.0.1:${port}/toard` });
    await app.connect();
    await app.query("BEGIN");
    await app.query("SELECT set_config('app.current_user_id',$1,true)", [member]);
    assert.deepEqual((await app.query("SELECT * FROM latest_managed_content_write_fence()")).rows, [{
      provider: "aws-kms", provider_fingerprint: TARGET_A,
    }]);
    assert.deepEqual((await app.query(
      "SELECT provider,provider_fingerprint,actor_user_id FROM content_key_security_events WHERE event_type='provider_migration_started'",
    )).rows, []);
    await app.query("ROLLBACK");

    const keys = new ManagedUserKeyService({
      installationId: randomUUID(),
      registry: new KeyProviderRegistry(provider("local", "local:111111111111111111111111"), provider("aws-kms", TARGET_A)),
      cache: new UserKeyCache({ ttlMs: 60_000 }),
      runInUserContext: async (userId, fn) => {
        const client = app!;
        await client.query("BEGIN");
        try {
          await client.query("SELECT set_config('app.current_user_id',$1,true)", [userId]);
          const result = await fn(client);
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      },
    });
    await keys.withActiveUserKey(member, () => undefined);
    assert.deepEqual((await admin.query(
      "SELECT provider_fingerprint FROM managed_content_keys WHERE user_id=$1",
      [member],
    )).rows, [{ provider_fingerprint: TARGET_A }]);

    await owner.query(await migrationDown("1700000040_managed_content_write_fence.sql"));
    assert.equal((await admin.query(
      `SELECT COUNT(*)::int AS count
         FROM pg_catalog.pg_policies
        WHERE schemaname='public'
          AND tablename='content_key_security_events'
          AND policyname='content_key_security_events_fence_owner_select'`,
    )).rows[0].count, 0);
  } finally {
    await app?.end().catch(() => undefined);
    await owner?.end().catch(() => undefined);
    await admin?.end().catch(() => undefined);
    await execFileAsync("docker", ["rm", "-f", container]).catch(() => undefined);
  }
});
