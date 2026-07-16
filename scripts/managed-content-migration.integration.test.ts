import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import { Client } from "pg";

const execFileAsync = promisify(execFile);
const BASE_MIGRATIONS = [
  "1700000001_init.sql",
  "1700000010_prompt_records.sql",
  "1700000030_e2ee_content_foundation.sql",
] as const;

async function waitForPostgres(connectionString: string): Promise<void> {
  let lastError: unknown;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const probe = new Client({
      connectionString,
      connectionTimeoutMillis: 1_000,
      query_timeout: 1_000,
    });
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

async function migrationPart(filename: string, part: "up" | "down"): Promise<string> {
  const migration = await readFile(`migrations/${filename}`, "utf8");
  const [up, down] = migration.split("-- Down Migration", 2);
  assert.ok(up);
  if (part === "down") assert.ok(down);
  return part === "up" ? up : down;
}

async function status(client: Client): Promise<Record<string, number>> {
  const result = await client.query<{
    server_records: number;
    e2ee_records: number;
    managed_records: number;
    active_user_keys: number;
    pending_user_keys: number;
    retiring_user_keys: number;
  }>(`
    SELECT server_records::int, e2ee_records::int, managed_records::int,
           active_user_keys::int, pending_user_keys::int, retiring_user_keys::int
    FROM content_encryption_status
    WHERE singleton = TRUE
  `);
  assert.equal(result.rowCount, 1);
  return result.rows[0];
}

test("migration 35 creates managed key RLS and managed_v1 shape", { timeout: 90_000 }, async () => {
  const container = `toard-managed-migration-${randomUUID().slice(0, 8)}`;
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
    for (const migration of BASE_MIGRATIONS) {
      await client.query(await migrationPart(migration, "up"));
    }

    await client.query(`
      CREATE ROLE toard_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
      GRANT USAGE ON SCHEMA public TO toard_app;
    `);

    const userA = randomUUID();
    const userB = randomUUID();
    await client.query(
      "INSERT INTO users (id,email) VALUES ($1,'managed-a@example.com'),($2,'managed-b@example.com')",
      [userA, userB],
    );
    await client.query(
      `INSERT INTO providers (key,display_name,service_name_patterns,collection_method)
       VALUES ('codex','Codex',ARRAY['codex'],'logfile')`,
    );
    const ownerA = randomUUID();
    await client.query(
      `INSERT INTO content_accounts (user_id,content_owner_id,state,recovery_confirmed_at)
       VALUES ($1,$2,'active',now())`,
      [userA, ownerA],
    );
    await client.query(
      `INSERT INTO prompt_records
         (dedup_key,user_id,provider_key,turn_role,ts,key_version,wrapped_dek,iv,ciphertext,auth_tag)
       VALUES ('server-before',$1,'codex','user',now(),1,$2,$3,$4,$5)`,
      [userA, Buffer.alloc(60, 1), Buffer.alloc(12, 2), Buffer.from("server"), Buffer.alloc(16, 3)],
    );
    await client.query(
      `INSERT INTO prompt_records
         (dedup_key,user_id,provider_key,turn_role,ts,key_version,wrapped_dek,iv,
          ciphertext,auth_tag,encryption_scheme,content_owner_id,content_key_version,
          dek_wrap_iv,dek_wrap_auth_tag,aad_version)
       VALUES ('e2ee-before',$1,'codex','user',now(),1,$2,$3,$4,$5,
               'e2ee_v1',$6,1,$7,$8,1)`,
      [
        userA,
        Buffer.alloc(32, 4),
        Buffer.alloc(12, 5),
        Buffer.from("e2ee"),
        Buffer.alloc(16, 6),
        ownerA,
        Buffer.alloc(12, 7),
        Buffer.alloc(16, 8),
      ],
    );
    await client.query(await migrationPart("1700000031_e2ee_legacy_retirement.sql", "up"));
    await client.query(await migrationPart("1700000035_managed_content_foundation.sql", "up"));

    const installation = await client.query(
      "SELECT installation_id FROM installation_identity WHERE singleton=TRUE",
    );
    assert.equal(installation.rowCount, 1);
    assert.match(installation.rows[0].installation_id, /^[0-9a-f-]{36}$/);

    assert.deepEqual(await status(client), {
      server_records: 1,
      e2ee_records: 1,
      managed_records: 0,
      active_user_keys: 0,
      pending_user_keys: 0,
      retiring_user_keys: 0,
    });

    assert.equal(
      (await client.query(
        "SELECT has_table_privilege('toard_app','installation_identity','SELECT') AS ok",
      )).rows[0].ok,
      true,
    );
    assert.equal(
      (await client.query(
        "SELECT has_table_privilege('toard_app','content_encryption_status','SELECT') AS ok",
      )).rows[0].ok,
      true,
    );
    for (const privilege of ["SELECT", "INSERT", "UPDATE"]) {
      assert.equal(
        (await client.query(
          "SELECT has_table_privilege('toard_app','managed_content_keys',$1) AS ok",
          [privilege],
        )).rows[0].ok,
        true,
      );
    }
    assert.equal(
      (await client.query(
        "SELECT has_table_privilege('toard_app','managed_content_keys','DELETE') AS ok",
      )).rows[0].ok,
      false,
    );

    await client.query("SET ROLE toard_app");
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_user_id', $1, true)", [userA]);
    await client.query(
      `INSERT INTO managed_content_keys
         (user_id,key_version,provider,provider_key_ref,provider_fingerprint,
          wrapped_user_key,wrapper_metadata,context_version,state)
       VALUES($1,1,'local','file:/run/secrets/toard-kek',$2,$3,'{}',1,'active')`,
      [userA, "local:test-a", Buffer.alloc(96, 7)],
    );
    assert.equal(
      (await client.query("SELECT user_id FROM managed_content_keys ORDER BY user_id")).rowCount,
      1,
    );
    await assert.rejects(
      client.query(
        `INSERT INTO managed_content_keys
           (user_id,key_version,provider,provider_key_ref,provider_fingerprint,
            wrapped_user_key,wrapper_metadata,context_version,state)
         VALUES($1,1,'local','file:/run/secrets/toard-kek',$2,$3,'{}',1,'active')`,
        [userB, "local:test-b", Buffer.alloc(96, 8)],
      ),
      /row-level security policy/,
    );
    await client.query("ROLLBACK");
    await client.query("RESET ROLE");

    await assert.rejects(
      client.query(
        `INSERT INTO prompt_records
           (dedup_key,user_id,provider_key,turn_role,ts,key_version,wrapped_dek,iv,
            ciphertext,auth_tag,encryption_scheme,content_key_version,
            dek_wrap_iv,dek_wrap_auth_tag,aad_version)
         VALUES('broken',$1,'codex','user',now(),1,$2,$3,$4,$5,
                'managed_v1',1,NULL,$6,2)`,
        [userA, Buffer.alloc(32), Buffer.alloc(12), Buffer.from("x"), Buffer.alloc(16), Buffer.alloc(16)],
      ),
      /prompt_records_encryption_shape/,
    );

    await client.query(
      `INSERT INTO managed_content_keys
         (user_id,key_version,provider,provider_key_ref,provider_fingerprint,
          wrapped_user_key,wrapper_metadata,context_version,state)
       VALUES
         ($1,1,'local','local:active','local:active',$3,'{}',1,'active'),
         ($1,2,'aws-kms','arn:pending','aws:pending',$3,'{}',1,'pending'),
         ($1,3,'gcp-kms','gcp:retiring','gcp:retiring',$3,'{}',1,'retiring'),
         ($2,1,'azure-key-vault','azure:active','azure:active',$3,'{}',1,'active')`,
      [userA, userB, Buffer.alloc(96, 9)],
    );
    assert.deepEqual(await status(client), {
      server_records: 1,
      e2ee_records: 1,
      managed_records: 0,
      active_user_keys: 2,
      pending_user_keys: 1,
      retiring_user_keys: 1,
    });

    await client.query(
      "UPDATE managed_content_keys SET state='retiring' WHERE user_id=$1 AND state='pending'",
      [userA],
    );
    await client.query(
      "DELETE FROM managed_content_keys WHERE user_id=$1 AND state='active'",
      [userB],
    );
    assert.deepEqual(await status(client), {
      server_records: 1,
      e2ee_records: 1,
      managed_records: 0,
      active_user_keys: 1,
      pending_user_keys: 0,
      retiring_user_keys: 2,
    });

    await client.query(
      `INSERT INTO prompt_records
         (dedup_key,user_id,provider_key,turn_role,ts,key_version,wrapped_dek,iv,
          ciphertext,auth_tag,encryption_scheme,content_key_version,
          dek_wrap_iv,dek_wrap_auth_tag,aad_version)
       VALUES('managed-valid',$1,'codex','assistant',now(),1,$2,$3,$4,$5,
              'managed_v1',1,$6,$7,2)`,
      [
        userA,
        Buffer.alloc(32, 10),
        Buffer.alloc(12, 11),
        Buffer.from("managed"),
        Buffer.alloc(16, 12),
        Buffer.alloc(12, 13),
        Buffer.alloc(16, 14),
      ],
    );
    await client.query(
      `UPDATE prompt_records
       SET encryption_scheme='managed_v1', content_owner_id=NULL, content_key_version=1,
           wrapped_dek=$2, dek_wrap_iv=$3, dek_wrap_auth_tag=$4,
           iv=$3, ciphertext=$5, auth_tag=$4, aad_version=2
       WHERE dedup_key='server-before' AND user_id=$1`,
      [
        userA,
        Buffer.alloc(32, 15),
        Buffer.alloc(12, 16),
        Buffer.alloc(16, 17),
        Buffer.from("managed-from-server"),
      ],
    );
    await client.query("DELETE FROM prompt_records WHERE dedup_key='e2ee-before'");
    assert.deepEqual(await status(client), {
      server_records: 0,
      e2ee_records: 0,
      managed_records: 2,
      active_user_keys: 1,
      pending_user_keys: 0,
      retiring_user_keys: 2,
    });

    const triggerFunctions = await client.query<{ definition: string }>(`
      SELECT pg_get_functiondef(p.oid) AS definition
      FROM pg_proc p
      WHERE p.proname IN (
        'sync_content_encryption_status',
        'sync_managed_content_key_status'
      )
      ORDER BY p.proname
    `);
    assert.equal(triggerFunctions.rowCount, 2);
    const definitions = triggerFunctions.rows.map((row) => row.definition).join("\n");
    for (const sensitiveColumn of [
      "wrapped_user_key",
      "wrapper_metadata",
      "wrapped_dek",
      "ciphertext",
      "auth_tag",
      "dek_wrap_iv",
    ]) {
      assert.doesNotMatch(definitions, new RegExp(`\\b${sensitiveColumn}\\b`, "i"));
    }
    assert.match(definitions, /SECURITY DEFINER/i);
    assert.match(definitions, /SET search_path TO 'public', 'pg_temp'/i);

    const down = await migrationPart("1700000035_managed_content_foundation.sql", "down");
    await assert.rejects(client.query(down), /rollback blocked: managed content exists/);

    await client.query("DELETE FROM prompt_records WHERE encryption_scheme='managed_v1'");
    await client.query("DELETE FROM managed_content_keys");
    await client.query(down);
    assert.equal(
      (await client.query("SELECT to_regclass('installation_identity') AS name")).rows[0].name,
      null,
    );
    await assert.rejects(
      client.query(
        `INSERT INTO prompt_records
           (dedup_key,user_id,provider_key,turn_role,ts,key_version,wrapped_dek,iv,
            ciphertext,auth_tag,encryption_scheme)
         VALUES('managed-after-down',$1,'codex','user',now(),1,$2,$3,$4,$5,'managed_v1')`,
        [userA, Buffer.alloc(60, 1), Buffer.alloc(12, 2), Buffer.from("x"), Buffer.alloc(16, 3)],
      ),
      /prompt_records_(?:encryption_scheme_check|e2ee_shape)/,
    );
  } finally {
    await client?.end().catch(() => undefined);
    await execFileAsync("docker", ["rm", "-f", container]).catch(() => undefined);
  }
});
