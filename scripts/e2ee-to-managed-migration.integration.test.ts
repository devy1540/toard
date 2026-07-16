import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import { Client } from "pg";
import { decryptManagedContent } from "../apps/web/lib/managed-content-crypto";
import type { ManagedContentRuntime } from "../apps/web/lib/managed-content-runtime";
import {
  E2eeManagedMigrationError,
  commitE2eeManagedBatch,
  getE2eeManagedMigrationPage,
  getE2eeManagedMigrationStatus,
  type E2eeMigrationDb,
} from "../apps/web/lib/e2ee-to-managed-migration";

const execFileAsync = promisify(execFile);
const UCK = Buffer.alloc(32, 0x62);
const INSTALLATION_ID = "019f7250-dc4d-78fd-98e8-a5465d0f5b69";

async function waitForPostgres(connectionString: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let last: unknown;
  while (Date.now() < deadline) {
    const probe = new Client({ connectionString, connectionTimeoutMillis: 1_000 });
    try { await probe.connect(); await probe.query("SELECT 1"); await probe.end(); return; }
    catch (error) { last = error; await probe.end().catch(() => undefined); await new Promise((resolve) => setTimeout(resolve, 200)); }
  }
  throw last;
}

async function migrationUps(): Promise<string[]> {
  const names = (await readdir("migrations")).filter((name) => /^17000000\d+.*\.sql$/.test(name)).sort();
  return Promise.all(names.map(async (name) => (await readFile(`migrations/${name}`, "utf8")).split("-- Down Migration", 1)[0]!));
}

function runtime(): ManagedContentRuntime {
  return { installationId: INSTALLATION_ID, registry: null as never, health: null as never,
    userKeys: {
      async withActiveUserKey(_userId, fn) { return fn(UCK, 4); },
      async withUserKeyVersion(_userId, _version, fn) { return fn(UCK); },
    } };
}

function db(client: Client): E2eeMigrationDb {
  return { async query(sql, params = []) { const result = await client.query(sql, params); return { rows: result.rows, rowCount: result.rowCount }; } };
}

async function insertE2ee(admin: Client, userId: string, ownerId: string, dedup: string): Promise<string> {
  const result = await admin.query<{ id: string }>(
    `INSERT INTO prompt_records
       (dedup_key,user_id,session_id,provider_key,turn_role,ts,key_version,wrapped_dek,
        iv,ciphertext,auth_tag,encryption_scheme,content_owner_id,content_key_version,
        dek_wrap_iv,dek_wrap_auth_tag,aad_version)
     VALUES($1,$2,'session','codex','user','2026-07-17T01:02:03Z',2,$3,$4,$5,$6,
            'e2ee_v1',$7,2,$8,$9,1) RETURNING id::text`,
    [dedup, userId, Buffer.alloc(32, 1), Buffer.alloc(12, 2), Buffer.from(`cipher-${dedup}`),
      Buffer.alloc(16, 3), ownerId, Buffer.alloc(12, 4), Buffer.alloc(16, 5)],
  );
  return result.rows[0]!.id;
}

