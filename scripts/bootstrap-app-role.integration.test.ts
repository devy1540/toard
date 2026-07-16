import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import { Client } from "pg";
import { getE2eeManagedMigrationStatus, type E2eeMigrationDb } from "../apps/web/lib/e2ee-to-managed-migration";

const execFileAsync = promisify(execFile);

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

      for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        assert.equal((await admin.query("SELECT has_table_privilege('toard_app','content_e2ee_migration_sources',$1) AS ok", [privilege])).rows[0].ok, false);
      }
      for (const privilege of ["SELECT", "INSERT", "UPDATE"]) {
        assert.equal((await admin.query("SELECT has_table_privilege('toard_app','content_e2ee_migrations',$1) AS ok", [privilege])).rows[0].ok, true);
      }
      assert.equal((await admin.query("SELECT has_table_privilege('toard_app','content_e2ee_migrations','DELETE') AS ok")).rows[0].ok, false);
      assert.equal((await admin.query("SELECT has_function_privilege('toard_app','get_content_e2ee_migration_progress(uuid)','EXECUTE') AS ok")).rows[0].ok, true);
      const publicExecute = await admin.query<{ name: string; public_execute: boolean }>(`
        SELECT p.proname AS name,
               COALESCE(bool_or(acl.grantee=0 AND acl.privilege_type='EXECUTE'),false) AS public_execute
        FROM pg_proc p
        CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) acl
        WHERE p.proname IN ('capture_content_e2ee_migration_source','get_content_e2ee_migration_progress')
        GROUP BY p.proname ORDER BY p.proname`);
      assert.deepEqual(publicExecute.rows, [
        { name: "capture_content_e2ee_migration_source", public_execute: false },
        { name: "get_content_e2ee_migration_progress", public_execute: false },
      ]);

      app = new Client({ connectionString }); await app.connect(); await app.query("SET ROLE toard_app");
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
