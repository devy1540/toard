import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import { Client } from "pg";
import { recordKeyOperation } from "../apps/web/lib/key-management/observability";

const execFileAsync = promisify(execFile);
const MIGRATION = "migrations/1700000037_content_key_operations.sql";

async function waitForPostgres(connectionString: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let last: unknown;
  while (Date.now() < deadline) {
    const client = new Client({ connectionString, connectionTimeoutMillis: 1_000 });
    try {
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      return;
    } catch (error) {
      last = error;
      await client.end().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw last;
}

async function migrationUpsBefore37(): Promise<string[]> {
  const names = (await readdir("migrations"))
    .filter((name) => /^17000000\d+.*\.sql$/.test(name) && name < "1700000037")
    .sort();
  return Promise.all(names.map(async (name) => (
    await readFile(`migrations/${name}`, "utf8")
  ).split("-- Down Migration", 1)[0]!));
}

async function bootstrap(container: string, database: string): Promise<void> {
  await execFileAsync("docker", ["cp", "scripts/bootstrap-app-role.sql", `${container}:/tmp/bootstrap-app-role.sql`]);
  await execFileAsync("docker", ["exec", container, "psql", "-U", "postgres", "-d", database,
    "-v", "app_password=integration-password", "-f", "/tmp/bootstrap-app-role.sql"]);
}

async function connect(port: string, database: string, role = "postgres"): Promise<Client> {
  const password = role === "postgres" ? "postgres" : "integration-password";
  const client = new Client({
    connectionString: `postgresql://${role}:${password}@127.0.0.1:${port}/${database}`,
  });
  await client.connect();
  return client;
}

test("KMS operation aggregate and security events are secret-free and least-privileged", { timeout: 180_000 }, async () => {
  // This read is intentionally first: RED must fail with ENOENT until migration 37 exists.
  const migration = await readFile(MIGRATION, "utf8");
  const [up, down = ""] = migration.split("-- Down Migration");
  const container = `toard-key-operations-${randomUUID().slice(0, 8)}`;
  let root: Client | null = null;
  try {
    await execFileAsync("docker", ["run", "-d", "--rm", "--name", container,
      "-e", "POSTGRES_PASSWORD=postgres", "-e", "POSTGRES_DB=toard",
      "-p", "127.0.0.1::5432", "postgres:16-alpine"]);
    const { stdout } = await execFileAsync("docker", ["port", container, "5432/tcp"]);
    const port = stdout.trim().match(/:(\d+)$/)?.[1];
    assert.ok(port);
    await waitForPostgres(`postgresql://postgres:postgres@127.0.0.1:${port}/toard`);
    root = await connect(port, "toard");
    const baseUps = await migrationUpsBefore37();

    for (const topology of ["role-before", "role-after"] as const) {
      const database = `ops_${topology.replace("-", "_")}`;
      await root.query(`CREATE DATABASE ${database}`);
      if (topology === "role-before") await bootstrap(container, database);
      const admin = await connect(port, database);
      let app: Client | null = null;
      try {
        for (const sql of baseUps) await admin.query(sql);
        await admin.query(up);
        if (topology === "role-after") await bootstrap(container, database);

        const operationColumns = (await admin.query<{ column_name: string }>(`
          SELECT column_name FROM information_schema.columns
          WHERE table_schema='public' AND table_name='content_key_operation_daily'
          ORDER BY column_name`)).rows.map((row) => row.column_name);
        for (const forbidden of [
          "user_id", "key", "ciphertext", "wrapped_user_key", "plaintext", "credential", "context",
        ]) {
          assert.equal(operationColumns.includes(forbidden), false, forbidden);
        }
        assert.equal(operationColumns.includes("operation_count"), true);

        const securityColumns = (await admin.query<{ column_name: string }>(`
          SELECT column_name FROM information_schema.columns
          WHERE table_schema='public' AND table_name='content_key_security_events'
          ORDER BY column_name`)).rows.map((row) => row.column_name);
        assert.deepEqual(securityColumns, [
          "actor_user_id", "app_instance_id", "created_at", "event_type", "id",
          "key_version", "provider", "provider_fingerprint", "user_id",
        ]);

        for (const privilege of ["SELECT", "INSERT"]) {
          assert.equal((await admin.query(
            "SELECT has_table_privilege('toard_app','content_key_operation_daily',$1) AS ok",
            [privilege],
          )).rows[0].ok, true);
          assert.equal((await admin.query(
            "SELECT has_table_privilege('toard_app','content_key_security_events',$1) AS ok",
            [privilege],
          )).rows[0].ok, true);
        }
        for (const table of ["content_key_operation_daily", "content_key_security_events"]) {
          for (const privilege of ["DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
            assert.equal((await admin.query(
              "SELECT has_table_privilege('toard_app',$1,$2) AS ok", [table, privilege],
            )).rows[0].ok, false, `${topology}:${table}:${privilege}`);
          }
        }
        assert.equal((await admin.query(
          "SELECT has_column_privilege('toard_app','content_key_operation_daily','operation_count','UPDATE') AS ok",
        )).rows[0].ok, true);
        assert.equal((await admin.query(
          "SELECT has_column_privilege('toard_app','content_key_operation_daily','provider','UPDATE') AS ok",
        )).rows[0].ok, false);
        assert.equal((await admin.query(
          "SELECT has_table_privilege('toard_app','content_key_security_events','UPDATE') AS ok",
        )).rows[0].ok, false);
        assert.equal((await admin.query(
          "SELECT has_sequence_privilege('toard_app','content_key_security_events_id_seq','USAGE') AS ok",
        )).rows[0].ok, true);
        assert.equal((await admin.query(
          "SELECT has_sequence_privilege('toard_app','content_key_security_events_id_seq','UPDATE') AS ok",
        )).rows[0].ok, false);

        const userA = randomUUID();
        const userB = randomUUID();
        await admin.query(
          "INSERT INTO users(id,email) VALUES($1,'ops-a@example.com'),($2,'ops-b@example.com')",
          [userA, userB],
        );
        app = await connect(port, database, "toard_app");
        await app.query("BEGIN");
        await app.query("SELECT set_config('app.current_user_id',$1,true)", [userA]);
        const aggregateEvent = {
          provider: "local" as const,
          fingerprint: "local:abcdefabcdefabcdefabcdef",
          operation: "unwrap" as const,
          outcome: "success" as const,
          cacheResult: "miss" as const,
          latencyMs: 4,
        };
        await recordKeyOperation(aggregateEvent, app);
        await recordKeyOperation(aggregateEvent, app);
        assert.deepEqual((await app.query(`
          SELECT operation_count::int,total_latency_ms::int
          FROM content_key_operation_daily
          WHERE provider='local' AND operation='unwrap' AND cache_result='miss'`)).rows,
        [{ operation_count: 2, total_latency_ms: 8 }]);
        await app.query(`
          INSERT INTO content_key_security_events
            (event_type,user_id,provider,provider_fingerprint,key_version,actor_user_id,app_instance_id)
          VALUES('user_key_created',$1,'local','local:abcdefabcdefabcdefabcdef',1,$1,'019f7250-dc4d-78fd-98e8-a5465d0f5b69')`,
        [userA]);
        assert.equal((await app.query("SELECT id FROM content_key_security_events")).rowCount, 1);
        await assert.rejects(
          app.query(`INSERT INTO content_key_security_events(event_type,user_id,actor_user_id,app_instance_id)
                     VALUES('user_key_created',$1,$1,'app')`, [userB]),
          /row-level security policy/,
        );
        await app.query("ROLLBACK");

        await admin.query(`INSERT INTO content_key_operation_daily
          (day,provider,provider_fingerprint,operation,outcome,cache_result,operation_count,total_latency_ms)
          VALUES(CURRENT_DATE,'local','local:abcdefabcdefabcdefabcdef','health','success','none',
                 9223372036854775807,0)`);
        await assert.rejects(
          recordKeyOperation({
            provider: "local",
            fingerprint: "local:abcdefabcdefabcdefabcdef",
            operation: "health",
            outcome: "success",
            latencyMs: 1,
          }, app),
          /KEY_OPERATION_RECORD_FAILED/,
        );
        assert.equal((await admin.query(`SELECT operation_count::text AS count
          FROM content_key_operation_daily WHERE operation='health'`)).rows[0].count,
        "9223372036854775807");
        await admin.query("DELETE FROM content_key_operation_daily WHERE operation='health'");

        for (const sql of [
          `INSERT INTO content_key_operation_daily
             (day,provider,provider_fingerprint,operation,outcome,cache_result,operation_count,total_latency_ms)
           VALUES(CURRENT_DATE,'local','local:https://host/?credential=x','wrap','success','none',1,1)`,
          `INSERT INTO content_key_operation_daily
             (day,provider,provider_fingerprint,operation,outcome,cache_result,operation_count,total_latency_ms)
           VALUES(CURRENT_DATE,'local','local:abcdefabcdefabcdefabcdef','wrap','success','none',-1,1)`,
        ]) {
          await assert.rejects(admin.query(sql), /violates check constraint/);
        }

        await admin.query(`INSERT INTO content_key_operation_daily
          (day,provider,provider_fingerprint,operation,outcome,cache_result,operation_count,total_latency_ms)
          VALUES(CURRENT_DATE,'local','local:abcdefabcdefabcdefabcdef','wrap','success','none',1,1)`);
        await assert.rejects(admin.query(down), /rollback blocked/);
        await admin.query("DELETE FROM content_key_operation_daily");
        await admin.query(down);
        assert.equal((await admin.query("SELECT to_regclass('content_key_operation_daily') AS name")).rows[0].name, null);
      } finally {
        await app?.end().catch(() => undefined);
        await admin.end().catch(() => undefined);
      }
    }
  } finally {
    await root?.end().catch(() => undefined);
    await execFileAsync("docker", ["rm", "-f", container]).catch(() => undefined);
  }
});
