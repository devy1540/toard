import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import { Client } from "pg";

const execFileAsync = promisify(execFile);

async function migrationPart(filename: string, direction: "up" | "down"): Promise<string> {
  const sql = await readFile(`migrations/${filename}`, "utf8");
  const [up, down] = sql.split("-- Down Migration", 2);
  return direction === "up" ? up : down;
}

async function waitForPostgres(connectionString: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const probe = new Client({ connectionString, connectionTimeoutMillis: 1_000 });
    try {
      await probe.connect();
      await probe.query("SELECT 1");
      await probe.end();
      return;
    } catch {
      await probe.end().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error("PostgreSQL did not become ready");
}

test("passkey MFA migration enforces credential shape, one-time challenges, and app-role access", { timeout: 90_000 }, async () => {
  const container = `toard-mfa-migration-${randomUUID().slice(0, 8)}`;
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
    assert.ok(port);
    const connectionString = `postgresql://postgres:postgres@127.0.0.1:${port}/toard`;
    await waitForPostgres(connectionString);
    client = new Client({ connectionString });
    await client.connect();
    await client.query(await migrationPart("1700000001_init.sql", "up"));
    await client.query(await migrationPart("1700000005_user_password.sql", "up"));
    await client.query("CREATE ROLE toard_app NOLOGIN");
    await client.query(await migrationPart("1700000048_user_mfa.sql", "up"));

    const userId = randomUUID();
    await client.query("INSERT INTO users(id,email,password_hash) VALUES($1,'mfa@example.com','hash')", [userId]);
    await client.query("INSERT INTO user_mfa_settings(user_id,login_required,history_required) VALUES($1,true,true)", [userId]);
    await client.query(
      `INSERT INTO user_passkeys(credential_id,user_id,public_key,counter,device_type,backed_up,label)
       VALUES('credential-1',$1,$2,0,'multiDevice',true,'Apple Passwords')`,
      [userId, Buffer.from("public-key")],
    );
    await assert.rejects(
      client.query(
        `INSERT INTO user_passkeys(credential_id,user_id,public_key,counter,device_type,backed_up,label)
         VALUES('credential-2',$1,$2,-1,'invalid',false,'')`,
        [userId, Buffer.from("public-key")],
      ),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "23514",
    );

    const privileges = await client.query<{ table_name: string; privilege_type: string }>(
      `SELECT table_name, privilege_type
         FROM information_schema.role_table_grants
        WHERE grantee = 'toard_app'
          AND table_name IN ('user_mfa_settings','user_passkeys','user_passkey_challenges')`,
    );
    assert.equal(privileges.rowCount, 12);

    await client.query(await migrationPart("1700000048_user_mfa.sql", "down"));
    assert.equal(
      (await client.query("SELECT to_regclass('public.user_mfa_settings') AS name")).rows[0].name,
      null,
    );
  } finally {
    await client?.end().catch(() => undefined);
    await execFileAsync("docker", ["rm", "-f", container]).catch(() => undefined);
  }
});
