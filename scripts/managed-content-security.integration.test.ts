import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { Client } from "pg";
import { legacyE2eeCapability } from "../apps/web/lib/e2ee-legacy-gate";
import { encryptManagedContent } from "../apps/web/lib/managed-content-crypto";
import { getMyHistorySession } from "../apps/web/lib/prompt-history";
import { LocalKeyManagementProvider } from "../apps/web/lib/key-management/local-provider";
import type { KeyContext, WrappedUserKey } from "../apps/web/lib/key-management/types";
import type { ManagedContentRuntime } from "../apps/web/lib/managed-content-runtime";

const execFileAsync = promisify(execFile);
const PLAINTEXT = "TOARD_MANAGED_PLAINTEXT_CANARY_29e4";
const CLOUD_CREDENTIAL_MARKER = "AWS_SECRET_ACCESS_KEY=TOARD_MUST_NOT_PERSIST_29e4";

test("managed content는 DB dump만으로 복호화할 수 없고 app 권한과 RLS를 함께 요구한다", { timeout: 180_000 }, async () => {
  const container = `toard-managed-security-${randomUUID().slice(0, 8)}`;
  const secretDirectory = await mkdtemp(join(tmpdir(), "toard-managed-security-"));
  const keyFile = join(secretDirectory, "local-kek");
  let admin: Client | null = null;
  let app: Client | null = null;
  const uck = randomBytes(32);
  const kek = randomBytes(32);
  try {
    await chmod(secretDirectory, 0o700);
    await writeFile(keyFile, kek, { mode: 0o600, flag: "wx" });
    assert.equal((await stat(keyFile)).mode & 0o777, 0o600);

    await execFileAsync("docker", [
      "run", "-d", "--rm", "--name", container,
      "-e", "POSTGRES_PASSWORD=postgres", "-e", "POSTGRES_DB=toard",
      "-p", "127.0.0.1::5432", "postgres:16-alpine",
    ]);
    const { stdout } = await execFileAsync("docker", ["port", container, "5432/tcp"]);
    const port = stdout.trim().match(/:(\d+)$/)?.[1];
    assert.ok(port);
    const adminUrl = `postgresql://postgres:postgres@127.0.0.1:${port}/toard`;
    await waitForPostgres(adminUrl);
    admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query("CREATE ROLE toard_app LOGIN PASSWORD 'integration-app-password' NOSUPERUSER NOBYPASSRLS");
    for (const migration of await allMigrationUps()) await admin.query(migration.sql);
    await admin.query(`
      GRANT USAGE ON SCHEMA public TO toard_app;
      GRANT SELECT ON ALL TABLES IN SCHEMA public TO toard_app;
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO toard_app;
    `);

    const userA = randomUUID();
    const userB = randomUUID();
    const legacyUser = randomUUID();
    await admin.query(
      `INSERT INTO users(id,email) VALUES
       ($1,'managed-security-a@example.test'),
       ($2,'managed-security-b@example.test'),
       ($3,'managed-security-legacy@example.test')`,
      [userA, userB, legacyUser],
    );
    await admin.query(
      "INSERT INTO providers(key,display_name,service_name_patterns,collection_method) VALUES('codex','Codex',ARRAY['codex'],'logfile')",
    );
    const installationId = String((await admin.query("SELECT installation_id FROM installation_identity WHERE singleton=TRUE")).rows[0]!.installation_id);

    const provider = new LocalKeyManagementProvider({ keyFile });
    const context: KeyContext = { installationId, userId: userA, keyVersion: 1, purpose: "prompt-history" };
    const wrapper = await provider.wrapKey(uck, context);
    const ts = new Date("2026-07-17T05:00:00.000Z");
    const encrypted = encryptManagedContent({
      schema: "server_v1", dedupKey: "managed-security-canary", sessionId: "managed-security-session",
      providerKey: "codex", turnRole: "user", ts, text: PLAINTEXT,
    }, uck, installationId, userA, 1);

    await admin.query(
      `INSERT INTO managed_content_keys
       (user_id,key_version,provider,provider_key_ref,provider_fingerprint,
        wrapped_user_key,wrapper_metadata,context_version,state)
       VALUES($1,1,$2,$3,$4,$5,$6::jsonb,1,'active')`,
      [userA, wrapper.provider, wrapper.keyRef, wrapper.fingerprint, wrapper.ciphertext, JSON.stringify(wrapper.metadata)],
    );
    await admin.query(
      `INSERT INTO prompt_records
       (dedup_key,user_id,session_id,provider_key,turn_role,ts,key_version,wrapped_dek,iv,ciphertext,auth_tag,
        encryption_scheme,content_key_version,dek_wrap_iv,dek_wrap_auth_tag,aad_version)
       VALUES($1,$2,$3,'codex','user',$4,1,$5,$6,$7,$8,'managed_v1',1,$9,$10,2)`,
      ["managed-security-canary", userA, "managed-security-session", ts, encrypted.wrappedDek,
        encrypted.iv, encrypted.ciphertext, encrypted.authTag, encrypted.dekWrapIv, encrypted.dekWrapAuthTag],
    );

    const legacyAccount = await admin.query<{ content_owner_id: string }>(
      `INSERT INTO content_accounts(user_id,state,recovery_confirmed_at)
       VALUES($1,'active',now()) RETURNING content_owner_id`,
      [legacyUser],
    );
    await admin.query(
      `INSERT INTO prompt_records
       (dedup_key,user_id,session_id,provider_key,turn_role,ts,key_version,wrapped_dek,iv,ciphertext,auth_tag,
        encryption_scheme,content_owner_id,content_key_version,dek_wrap_iv,dek_wrap_auth_tag,aad_version)
       VALUES('legacy-gate-canary',$1,'legacy-gate-session','codex','user',$2,1,$3,$4,$5,$6,
              'e2ee_v1',$7,1,$8,$9,1)`,
      [legacyUser, ts, Buffer.alloc(32, 1), Buffer.alloc(12, 2), Buffer.alloc(32, 3), Buffer.alloc(16, 4),
        legacyAccount.rows[0]!.content_owner_id, Buffer.alloc(12, 5), Buffer.alloc(16, 6)],
    );

    const appUrl = `postgresql://toard_app:integration-app-password@127.0.0.1:${port}/toard`;
    app = new Client({ connectionString: appUrl });
    await app.connect();

    assert.equal(await inUserContext(app, legacyUser, (db) => legacyE2eeCapability(legacyUser, db)), "migration");
    assert.equal(await inUserContext(app, userA, (db) => legacyE2eeCapability(legacyUser, db)), "disabled");
    await admin.query(
      `UPDATE content_e2ee_migrations SET state='blocked',blocked_at=now(),blocked_reason='key_unavailable',updated_at=now()
       WHERE user_id=$1`,
      [legacyUser],
    );
    assert.equal(await inUserContext(app, legacyUser, (db) => legacyE2eeCapability(legacyUser, db)), "recovery");

    const runtime = runtimeFor(provider, wrapper, context, installationId);
    const ownHistory = await inUserContext(app, userA, (db) => getMyHistorySession(
      userA, "managed-security-session", { db, runtime, legacyKek: null },
    ));
    assert.equal(ownHistory.session?.turns[0]?.text, PLAINTEXT);
    const otherHistory = await inUserContext(app, userB, (db) => getMyHistorySession(
      userA, "managed-security-session", { db, runtime, legacyKek: null },
    ));
    assert.equal(otherHistory.session, null, "다른 사용자나 admin UI session context는 타 사용자 row를 읽지 못해야 한다");
    assert.equal(await inUserContext(app, userB, async (db) => (
      await db.query("SELECT COUNT(*)::int AS count FROM managed_content_keys WHERE user_id=$1", [userA])
    ).rows[0]!.count), 0);

    const superuserView = await admin.query(
      `SELECT octet_length(record.ciphertext) AS ciphertext_bytes,
              octet_length(key.wrapped_user_key) AS wrapper_bytes
       FROM prompt_records record JOIN managed_content_keys key ON key.user_id=record.user_id
       WHERE record.user_id=$1 AND record.encryption_scheme='managed_v1'`,
      [userA],
    );
    assert.ok(Number(superuserView.rows[0]?.ciphertext_bytes) > 0);
    assert.ok(Number(superuserView.rows[0]?.wrapper_bytes) > 0);

    const { stdout: dump } = await execFileAsync("docker", [
      "exec", container, "pg_dump", "-U", "postgres", "--data-only", "--column-inserts", "toard",
    ], { maxBuffer: 16 * 1024 * 1024 });
    assert.equal(dump.includes(PLAINTEXT), false);
    assert.equal(dump.includes(uck.toString("base64")), false);
    assert.equal(dump.includes(kek.toString("base64")), false);
    assert.equal(dump.includes(kek.toString("hex")), false);
    assert.equal(dump.includes(CLOUD_CREDENTIAL_MARKER), false);
    assert.match(dump, /managed-security-canary/);
    assert.match(dump, /managed_content_keys/);

    // DB artifact와 wrapper를 가진 별도 process라도 KEK file 접근이 없으면 unwrap할 수 없다.
    await chmod(keyFile, 0o000);
    const childSource = `
      import { LocalKeyManagementProvider } from ${JSON.stringify(new URL("../apps/web/lib/key-management/local-provider.ts", import.meta.url).href)};
      const wrapped = JSON.parse(process.env.WRAPPED);
      wrapped.ciphertext = Buffer.from(wrapped.ciphertext, "base64");
      try {
        const provider = new LocalKeyManagementProvider({ keyFile: process.env.KEY_FILE });
        await provider.unwrapKey(wrapped, JSON.parse(process.env.CONTEXT));
        console.log("UNEXPECTED_DECRYPT"); process.exitCode = 2;
      } catch { console.log("DECRYPT_DENIED"); }
    `;
    const child = await execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childSource], {
      env: {
        PATH: process.env.PATH,
        WRAPPED: JSON.stringify({ ...wrapper, ciphertext: wrapper.ciphertext.toString("base64") }),
        CONTEXT: JSON.stringify(context),
        KEY_FILE: keyFile,
      },
    });
    assert.equal(child.stdout.trim(), "DECRYPT_DENIED");
    assert.equal(`${child.stdout}${child.stderr}`.includes(PLAINTEXT), false);
    assert.equal(`${child.stdout}${child.stderr}`.includes(uck.toString("base64")), false);
    await chmod(keyFile, 0o600);
  } finally {
    uck.fill(0);
    kek.fill(0);
    await app?.end().catch(() => undefined);
    await admin?.end().catch(() => undefined);
    await execFileAsync("docker", ["rm", "-f", container]).catch(() => undefined);
    await chmod(keyFile, 0o600).catch(() => undefined);
    await rm(secretDirectory, { recursive: true, force: true });
  }
});

