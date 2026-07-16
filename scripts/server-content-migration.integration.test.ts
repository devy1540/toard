import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import { Client } from "pg";
import { encryptContent } from "../apps/web/lib/legacy-content-crypto";
import { decryptManagedContent } from "../apps/web/lib/managed-content-crypto";
import type { ManagedContentRuntime } from "../apps/web/lib/managed-content-runtime";
import {
  getServerContentMigrationUsers,
  migrateServerContentBatch,
  ServerContentMigrationError,
  type ServerMigrationDb,
} from "../apps/web/lib/server-content-migration";

const execFileAsync = promisify(execFile);
const LEGACY_KEK = Buffer.alloc(32, 0x31);
const UCK = Buffer.alloc(32, 0x52);
const INSTALLATION_ID = "019f7250-dc4d-78fd-98e8-a5465d0f5b69";

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

async function allMigrationUps(): Promise<Array<{ name: string; sql: string }>> {
  const names = (await readdir("migrations"))
    .filter((name) => /^17000000\d+.*\.sql$/.test(name))
    .sort((a, b) => a.localeCompare(b));
  return Promise.all(names.map(async (name) => {
    const source = await readFile(`migrations/${name}`, "utf8");
    const [up] = source.split("-- Down Migration", 1);
    assert.ok(up, `missing Up migration in ${name}`);
    return { name, sql: up };
  }));
}

function runtime(): ManagedContentRuntime {
  return {
    installationId: INSTALLATION_ID,
    registry: null as never,
    health: null as never,
    userKeys: {
      async withActiveUserKey(_userId, fn) {
        return fn(UCK, 3);
      },
      async withUserKeyVersion(_userId, _keyVersion, fn) {
        return fn(UCK);
      },
    },
  };
}

function trackedDb(client: Client) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const db: ServerMigrationDb = {
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      const result = await client.query(sql, params);
      return { rows: result.rows, rowCount: result.rowCount };
    },
  };
  return { db, calls };
}

async function insertLegacy(
  client: Client,
  userId: string,
  dedupKey: string,
  text: string,
  options: { corruptTag?: boolean; ts?: Date } = {},
): Promise<string> {
  const encrypted = encryptContent(text, LEGACY_KEK);
  const result = await client.query<{ id: string }>(
    `INSERT INTO prompt_records
       (dedup_key,user_id,session_id,provider_key,turn_role,ts,
        key_version,wrapped_dek,iv,ciphertext,auth_tag)
     VALUES($1,$2,$3,'codex','user',$4,$5,$6,$7,$8,$9)
     RETURNING id::text`,
    [
      dedupKey,
      userId,
      `session-${dedupKey}`,
      options.ts ?? new Date("2026-07-17T04:05:06.789Z"),
      encrypted.keyVersion,
      encrypted.wrappedDek,
      encrypted.iv,
      encrypted.ciphertext,
      options.corruptTag ? Buffer.alloc(15, 0x7f) : encrypted.authTag,
    ],
  );
  return result.rows[0]!.id;
}

async function setAppRole(client: Client): Promise<void> {
  await client.query("SET ROLE toard_app");
}

async function resetRole(client: Client): Promise<void> {
  await client.query("RESET ROLE");
}

