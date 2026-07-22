import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import { Client } from "pg";

const execFileAsync = promisify(execFile);
async function up(filename: string) { return (await readFile(`migrations/${filename}`, "utf8")).split("-- Down Migration", 1)[0]; }
async function waitForPostgres(url: string) {
  for (let i = 0; i < 120; i += 1) {
    const probe = new Client({ connectionString: url, connectionTimeoutMillis: 1_000 });
    try { await probe.connect(); await probe.end(); return; } catch { await probe.end().catch(() => undefined); await new Promise((r) => setTimeout(r, 250)); }
  }
  throw new Error("PostgreSQL did not become ready");
}

test("passkey MFA store creates WebAuthn registration options and keeps policies independent", { timeout: 90_000 }, async () => {
  const container = `toard-passkey-store-${randomUUID().slice(0, 8)}`;
  let client: Client | null = null;
  try {
    await execFileAsync("docker", ["run","-d","--rm","--name",container,"-e","POSTGRES_PASSWORD=postgres","-e","POSTGRES_DB=toard","-p","127.0.0.1::5432","postgres:16-alpine"]);
    const { stdout } = await execFileAsync("docker", ["port", container, "5432/tcp"]);
    const port = stdout.trim().match(/:(\d+)$/)?.[1]; assert.ok(port);
    const url = `postgresql://postgres:postgres@127.0.0.1:${port}/toard`;
    await waitForPostgres(url); client = new Client({ connectionString: url }); await client.connect();
    await client.query(await up("1700000001_init.sql")); await client.query(await up("1700000005_user_password.sql")); await client.query(await up("1700000048_user_mfa.sql"));
    const userId = randomUUID(); await client.query("INSERT INTO users(id,email,password_hash) VALUES($1,'store@example.com','hash')", [userId]);
    process.env.DATABASE_URL = url;
    const store = await import("../apps/web/lib/mfa-store");
    const { closePool } = await import("../apps/web/lib/db");
    const ceremony = await store.beginPasskeyRegistration({ userId, email: "store@example.com", context: { origin: "http://localhost:3000", rpID: "localhost", rpName: "toard" } });
    assert.ok(ceremony.challengeId); assert.equal(ceremony.options.rp.id, "localhost"); assert.equal(ceremony.options.authenticatorSelection?.userVerification, "required");
    assert.equal((await client.query("SELECT count(*)::int AS count FROM user_passkey_challenges")).rows[0].count, 1);
    await client.query(`INSERT INTO user_passkeys(credential_id,user_id,public_key,counter,device_type,backed_up,label) VALUES('key-1',$1,$2,0,'multiDevice',true,'Passkey')`, [userId, Buffer.from("key")]);
    const enabled = await store.updateMfaPolicies({ userId, loginRequired: true, historyRequired: false });
    assert.equal(enabled.loginRequired, true); assert.equal(enabled.historyRequired, false); assert.equal(enabled.passkeys.length, 1);
    const history = await store.updateMfaPolicies({ userId, loginRequired: false, historyRequired: true });
    assert.equal(history.loginRequired, false); assert.equal(history.historyRequired, true);
    await assert.rejects(store.deletePasskey(userId, "key-1"), (error: unknown) => error instanceof store.MfaError && error.code === "PASSKEY_LAST_PROTECTED");
    await client.query(`INSERT INTO user_passkeys(credential_id,user_id,public_key,counter,device_type,backed_up,label) VALUES('key-2',$1,$2,0,'multiDevice',true,'Second passkey')`, [userId, Buffer.from("key-2")]);
    const afterDelete = await store.deletePasskey(userId, "key-1");
    assert.equal(afterDelete.passkeys.length, 1); assert.equal(afterDelete.passkeys[0]?.id, "key-2");
    await closePool();
  } finally { await client?.end().catch(() => undefined); await execFileAsync("docker", ["rm","-f",container]).catch(() => undefined); }
});