function runtimeFor(
  provider: LocalKeyManagementProvider,
  wrapped: WrappedUserKey,
  context: KeyContext,
  installationId: string,
): ManagedContentRuntime {
  return {
    installationId,
    registry: null as never,
    health: null as never,
    userKeys: {
      async withActiveUserKey(_userId, fn) {
        const key = await provider.unwrapKey(wrapped, context);
        try { return await fn(key, 1); } finally { key.fill(0); }
      },
      async withUserKeyVersion(_userId, _version, fn) {
        const key = await provider.unwrapKey(wrapped, context);
        try { return await fn(key); } finally { key.fill(0); }
      },
    },
  };
}

async function inUserContext<T>(client: Client, userId: string, fn: (db: Client) => Promise<T>): Promise<T> {
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('app.current_user_id',$1,true)", [userId]);
    const value = await fn(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function allMigrationUps(): Promise<Array<{ name: string; sql: string }>> {
  const names = (await readdir("migrations")).filter((name) => /^17000000\d+.*\.sql$/.test(name)).sort();
  return Promise.all(names.map(async (name) => ({
    name,
    sql: (await readFile(`migrations/${name}`, "utf8")).split("-- Down Migration", 1)[0]!,
  })));
}

async function waitForPostgres(connectionString: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const probe = new Client({ connectionString, connectionTimeoutMillis: 1_000 });
    try { await probe.connect(); await probe.query("SELECT 1"); await probe.end(); return; }
    catch (error) { lastError = error; await probe.end().catch(() => undefined); await new Promise((resolve) => setTimeout(resolve, 250)); }
  }
  throw lastError;
}