test("server_v1 batches migrate atomically under exact user RLS", { timeout: 120_000 }, async () => {
  const container = `toard-server-content-${randomUUID().slice(0, 8)}`;
  let admin: Client | null = null;
  const clients: Client[] = [];

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

    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query("CREATE ROLE toard_app NOLOGIN NOSUPERUSER NOBYPASSRLS");
    for (const migration of await allMigrationUps()) {
      await admin.query(migration.sql).catch((error: unknown) => {
        throw new Error(`failed migration ${migration.name}`, { cause: error });
      });
    }
    await admin.query(`
      GRANT USAGE ON SCHEMA public TO toard_app;
      GRANT SELECT, UPDATE ON prompt_records TO toard_app;
    `);

    const users = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const [userA, userB, userC, userD] = users as [string, string, string, string];
    await admin.query(
      `INSERT INTO users(id,email) VALUES
         ($1,'server-migrate-a@example.com'),
         ($2,'server-migrate-b@example.com'),
         ($3,'server-migrate-c@example.com'),
         ($4,'server-migrate-d@example.com')`,
      users,
    );
    await admin.query(
      `INSERT INTO providers(key,display_name,service_name_patterns,collection_method)
       VALUES('codex','Codex',ARRAY['codex'],'logfile')`,
    );
    for (const userId of users) {
      await admin.query(
        `INSERT INTO managed_content_keys
           (user_id,key_version,provider,provider_key_ref,provider_fingerprint,
            wrapped_user_key,wrapper_metadata,context_version,state)
         VALUES($1,3,'local','integration:test','local:integration:test',$2,'{}',1,'active')`,
        [userId, Buffer.alloc(60, 0x61)],
      );
    }

    const beforeTs = new Date("2026-07-17T04:05:06.789Z");
    const firstId = await insertLegacy(admin, userA, "same-pk-canary", "legacy canary", { ts: beforeTs });
    await insertLegacy(admin, userB, "rollback-first", "rollback first");
    await insertLegacy(admin, userB, "rollback-corrupt", "rollback corrupt", { corruptTag: true });
    for (let index = 0; index < 27; index += 1) {
      await insertLegacy(admin, userC, `limit-${String(index).padStart(2, "0")}`, `batch ${index}`);
    }
    for (let index = 0; index < 4; index += 1) {
      await insertLegacy(admin, userD, `concurrent-${index}`, `concurrent ${index}`);
    }

    assert.deepEqual(await getServerContentMigrationUsers(admin), [...users].sort());

    const policy = await admin.query<{ qual: string; with_check: string }>(`
      SELECT pg_get_expr(polqual, polrelid) AS qual,
             pg_get_expr(polwithcheck, polrelid) AS with_check
      FROM pg_policy
      WHERE polrelid='prompt_records'::regclass AND polname='prompt_owner_update'
    `);
    assert.equal(policy.rowCount, 1);
    assert.match(policy.rows[0]!.qual, /app\.current_user_id/);
    assert.match(policy.rows[0]!.with_check, /app\.current_user_id/);
    assert.equal(
      (await admin.query<{ relforcerowsecurity: boolean }>(
        "SELECT relforcerowsecurity FROM pg_class WHERE oid='prompt_records'::regclass",
      )).rows[0]!.relforcerowsecurity,
      true,
    );

    const appA = new Client({ connectionString });
    clients.push(appA);
    await appA.connect();
    await setAppRole(appA);
    assert.equal((await appA.query("SELECT id FROM prompt_records")).rowCount, 0);
    const trackedA = trackedDb(appA);
    assert.deepEqual(
      await migrateServerContentBatch(userA, 25, runtime(), LEGACY_KEK, trackedA.db),
      { migrated: 1, remaining: 0 },
    );
    await resetRole(appA);

    const after = await admin.query(
      `SELECT id::text,dedup_key,session_id,provider_key,turn_role,ts,
              key_version,wrapped_dek,iv,ciphertext,auth_tag,encryption_scheme,
              content_owner_id,content_key_version,dek_wrap_iv,dek_wrap_auth_tag,aad_version
         FROM prompt_records WHERE id=$1`,
      [firstId],
    );
    assert.equal(after.rowCount, 1);
    const migrated = after.rows[0]!;
    assert.equal(migrated.id, firstId);
    assert.equal(migrated.dedup_key, "same-pk-canary");
    assert.equal(migrated.session_id, "session-same-pk-canary");
    assert.equal(migrated.provider_key, "codex");
    assert.equal(migrated.turn_role, "user");
    assert.equal((migrated.ts as Date).toISOString(), beforeTs.toISOString());
    assert.equal(migrated.encryption_scheme, "managed_v1");
    assert.equal(migrated.content_owner_id, null);
    assert.equal(migrated.key_version, 3);
    assert.equal(migrated.content_key_version, 3);
    assert.equal(migrated.aad_version, 2);
    assert.equal((migrated.wrapped_dek as Buffer).length, 32);
    assert.equal((migrated.dek_wrap_iv as Buffer).length, 12);
    assert.equal((migrated.dek_wrap_auth_tag as Buffer).length, 16);
    assert.equal(
      decryptManagedContent({
        dedupKey: migrated.dedup_key as string,
        sessionId: migrated.session_id as string | null,
        providerKey: migrated.provider_key as string,
        turnRole: migrated.turn_role as "user" | "assistant",
        ts: migrated.ts as Date,
        text: "not-used",
        encryptionScheme: "managed_v1",
        contentKeyVersion: migrated.content_key_version as number,
        aadVersion: 2,
        wrappedDek: migrated.wrapped_dek as Buffer,
        dekWrapIv: migrated.dek_wrap_iv as Buffer,
        dekWrapAuthTag: migrated.dek_wrap_auth_tag as Buffer,
        iv: migrated.iv as Buffer,
        ciphertext: migrated.ciphertext as Buffer,
        authTag: migrated.auth_tag as Buffer,
      }, UCK, INSTALLATION_ID, userA),
      "legacy canary",
    );
    assert.equal(
      trackedA.calls.some((call) => call.params.some((param) => param === "legacy canary")),
      false,
    );

    const appB = new Client({ connectionString });
    clients.push(appB);
    await appB.connect();
    await setAppRole(appB);
    const trackedB = trackedDb(appB);
    await assert.rejects(
      migrateServerContentBatch(userB, 25, runtime(), LEGACY_KEK, trackedB.db),
      (error: unknown) =>
        error instanceof ServerContentMigrationError
        && error.code === "LEGACY_SOURCE_CORRUPT",
    );
    await resetRole(appB);
    assert.deepEqual(
      (await admin.query(
        "SELECT encryption_scheme FROM prompt_records WHERE user_id=$1 ORDER BY id",
        [userB],
      )).rows.map((row) => row.encryption_scheme),
      ["server_v1", "server_v1"],
    );

    const appC = new Client({ connectionString });
    clients.push(appC);
    await appC.connect();
    await setAppRole(appC);
    assert.deepEqual(
      await migrateServerContentBatch(userC, 99, runtime(), LEGACY_KEK, trackedDb(appC).db),
      { migrated: 25, remaining: 2 },
    );
    await resetRole(appC);
    assert.equal(
      (await admin.query(
        "SELECT COUNT(*)::int AS count FROM prompt_records WHERE user_id=$1 AND encryption_scheme='server_v1'",
        [userC],
      )).rows[0].count,
      2,
    );

    const concurrentA = new Client({ connectionString });
    const concurrentB = new Client({ connectionString });
    clients.push(concurrentA, concurrentB);
    await Promise.all([concurrentA.connect(), concurrentB.connect()]);
    await Promise.all([setAppRole(concurrentA), setAppRole(concurrentB)]);
    const concurrentResults = await Promise.all([
      migrateServerContentBatch(userD, 2, runtime(), LEGACY_KEK, trackedDb(concurrentA).db),
      migrateServerContentBatch(userD, 2, runtime(), LEGACY_KEK, trackedDb(concurrentB).db),
    ]);
    assert.equal(concurrentResults.reduce((sum, value) => sum + value.migrated, 0), 4);
    await Promise.all([resetRole(concurrentA), resetRole(concurrentB)]);
    assert.equal(
      (await admin.query(
        "SELECT COUNT(*)::int AS count FROM prompt_records WHERE user_id=$1 AND encryption_scheme='managed_v1'",
        [userD],
      )).rows[0].count,
      4,
    );

    const status = await admin.query(
      `SELECT server_records::int,managed_records::int
         FROM content_encryption_status WHERE singleton=TRUE`,
    );
    assert.deepEqual(status.rows[0], { server_records: 4, managed_records: 30 });
  } finally {
    for (const client of clients) await client.end().catch(() => undefined);
    await admin?.end().catch(() => undefined);
    await execFileAsync("docker", ["rm", "-f", container]).catch(() => undefined);
    LEGACY_KEK.fill(0x31);
    UCK.fill(0x52);
  }
});