test("E2EE managed migration service enforces RLS, same-row replacement, atomic state, and late-source reopening", { timeout: 120_000 }, async () => {
  const container = `toard-e2ee-managed-${randomUUID().slice(0, 8)}`;
  let admin: Client | null = null; let app: Client | null = null;
  try {
    await execFileAsync("docker", ["run", "-d", "--rm", "--name", container, "-e", "POSTGRES_PASSWORD=postgres", "-e", "POSTGRES_DB=toard", "-p", "127.0.0.1::5432", "postgres:16-alpine"]);
    const { stdout } = await execFileAsync("docker", ["port", container, "5432/tcp"]);
    const port = stdout.trim().match(/:(\d+)$/)?.[1]; assert.ok(port);
    const connectionString = `postgresql://postgres:postgres@127.0.0.1:${port}/toard`;
    await waitForPostgres(connectionString);
    admin = new Client({ connectionString }); await admin.connect();
    await admin.query("CREATE ROLE toard_app NOLOGIN NOSUPERUSER NOBYPASSRLS");
    for (const sql of await migrationUps()) await admin.query(sql);
    await admin.query(`GRANT USAGE ON SCHEMA public TO toard_app;
      GRANT SELECT,UPDATE ON prompt_records,content_accounts,content_e2ee_migrations TO toard_app;
      GRANT SELECT ON content_key_wrappers TO toard_app;`);

    const userA = randomUUID(), userB = randomUUID(), ownerA = randomUUID(), ownerB = randomUUID();
    await admin.query("INSERT INTO users(id,email) VALUES($1,'e2ee-a@example.com'),($2,'e2ee-b@example.com')", [userA, userB]);
    await admin.query("INSERT INTO providers(key,display_name,service_name_patterns,collection_method) VALUES('codex','Codex',ARRAY['codex'],'logfile')");
    await admin.query(`INSERT INTO content_accounts(user_id,content_owner_id,state,recovery_confirmed_at)
      VALUES($1,$2,'active',now()),($3,$4,'active',now())`, [userA, ownerA, userB, ownerB]);
    await admin.query(`INSERT INTO content_key_wrappers
      (user_id,content_key_version,wrapper_type,wrapper_ref,kdf_version,public_salt_or_input,
       nonce,auth_tag,encapsulated_key,wrapped_content_key)
      VALUES($1,1,'recovery','recovery','hkdf-sha256-v1',$2,$3,$4,NULL,$5)`,
      [userA, Buffer.alloc(32, 11), Buffer.alloc(12, 12), Buffer.alloc(16, 13), Buffer.alloc(32, 14)]);
    const firstId = await insertE2ee(admin, userA, ownerA, "first");
    await insertE2ee(admin, userB, ownerB, "other-user-a");
    await insertE2ee(admin, userB, ownerB, "other-user-b");

    app = new Client({ connectionString }); await app.connect(); await app.query("SET ROLE toard_app");
    const appDb = db(app);
    const page = await getE2eeManagedMigrationPage(userA, 25, appDb);
    assert.equal(page.records.length, 1); assert.equal(page.records[0]!.id, firstId);
    const otherPage = await getE2eeManagedMigrationPage(userB, 25, appDb);
    assert.equal(otherPage.records.length, 2, "service changes exact RLS context per transaction");
    await assert.rejects(commitE2eeManagedBatch(userB, [
      { id: otherPage.records[0]!.id, sourceDigest: otherPage.records[0]!.sourceDigest, text: "must roll back" },
      { id: otherPage.records[1]!.id, sourceDigest: Buffer.alloc(32).toString("base64url"), text: "stale" },
    ], runtime(), appDb), (error: unknown) =>
      error instanceof E2eeManagedMigrationError && error.code === "E2EE_SOURCE_CHANGED");
    assert.equal((await getE2eeManagedMigrationPage(userB, 25, appDb)).records.length, 2, "second-row failure rolls back the first update");
    await app.query("BEGIN");
    await app.query("SELECT set_config('app.current_user_id',$1,true)", [userA]);
    assert.equal((await app.query("SELECT id FROM prompt_records WHERE user_id=$1", [userB])).rowCount, 0);
    await app.query("ROLLBACK");
    const result = await commitE2eeManagedBatch(userA, [{ id: firstId, sourceDigest: page.records[0]!.sourceDigest, text: "browser plaintext" }], runtime(), appDb);
    assert.deepEqual(result, { migrated: 1, remaining: 0, complete: true });
    await app.query("RESET ROLE");

    const after = (await admin.query("SELECT * FROM prompt_records WHERE id=$1", [firstId])).rows[0]!;
    assert.equal(after.id.toString(), firstId); assert.equal(after.encryption_scheme, "managed_v1");
    assert.equal(after.content_owner_id, null); assert.equal(after.aad_version, 2);
    assert.equal(decryptManagedContent({ dedupKey: after.dedup_key, sessionId: after.session_id,
      providerKey: after.provider_key, turnRole: after.turn_role, ts: after.ts, text: "unused",
      encryptionScheme: "managed_v1", contentKeyVersion: after.content_key_version,
      aadVersion: 2, wrappedDek: after.wrapped_dek, dekWrapIv: after.dek_wrap_iv,
      dekWrapAuthTag: after.dek_wrap_auth_tag, iv: after.iv, ciphertext: after.ciphertext,
      authTag: after.auth_tag }, UCK, INSTALLATION_ID, userA), "browser plaintext");
    assert.deepEqual((await admin.query("SELECT state FROM content_e2ee_migrations WHERE user_id=$1", [userA])).rows, [{ state: "complete" }]);
    assert.deepEqual((await admin.query("SELECT state FROM content_accounts WHERE user_id=$1", [userA])).rows, [{ state: "migrated" }]);

    await admin.query(`INSERT INTO prompt_records
      (dedup_key,user_id,provider_key,turn_role,ts,key_version,wrapped_dek,iv,ciphertext,auth_tag,
       encryption_scheme,content_owner_id,content_key_version,dek_wrap_iv,dek_wrap_auth_tag,aad_version)
      VALUES('unrelated-managed',$1,'codex','assistant',now(),4,$2,$3,$4,$5,
             'managed_v1',NULL,4,$3,$5,2)`,
      [userA, Buffer.alloc(32, 21), Buffer.alloc(12, 22), Buffer.from("unrelated"), Buffer.alloc(16, 23)]);
    await app.query("SET ROLE toard_app");
    assert.deepEqual(await getE2eeManagedMigrationStatus(userA, appDb).then(({ e2eeRecords, migratedRecords }) => ({ e2eeRecords, migratedRecords })),
      { e2eeRecords: 0, migratedRecords: 1 });
    await app.query("BEGIN");
    await app.query("SELECT set_config('app.current_user_id',$1,true)", [userA]);
    await assert.rejects(app.query("SELECT * FROM get_content_e2ee_migration_progress($1)", [userB]),
      (error: unknown) => (error as { code?: string }).code === "42501" && /user mismatch/.test(String(error)));
    await app.query("ROLLBACK");
    await app.query("RESET ROLE");

    const lateId = await insertE2ee(admin, userA, ownerA, "late");
    assert.deepEqual((await admin.query("SELECT state,completed_at FROM content_e2ee_migrations WHERE user_id=$1", [userA])).rows, [{ state: "pending", completed_at: null }]);
    assert.deepEqual((await admin.query("SELECT state,(recovery_confirmed_at IS NOT NULL) AS recovery_ready FROM content_accounts WHERE user_id=$1", [userA])).rows,
      [{ state: "active", recovery_ready: true }]);
    await app.query("SET ROLE toard_app");
    const latePage = await getE2eeManagedMigrationPage(userA, 25, appDb);
    assert.deepEqual(latePage.records.map((record) => record.id), [lateId]);
    assert.deepEqual(await getE2eeManagedMigrationStatus(userA, appDb).then(({ state, e2eeRecords, migratedRecords }) => ({ state, e2eeRecords, migratedRecords })),
      { state: "pending", e2eeRecords: 1, migratedRecords: 1 });
    await app.query("BEGIN");
    await app.query("SELECT set_config('app.current_user_id',$1,true)", [userA]);
    assert.equal((await app.query("SELECT id FROM content_key_wrappers WHERE user_id=$1 AND wrapper_type='recovery'", [userA])).rowCount, 1);
    await app.query("ROLLBACK");
    assert.deepEqual(await commitE2eeManagedBatch(userA, [{ id: lateId, sourceDigest: latePage.records[0]!.sourceDigest, text: "late plaintext" }], runtime(), appDb),
      { migrated: 1, remaining: 0, complete: true });
    await app.query("RESET ROLE");
    assert.deepEqual((await admin.query("SELECT state FROM content_accounts WHERE user_id=$1", [userA])).rows, [{ state: "migrated" }]);
  } finally {
    await app?.end().catch(() => undefined); await admin?.end().catch(() => undefined);
    await execFileAsync("docker", ["rm", "-f", container]).catch(() => undefined); UCK.fill(0x62);
  }
});
