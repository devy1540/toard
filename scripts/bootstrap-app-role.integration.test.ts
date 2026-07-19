import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import { Client } from "pg";
import { getE2eeManagedMigrationStatus, type E2eeMigrationDb } from "../apps/web/lib/e2ee-to-managed-migration";
import { assertManagedContentDatabaseRoleReady } from "../apps/web/lib/content-database-role-readiness";
import { createManagedContentRuntimeForDatabase } from "../apps/web/lib/managed-content-runtime";
import { runCli, type AdminCliDependencies, type AdminDbLease } from "./toard-admin";

const execFileAsync = promisify(execFile);

async function execFileWithInput(file: string, args: string[], input: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr }));
    child.stdin.end(input);
  });
}

async function waitForPostgres(connectionString: string): Promise<void> {
  const deadline = Date.now() + 30_000; let last: unknown;
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

function db(client: Client): E2eeMigrationDb {
  return { async query(sql, params = []) { const result = await client.query(sql, params); return { rows: result.rows, rowCount: result.rowCount }; } };
}

const MANAGED_CONTENT_ENV = {
  TOARD_KEY_ACTIVE_PROVIDER: "aws-kms",
  TOARD_KEY_ACTIVE_AWS_KEY_ARN:
    "arn:aws:kms:ap-northeast-2:123456789012:key/12345678-1234-1234-1234-123456789012",
  TOARD_KEY_ACTIVE_AWS_REGION: "ap-northeast-2",
};

test("실제 PostgreSQL에서 managed content readiness는 app role만 허용한다", { timeout: 120_000 }, async () => {
  const container = `toard-role-readiness-${randomUUID().slice(0, 6)}`;
  let admin: Client | null = null; let app: Client | null = null;
  try {
    await execFileAsync("docker", ["run", "-d", "--rm", "--name", container,
      "-e", "POSTGRES_PASSWORD=postgres", "-e", "POSTGRES_DB=toard",
      "-p", "127.0.0.1::5432", "postgres:16-alpine"]);
    const { stdout } = await execFileAsync("docker", ["port", container, "5432/tcp"]);
    const port = stdout.trim().match(/:(\d+)$/)?.[1]; assert.ok(port);
    const connectionString = `postgresql://postgres:postgres@127.0.0.1:${port}/toard`;
    await waitForPostgres(connectionString);
    await bootstrap(container);
    admin = new Client({ connectionString }); await admin.connect();
    await admin.query("CREATE ROLE toard_bypass_readiness NOLOGIN BYPASSRLS");

    await assert.rejects(
      assertManagedContentDatabaseRoleReady(admin, MANAGED_CONTENT_ENV),
      /^Error: MANAGED_CONTENT_DATABASE_ROLE_UNSAFE$/,
    );

    await admin.query("SET ROLE toard_app");
    await assert.rejects(
      assertManagedContentDatabaseRoleReady(admin, MANAGED_CONTENT_ENV),
      /^Error: MANAGED_CONTENT_DATABASE_ROLE_UNSAFE$/,
    );
    await admin.query("RESET ROLE");

    app = new Client({
      connectionString: `postgresql://toard_app:integration-password@127.0.0.1:${port}/toard`,
    });
    await app.connect();
    await assert.doesNotReject(
      assertManagedContentDatabaseRoleReady(app, MANAGED_CONTENT_ENV),
    );

    await admin.query("CREATE ROLE toard_migration_owner NOLOGIN");
    await admin.query("GRANT toard_migration_owner TO toard_app");
    await assert.rejects(
      assertManagedContentDatabaseRoleReady(app, MANAGED_CONTENT_ENV),
      /^Error: MANAGED_CONTENT_DATABASE_ROLE_UNSAFE$/,
    );
    await admin.query("REVOKE toard_migration_owner FROM toard_app");

    await admin.query("ALTER DATABASE toard OWNER TO toard_app");
    await assert.rejects(
      assertManagedContentDatabaseRoleReady(app, MANAGED_CONTENT_ENV),
      /^Error: MANAGED_CONTENT_DATABASE_ROLE_UNSAFE$/,
    );
    await admin.query("ALTER DATABASE toard OWNER TO postgres");

    await admin.query("CREATE TABLE readiness_owned_rls (id integer)");
    await admin.query("ALTER TABLE readiness_owned_rls ENABLE ROW LEVEL SECURITY");
    await admin.query("ALTER TABLE readiness_owned_rls OWNER TO toard_app");
    await assert.rejects(
      assertManagedContentDatabaseRoleReady(app, MANAGED_CONTENT_ENV),
      /^Error: MANAGED_CONTENT_DATABASE_ROLE_UNSAFE$/,
    );

    await admin.query("SET ROLE toard_bypass_readiness");
    await assert.rejects(
      assertManagedContentDatabaseRoleReady(admin, MANAGED_CONTENT_ENV),
      /^Error: MANAGED_CONTENT_DATABASE_ROLE_UNSAFE$/,
    );
    await admin.query("RESET ROLE");
  } finally {
    await admin?.query("RESET ROLE").catch(() => undefined);
    await app?.end().catch(() => undefined);
    await admin?.end().catch(() => undefined);
    await execFileAsync("docker", ["rm", "-f", container]).catch(() => undefined);
  }
});

test("실제 PostgreSQL CLI 기본 runtime 경로는 guard 뒤 lease에서만 installation identity를 읽는다", { timeout: 120_000 }, async () => {
  const container = `toard-cli-runtime-guard-${randomUUID().slice(0, 6)}`;
  let admin: Client | null = null; let app: Client | null = null;
  try {
    await execFileAsync("docker", ["run", "-d", "--rm", "--name", container,
      "-e", "POSTGRES_PASSWORD=postgres", "-e", "POSTGRES_DB=toard",
      "-p", "127.0.0.1::5432", "postgres:16-alpine"]);
    const { stdout } = await execFileAsync("docker", ["port", container, "5432/tcp"]);
    const port = stdout.trim().match(/:(\d+)$/)?.[1]; assert.ok(port);
    const connectionString = `postgresql://postgres:postgres@127.0.0.1:${port}/toard`;
    await waitForPostgres(connectionString);
    await bootstrap(container);
    admin = new Client({ connectionString }); await admin.connect();
    for (const sql of await migrationUps()) await admin.query(sql);
    app = new Client({
      connectionString: `postgresql://toard_app:integration-password@127.0.0.1:${port}/toard`,
    });
    await app.connect();

    const sqls: string[] = [];
    let runtimeCalls = 0;
    let leaseClient = admin;
    const leaseDb = {
      async query(sql: string, params: unknown[] = []) {
        sqls.push(sql);
        return leaseClient.query(sql, params);
      },
    };
    const dependencies: AdminCliDependencies = {
      runtime(db) {
        runtimeCalls += 1;
        return createManagedContentRuntimeForDatabase(db, MANAGED_CONTENT_ENV);
      },
      async acquireDb(): Promise<AdminDbLease> { return { db: leaseDb, release() {} }; },
      assertManagedContentDatabaseRoleReady: (db) =>
        assertManagedContentDatabaseRoleReady(db, MANAGED_CONTENT_ENV),
      loadLegacyKek: () => Buffer.alloc(32),
      async migrateServerBatch() { throw new Error("unused"); },
      async rewrapUser() { throw new Error("unused"); },
      async close() {},
    };

    const unsafe = await runCli(["encryption", "status"], dependencies);
    assert.deepEqual(unsafe, { exitCode: 1, stdout: "", stderr: "ADMIN_COMMAND_FAILED\n" });
    assert.equal(runtimeCalls, 0);
    assert.equal(sqls.some((sql) => sql.includes("installation_identity")), false);

    sqls.length = 0;
    leaseClient = app;
    const safe = await runCli(["encryption", "status"], dependencies);
    assert.equal(safe.exitCode, 0, safe.stderr);
    assert.equal(runtimeCalls, 1);
    assert.match(sqls[0] ?? "", /FROM pg_roles/);
    assert.match(sqls[1] ?? "", /installation_identity/);
  } finally {
    await admin?.query("RESET ROLE").catch(() => undefined);
    await app?.end().catch(() => undefined);
    await admin?.end().catch(() => undefined);
    await execFileAsync("docker", ["rm", "-f", container]).catch(() => undefined);
  }
});

test("bootstrap script wraps every role and privilege mutation in one transaction", async () => {
  const sql = await readFile("scripts/bootstrap-app-role.sql", "utf8");
  const begin = sql.indexOf("BEGIN;");
  const createRole = sql.indexOf("SELECT format('CREATE ROLE toard_app");
  const alterRole = sql.indexOf("ALTER ROLE toard_app");
  const roleMembershipRevoke = sql.indexOf("FROM pg_auth_members");
  const broadGrant = sql.indexOf("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES");
  const sensitiveRevoke = sql.indexOf("REVOKE ALL PRIVILEGES ON TABLE public.content_e2ee_migration_sources");
  const defaultPrivileges = sql.lastIndexOf("ALTER DEFAULT PRIVILEGES IN SCHEMA public");
  const commit = sql.indexOf("COMMIT;");
  const validation = sql.indexOf("AS is_superuser");
  const metaValidation = sql.indexOf("\\if :{?app_password}");
  const metaQuit = sql.indexOf("\\quit");
  assert.ok(metaValidation >= 0 && metaValidation < metaQuit && metaQuit < begin);
  assert.ok(begin >= 0 && begin < createRole);
  assert.ok(createRole < alterRole && alterRole < roleMembershipRevoke);
  assert.ok(roleMembershipRevoke < broadGrant && broadGrant < sensitiveRevoke);
  assert.ok(sensitiveRevoke < defaultPrivileges && defaultPrivileges < commit);
  assert.ok(commit < validation);
  assert.equal(sql.indexOf("BEGIN;", begin + 1), -1);
  assert.equal(sql.indexOf("COMMIT;", commit + 1), -1);
});

test("bootstrap 재실행은 app role 속성과 membership을 exact-safe 상태로 복구한다", { timeout: 120_000 }, async () => {
  const container = `toard-bootstrap-role-repair-${randomUUID().slice(0, 6)}`;
  let admin: Client | null = null;
  try {
    await execFileAsync("docker", ["run", "-d", "--rm", "--name", container,
      "-e", "POSTGRES_PASSWORD=postgres", "-e", "POSTGRES_DB=toard",
      "-p", "127.0.0.1::5432", "postgres:16-alpine"]);
    const { stdout } = await execFileAsync("docker", ["port", container, "5432/tcp"]);
    const port = stdout.trim().match(/:(\d+)$/)?.[1]; assert.ok(port);
    const connectionString = `postgresql://postgres:postgres@127.0.0.1:${port}/toard`;
    await waitForPostgres(connectionString);
    admin = new Client({ connectionString }); await admin.connect();
    await admin.query(
      "CREATE ROLE toard_app SUPERUSER BYPASSRLS CREATEDB CREATEROLE REPLICATION INHERIT NOLOGIN",
    );
    await admin.query("CREATE ROLE toard_drift_parent NOLOGIN");
    await admin.query("GRANT toard_drift_parent TO toard_app WITH ADMIN OPTION");

    await bootstrap(container);

    const result = await admin.query(
      `SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole,
              rolreplication, rolinherit, rolcanlogin
         FROM pg_roles WHERE rolname='toard_app'`,
    );
    assert.deepEqual(result.rows, [
      {
        rolsuper: false,
        rolbypassrls: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
        rolinherit: false,
        rolcanlogin: true,
      },
    ]);
    assert.deepEqual((await admin.query(`
      SELECT granted.rolname
        FROM pg_auth_members membership
        JOIN pg_roles member ON member.oid = membership.member
        JOIN pg_roles granted ON granted.oid = membership.roleid
       WHERE member.rolname = 'toard_app'
       ORDER BY granted.rolname`)).rows, []);
  } finally {
    await admin?.end().catch(() => undefined);
    await execFileAsync("docker", ["rm", "-f", container]).catch(() => undefined);
  }
});

test("bootstrap privilege replacement is atomic to concurrent sessions", { timeout: 120_000 }, async () => {
  const container = `toard-bootstrap-atomic-${randomUUID().slice(0, 6)}`;
  let writer: Client | null = null; let observer: Client | null = null;
  try {
    await execFileAsync("docker", ["run", "-d", "--rm", "--name", container,
      "-e", "POSTGRES_PASSWORD=postgres", "-e", "POSTGRES_DB=toard",
      "-p", "127.0.0.1::5432", "postgres:16-alpine"]);
    const { stdout } = await execFileAsync("docker", ["port", container, "5432/tcp"]);
    const port = stdout.trim().match(/:(\d+)$/)?.[1]; assert.ok(port);
    const connectionString = `postgresql://postgres:postgres@127.0.0.1:${port}/toard`;
    await waitForPostgres(connectionString);
    await bootstrap(container);
    writer = new Client({ connectionString }); await writer.connect();
    for (const sql of await migrationUps()) await writer.query(sql);
    observer = new Client({ connectionString }); await observer.connect();
    assert.equal((await observer.query("SELECT has_table_privilege('toard_app','content_e2ee_migration_sources','DELETE') AS ok")).rows[0].ok, false);

    await writer.query("BEGIN");
    await writer.query("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO toard_app");
    assert.equal((await writer.query("SELECT has_table_privilege('toard_app','content_e2ee_migration_sources','DELETE') AS ok")).rows[0].ok, true);
    await observer.query("SET statement_timeout = '2s'");
    assert.equal((await observer.query("SELECT has_table_privilege('toard_app','content_e2ee_migration_sources','DELETE') AS ok")).rows[0].ok, false);
    await writer.query("REVOKE ALL PRIVILEGES ON TABLE public.content_e2ee_migration_sources FROM toard_app");
    await writer.query("COMMIT");
    assert.equal((await observer.query("SELECT has_table_privilege('toard_app','content_e2ee_migration_sources','DELETE') AS ok")).rows[0].ok, false);
  } finally {
    await writer?.query("ROLLBACK").catch(() => undefined);
    await observer?.end().catch(() => undefined); await writer?.end().catch(() => undefined);
    await execFileAsync("docker", ["rm", "-f", container]).catch(() => undefined);
  }
});

test("ON_ERROR_STOP exits nonzero and rolls back the bootstrap transaction", { timeout: 120_000 }, async () => {
  const container = `toard-bootstrap-rollback-${randomUUID().slice(0, 6)}`;
  let admin: Client | null = null;
  try {
    await execFileAsync("docker", ["run", "-d", "--rm", "--name", container,
      "-e", "POSTGRES_PASSWORD=postgres", "-e", "POSTGRES_DB=toard",
      "-p", "127.0.0.1::5432", "postgres:16-alpine"]);
    const { stdout } = await execFileAsync("docker", ["port", container, "5432/tcp"]);
    const port = stdout.trim().match(/:(\d+)$/)?.[1]; assert.ok(port);
    const connectionString = `postgresql://postgres:postgres@127.0.0.1:${port}/toard`;
    await waitForPostgres(connectionString);
    const sql = (await readFile("scripts/bootstrap-app-role.sql", "utf8"))
      .replace("COMMIT;", "SELECT 1 / 0;\nCOMMIT;");
    const result = await execFileWithInput("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-d", "toard",
      "-v", "app_password=integration-password", "-f", "-"], sql);
    assert.notEqual(result.code, 0, result.stderr);
    assert.match(result.stderr, /division by zero/);
    admin = new Client({ connectionString }); await admin.connect();
    assert.equal((await admin.query("SELECT count(*)::int AS count FROM pg_roles WHERE rolname='toard_app'")).rows[0].count, 0);
  } finally {
    await admin?.end().catch(() => undefined);
    await execFileAsync("docker", ["rm", "-f", container]).catch(() => undefined);
  }
});

