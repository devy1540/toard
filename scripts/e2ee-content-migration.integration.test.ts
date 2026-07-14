import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import { Client } from "pg";

const execFileAsync = promisify(execFile);
const MIGRATIONS = [
  "1700000001_init.sql",
  "1700000010_prompt_records.sql",
  "1700000028_e2ee_content_foundation.sql",
] as const;

async function waitForPostgres(connectionString: string): Promise<void> {
  let lastError: unknown;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const probe = new Client({ connectionString, connectionTimeoutMillis: 1_000, query_timeout: 1_000 });
    try {
      await probe.connect();
      await probe.query("SELECT 1");
      await probe.end();
      return;
    } catch (error) {
      lastError = error;
      await probe.end().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError;
}

async function applyUpMigration(client: Client, filename: string): Promise<void> {
  const migration = await readFile(`migrations/${filename}`, "utf8");
  await client.query(migration.split("-- Down Migration", 1)[0]);
}

test("migration 28 adds E2EE content ownership, wrappers, approvals, and enforced RLS", { timeout: 90_000 }, async () => {
  const container = `toard-e2ee-migration-${randomUUID().slice(0, 8)}`;
  let client: Client | null = null;

  try {
    await execFileAsync("docker", [
      "run", "-d", "--rm", "--name", container,
      "-e", "POSTGRES_PASSWORD=postgres",
      "-e", "POSTGRES_DB=toard",
      "-p", "127.0.0.1::5432",
      "postgres:16-alpine",
    ]);
    const { stdout } = await execFileAsync("docker", ["port", container, "5432/tcp"]);
    const port = stdout.trim().match(/:(\d+)$/)?.[1];
    assert.ok(port, `failed to resolve PostgreSQL port from: ${stdout}`);
    const connectionString = `postgresql://postgres:postgres@127.0.0.1:${port}/toard`;
    await waitForPostgres(connectionString);

    client = new Client({ connectionString });
    await client.connect();
    for (const migration of MIGRATIONS) await applyUpMigration(client, migration);

    const columns = await client.query<{ column_name: string; column_default: string | null }>(`
      SELECT column_name, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'prompt_records'
    `);
    assert.equal(
      columns.rows.find((row) => row.column_name === "encryption_scheme")?.column_default,
      "'server_v1'::text",
    );
    for (const name of ["content_owner_id", "content_key_version", "dek_wrap_iv", "dek_wrap_auth_tag", "aad_version"]) {
      assert.ok(columns.rows.some((row) => row.column_name === name), `missing ${name}`);
    }

    const userA = randomUUID();
    const userB = randomUUID();
    await client.query(
      "INSERT INTO users (id,email) VALUES ($1,'a@example.com'),($2,'b@example.com')",
      [userA, userB],
    );
    await client.query(
      `INSERT INTO providers (key,display_name,service_name_patterns,collection_method)
       VALUES ('codex','Codex',ARRAY['codex'],'logfile')`,
    );
    const accounts = await client.query<{ user_id: string; content_owner_id: string }>(
      `INSERT INTO content_accounts (user_id) VALUES ($1),($2)
       RETURNING user_id, content_owner_id`,
      [userA, userB],
    );
    const ownerA = accounts.rows.find((row) => row.user_id === userA)?.content_owner_id;
    assert.ok(ownerA);

    await assert.rejects(
      client.query(
        `INSERT INTO prompt_records
           (dedup_key,user_id,provider_key,turn_role,ts,key_version,wrapped_dek,iv,ciphertext,auth_tag,
            encryption_scheme,content_owner_id,content_key_version,aad_version)
         VALUES ('broken',$1,'codex','user',now(),1,$2,$3,$4,$5,'e2ee_v1',$6,1,1)`,
        [userA, Buffer.alloc(32), Buffer.alloc(12), Buffer.alloc(1), Buffer.alloc(16), ownerA],
      ),
      /prompt_records_e2ee_shape/,
    );

    await client.query(
      `INSERT INTO prompt_records
         (dedup_key,user_id,provider_key,turn_role,ts,key_version,wrapped_dek,iv,ciphertext,auth_tag,
          encryption_scheme,content_owner_id,content_key_version,dek_wrap_iv,dek_wrap_auth_tag,aad_version)
       VALUES ('valid',$1,'codex','user',now(),1,$2,$3,$4,$5,'e2ee_v1',$6,1,$7,$8,1)`,
      [userA, Buffer.alloc(32), Buffer.alloc(12), Buffer.alloc(1), Buffer.alloc(16), ownerA, Buffer.alloc(12), Buffer.alloc(16)],
    );

    await client.query(`
      CREATE ROLE e2ee_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
      GRANT USAGE ON SCHEMA public TO e2ee_app;
      GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO e2ee_app;
      GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO e2ee_app;
      SET ROLE e2ee_app;
    `);

    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_user_id', $1, true)", [userA]);
    assert.equal((await client.query("SELECT id FROM prompt_records")).rowCount, 1);
    assert.equal((await client.query("SELECT user_id FROM content_accounts")).rowCount, 1);
    assert.equal((await client.query(
      "UPDATE prompt_records SET received_at = received_at WHERE user_id = $1 RETURNING id",
      [userA],
    )).rowCount, 1);
    await client.query("ROLLBACK");

    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_user_id', $1, true)", [userB]);
    assert.equal((await client.query("SELECT id FROM prompt_records")).rowCount, 0);
    assert.equal((await client.query("SELECT user_id FROM content_accounts")).rowCount, 1);
    await client.query("ROLLBACK");

    await client.query("RESET ROLE");
    const policies = await client.query<{ tablename: string; policy_count: string }>(`
      SELECT tablename, COUNT(*)::text AS policy_count
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename IN ('content_accounts','content_devices','content_key_wrappers','content_device_approval_requests')
      GROUP BY tablename ORDER BY tablename
    `);
    assert.deepEqual(
      policies.rows,
      [
        { tablename: "content_accounts", policy_count: "3" },
        { tablename: "content_device_approval_requests", policy_count: "3" },
        { tablename: "content_devices", policy_count: "3" },
        { tablename: "content_key_wrappers", policy_count: "3" },
      ],
    );

    const migration28 = await readFile("migrations/1700000028_e2ee_content_foundation.sql", "utf8");
    const down = migration28.split("-- Down Migration", 2)[1];
    assert.ok(down);
    await assert.rejects(client.query(down), /rollback blocked: E2EE rows exist/);
  } finally {
    await client?.end().catch(() => undefined);
    await execFileAsync("docker", ["rm", "-f", container]).catch(() => undefined);
  }
});
