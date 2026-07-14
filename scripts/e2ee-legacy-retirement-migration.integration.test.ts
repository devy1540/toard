import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import { Client } from "pg";

const execFileAsync = promisify(execFile);

async function waitForPostgres(connectionString: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const client = new Client({ connectionString, connectionTimeoutMillis: 1_000 });
    try {
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      return;
    } catch {
      await client.end().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error("PostgreSQL did not become ready");
}

async function migrationPart(filename: string, part: "up" | "down") {
  const sql = await readFile(`migrations/${filename}`, "utf8");
  const [up, down] = sql.split("-- Down Migration", 2);
  return part === "up" ? up : down;
}

test("migration 31은 RLS와 무관한 전역 legacy count를 trigger로 정확히 유지한다", { timeout: 90_000 }, async () => {
  const container = `toard-e2ee-retirement-${randomUUID().slice(0, 8)}`;
  let client: Client | null = null;
  try {
    await execFileAsync("docker", ["run", "-d", "--rm", "--name", container,
      "-e", "POSTGRES_PASSWORD=postgres", "-e", "POSTGRES_DB=toard",
      "-p", "127.0.0.1::5432", "postgres:16-alpine"]);
    const { stdout } = await execFileAsync("docker", ["port", container, "5432/tcp"]);
    const port = stdout.trim().match(/:(\d+)$/)?.[1];
    assert.ok(port);
    const connectionString = `postgresql://postgres:postgres@127.0.0.1:${port}/toard`;
    await waitForPostgres(connectionString);
    client = new Client({ connectionString });
    await client.connect();
    for (const file of ["1700000001_init.sql", "1700000010_prompt_records.sql", "1700000030_e2ee_content_foundation.sql"]) {
      await client.query(await migrationPart(file, "up"));
    }
    await client.query("CREATE ROLE toard_app");
    const userId = randomUUID();
    await client.query("INSERT INTO users(id,email) VALUES($1,'retirement@example.com')", [userId]);
    await client.query("INSERT INTO providers(key,display_name,service_name_patterns,collection_method) VALUES('codex','Codex',ARRAY['codex'],'logfile')");
    await client.query(
      `INSERT INTO prompt_records(dedup_key,user_id,provider_key,turn_role,ts,key_version,wrapped_dek,iv,ciphertext,auth_tag)
       VALUES('before',$1,'codex','user',now(),1,$2,$3,$4,$5)`,
      [userId, Buffer.alloc(60, 1), Buffer.alloc(12, 2), Buffer.from("legacy"), Buffer.alloc(16, 3)],
    );
    await client.query(await migrationPart("1700000031_e2ee_legacy_retirement.sql", "up"));
    assert.equal((await client.query("SELECT legacy_records::int AS n FROM content_legacy_retirement")).rows[0].n, 1);

    await client.query(
      `INSERT INTO prompt_records(dedup_key,user_id,provider_key,turn_role,ts,key_version,wrapped_dek,iv,ciphertext,auth_tag)
       VALUES('after',$1,'codex','user',now(),1,$2,$3,$4,$5)`,
      [userId, Buffer.alloc(60, 1), Buffer.alloc(12, 2), Buffer.from("legacy2"), Buffer.alloc(16, 3)],
    );
    assert.equal((await client.query("SELECT legacy_records::int AS n FROM content_legacy_retirement")).rows[0].n, 2);
    await client.query("DELETE FROM prompt_records WHERE dedup_key='after'");
    assert.equal((await client.query("SELECT legacy_records::int AS n FROM content_legacy_retirement")).rows[0].n, 1);

    const owner = randomUUID();
    await client.query("INSERT INTO content_accounts(user_id,content_owner_id,state,recovery_confirmed_at) VALUES($1,$2,'active',now())", [userId, owner]);
    await client.query(
      `UPDATE prompt_records SET encryption_scheme='e2ee_v1', content_owner_id=$2,
         content_key_version=1, key_version=1, wrapped_dek=$3, dek_wrap_iv=$4,
         dek_wrap_auth_tag=$5, iv=$4, ciphertext=$6, auth_tag=$5, aad_version=1
       WHERE user_id=$1`,
      [userId, owner, Buffer.alloc(32, 4), Buffer.alloc(12, 5), Buffer.alloc(16, 6), Buffer.from("e2ee")],
    );
    assert.equal((await client.query("SELECT legacy_records::int AS n FROM content_legacy_retirement")).rows[0].n, 0);
    assert.equal((await client.query("SELECT has_table_privilege('toard_app','content_legacy_retirement','SELECT') AS ok")).rows[0].ok, true);

    await client.query(await migrationPart("1700000031_e2ee_legacy_retirement.sql", "down"));
    assert.equal((await client.query("SELECT to_regclass('content_legacy_retirement') AS name")).rows[0].name, null);
  } finally {
    await client?.end().catch(() => undefined);
    await execFileAsync("docker", ["rm", "-f", container]).catch(() => undefined);
  }
});