for (const topology of ["role-before", "role-after"] as const) {
  test(`bootstrap app role preserves migration security in ${topology} topology`, { timeout: 120_000 }, async () => {
    const container = `toard-bootstrap-${topology}-${randomUUID().slice(0, 6)}`;
    let admin: Client | null = null; let app: Client | null = null;
    try {
      await execFileAsync("docker", ["run", "-d", "--rm", "--name", container,
        "-e", "POSTGRES_PASSWORD=postgres", "-e", "POSTGRES_DB=toard",
        "-p", "127.0.0.1::5432", "postgres:16-alpine"]);
      const { stdout } = await execFileAsync("docker", ["port", container, "5432/tcp"]);
      const port = stdout.trim().match(/:(\d+)$/)?.[1]; assert.ok(port);
      const connectionString = `postgresql://postgres:postgres@127.0.0.1:${port}/toard`;
      await waitForPostgres(connectionString);
      if (topology === "role-before") await bootstrap(container);
      admin = new Client({ connectionString }); await admin.connect();
      for (const sql of await migrationUps()) await admin.query(sql);
      if (topology === "role-after") await bootstrap(container);

      // role-before도 migration 직후 broad default privilege를 남기지 않아야 한다.
      if (topology === "role-before") {
        assert.equal((await admin.query(
          "SELECT has_table_privilege('toard_app','installation_identity','INSERT') AS ok",
        )).rows[0].ok, false);
      }

      const userA = randomUUID(), userB = randomUUID(), ownerA = randomUUID(), ownerB = randomUUID();
      await admin.query("INSERT INTO users(id,email) VALUES($1,'bootstrap-a@example.com'),($2,'bootstrap-b@example.com')", [userA, userB]);
      await admin.query("INSERT INTO providers(key,display_name,service_name_patterns,collection_method) VALUES('codex','Codex',ARRAY['codex'],'logfile')");
      await admin.query(`INSERT INTO content_accounts(user_id,content_owner_id,state,recovery_confirmed_at)
        VALUES($1,$2,'active',now()),($3,$4,'active',now())`, [userA, ownerA, userB, ownerB]);
      await admin.query(`INSERT INTO prompt_records
        (dedup_key,user_id,provider_key,turn_role,ts,key_version,wrapped_dek,iv,ciphertext,auth_tag,
         encryption_scheme,content_owner_id,content_key_version,dek_wrap_iv,dek_wrap_auth_tag,aad_version)
        VALUES('bootstrap-e2ee',$1,'codex','user',now(),1,$2,$3,$4,$5,'e2ee_v1',$6,1,$7,$8,1)`,
        [userA, Buffer.alloc(32, 1), Buffer.alloc(12, 2), Buffer.from("cipher"), Buffer.alloc(16, 3),
          ownerA, Buffer.alloc(12, 4), Buffer.alloc(16, 5)]);

      // 기존 role-before/role-after 모두에서 bootstrap 재실행도 broad grant를 최소 권한으로 복구한다.
      await admin.query("GRANT DELETE ON installation_identity, content_encryption_status, managed_content_keys TO toard_app");
      await bootstrap(container);

      for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        assert.equal((await admin.query("SELECT has_table_privilege('toard_app','content_e2ee_migration_sources',$1) AS ok", [privilege])).rows[0].ok, false);
      }
      for (const privilege of ["SELECT", "INSERT", "UPDATE"]) {
        assert.equal((await admin.query("SELECT has_table_privilege('toard_app','content_e2ee_migrations',$1) AS ok", [privilege])).rows[0].ok, true);
      }
      assert.equal((await admin.query("SELECT has_table_privilege('toard_app','content_e2ee_migrations','DELETE') AS ok")).rows[0].ok, false);
      for (const table of ["installation_identity", "content_encryption_status"]) {
        assert.equal((await admin.query(
          "SELECT has_table_privilege('toard_app',$1,'SELECT') AS ok", [table],
        )).rows[0].ok, true, `${topology}:${table}:SELECT`);
        for (const privilege of ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
          assert.equal((await admin.query(
            "SELECT has_table_privilege('toard_app',$1,$2) AS ok", [table, privilege],
          )).rows[0].ok, false, `${topology}:${table}:${privilege}`);
        }
      }
      for (const privilege of ["SELECT", "INSERT", "UPDATE"]) {
        assert.equal((await admin.query(
          "SELECT has_table_privilege('toard_app','managed_content_keys',$1) AS ok", [privilege],
        )).rows[0].ok, true, `${topology}:managed_content_keys:${privilege}`);
      }
      for (const privilege of ["DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
        assert.equal((await admin.query(
          "SELECT has_table_privilege('toard_app','managed_content_keys',$1) AS ok", [privilege],
        )).rows[0].ok, false, `${topology}:managed_content_keys:${privilege}`);
      }
      assert.equal((await admin.query(
        "SELECT has_table_privilege('toard_app','managed_content_key_distribution','SELECT') AS ok",
      )).rows[0].ok, true);
      for (const privilege of ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
        assert.equal((await admin.query(
          "SELECT has_table_privilege('toard_app','managed_content_key_distribution',$1) AS ok",
          [privilege],
        )).rows[0].ok, false, `${topology}:${privilege}`);
      }
      assert.equal((await admin.query("SELECT has_function_privilege('toard_app','get_content_e2ee_migration_progress(uuid)','EXECUTE') AS ok")).rows[0].ok, true);
      assert.equal((await admin.query(
        "SELECT has_function_privilege('toard_app','lock_managed_content_key_distribution()','EXECUTE') AS ok",
      )).rows[0].ok, true);
      assert.equal((await admin.query(
        "SELECT has_function_privilege('toard_app','latest_managed_content_write_fence()','EXECUTE') AS ok",
      )).rows[0].ok, true);
      const publicExecute = await admin.query<{ name: string; public_execute: boolean }>(`
        SELECT p.proname AS name,
               COALESCE(bool_or(acl.grantee=0 AND acl.privilege_type='EXECUTE'),false) AS public_execute
        FROM pg_proc p
        CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) acl
        WHERE p.proname IN (
          'capture_content_e2ee_migration_source','get_content_e2ee_migration_progress',
          'lock_managed_content_key_distribution','latest_managed_content_write_fence'
        )
        GROUP BY p.proname ORDER BY p.proname`);
      assert.deepEqual(publicExecute.rows, [
        { name: "capture_content_e2ee_migration_source", public_execute: false },
        { name: "get_content_e2ee_migration_progress", public_execute: false },
        { name: "latest_managed_content_write_fence", public_execute: false },
        { name: "lock_managed_content_key_distribution", public_execute: false },
      ]);

      app = new Client({ connectionString }); await app.connect(); await app.query("SET ROLE toard_app");
      await assert.rejects(
        app.query("UPDATE installation_identity SET created_at=created_at WHERE singleton=TRUE"),
        (error: unknown) => (error as { code?: string }).code === "42501",
      );
      await assert.rejects(
        app.query("DELETE FROM content_encryption_status WHERE singleton=TRUE"),
        (error: unknown) => (error as { code?: string }).code === "42501",
      );
      await assert.rejects(
        app.query("DELETE FROM managed_content_keys"),
        (error: unknown) => (error as { code?: string }).code === "42501",
      );
      await app.query("BEGIN"); await app.query("SELECT set_config('app.current_user_id',$1,true)", [userA]);
      assert.deepEqual((await app.query("SELECT * FROM get_content_e2ee_migration_progress($1)", [userA])).rows,
        [{ e2ee_records: "1", migrated_records: "0" }]);
      await assert.rejects(app.query("SELECT * FROM get_content_e2ee_migration_progress($1)", [userB]),
        (error: unknown) => (error as { code?: string }).code === "42501");
      await app.query("ROLLBACK");
      const status = await getE2eeManagedMigrationStatus(userA, db(app));
      assert.deepEqual({ state: status.state, e2eeRecords: status.e2eeRecords, migratedRecords: status.migratedRecords },
        { state: "pending", e2eeRecords: 1, migratedRecords: 0 });
    } finally {
      await app?.end().catch(() => undefined); await admin?.end().catch(() => undefined);
      await execFileAsync("docker", ["rm", "-f", container]).catch(() => undefined);
    }
  });
}
