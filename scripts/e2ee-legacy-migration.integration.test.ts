import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import { Client } from "pg";
import { encryptContent } from "../apps/web/lib/content-crypto";
import { decryptE2eeRecord, encryptE2eeRecord } from "../apps/web/lib/e2ee-browser-crypto";
import { commitLegacyMigrationBatch, getLegacyMigrationPage } from "../apps/web/lib/e2ee-legacy-migration";

const execFileAsync = promisify(execFile);
const CANARY = "LEGACY_MIGRATION_CANARY_91d7";

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
  throw new Error("POSTGRES_START_TIMEOUT");
}

async function applyUp(client: Client, filename: string): Promise<void> {
  const sql = await readFile(`migrations/${filename}`, "utf8");
  await client.query(sql.split("-- Down Migration", 1)[0]);
}

test("pre-existing server_v1 row is atomically replaced with browser E2EE", { timeout: 90_000 }, async () => {
  const container = `toard-e2ee-legacy-${randomUUID().slice(0, 8)}`;
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
    await applyUp(client, "1700000001_init.sql");
    await applyUp(client, "1700000010_prompt_records.sql");

    const userId = randomUUID();
    const browserId = randomUUID();
    const ownerId = randomUUID();
    const kek = Buffer.alloc(32, 19);
    const legacy = encryptContent(CANARY, kek);
    await client.query("INSERT INTO users(id,email) VALUES($1,'legacy-migration@example.com')", [userId]);
    await client.query(
      "INSERT INTO providers(key,display_name,service_name_patterns,collection_method) VALUES('codex','Codex',ARRAY['codex'],'logfile')",
    );
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO prompt_records
         (dedup_key,user_id,session_id,provider_key,turn_role,ts,key_version,wrapped_dek,iv,ciphertext,auth_tag)
       VALUES('legacy-canary',$1,'session-1','codex','user','2026-07-14T00:00:00Z',$2,$3,$4,$5,$6)
       RETURNING id`,
      [userId, legacy.keyVersion, legacy.wrappedDek, legacy.iv, legacy.ciphertext, legacy.authTag],
    );
    const originalId = inserted.rows[0]!.id;
    await applyUp(client, "1700000028_e2ee_content_foundation.sql");
    await client.query(
      `INSERT INTO content_accounts(user_id,content_owner_id,state,recovery_confirmed_at)
       VALUES($1,$2,'active',now())`,
      [userId, ownerId],
    );
    await client.query(
      `INSERT INTO content_devices(id,user_id,kind,label,platform,public_key,algorithm_version,approved_at)
       VALUES($1,$2,'browser','Integration browser','test',$3,'hpke-p256-v1',now())`,
      [browserId, userId, Buffer.alloc(65, 4)],
    );

    const db = { query: (sql: string, params?: unknown[]) => client!.query(sql, params) };
    const source = (await getLegacyMigrationPage(userId, browserId, kek, 25, db)).records[0]!;
    assert.equal(source.text, CANARY);
    const uck = crypto.getRandomValues(new Uint8Array(32));
    const record = await encryptE2eeRecord(uck, source, ownerId, 1);
    assert.equal(new TextDecoder().decode(await decryptE2eeRecord(uck, record)), CANARY);
    await commitLegacyMigrationBatch(
      userId,
      browserId,
      [{ id: source.id, sourceDigest: source.sourceDigest, record }],
      kek,
      db,
    );

    const after = await client.query(
      "SELECT id,encryption_scheme,content_owner_id,ciphertext FROM prompt_records WHERE dedup_key='legacy-canary'",
    );
    assert.equal(after.rows[0].id, originalId);
    assert.equal(after.rows[0].encryption_scheme, "e2ee_v1");
    assert.equal(after.rows[0].content_owner_id, ownerId);
    assert.equal((await client.query("SELECT COUNT(*)::int AS count FROM prompt_records WHERE encryption_scheme='server_v1'")).rows[0].count, 0);
    assert.equal(JSON.stringify(after.rows).includes(CANARY), false);
  } finally {
    await client?.end().catch(() => undefined);
    await execFileAsync("docker", ["rm", "-f", container]).catch(() => undefined);
  }
});
