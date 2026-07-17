import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import { Client, Pool } from "pg";
import { encryptManagedContent } from "../apps/web/lib/managed-content-crypto";
import type { ManagedContentRuntime } from "../apps/web/lib/managed-content-runtime";
import { KeyProviderRegistry } from "../apps/web/lib/key-management/registry";
import type { KeyManagementProvider, WrappedUserKey } from "../apps/web/lib/key-management/types";
import { getProviderRewrapUsers, rewrapUserKey, type RewrapDb } from "../apps/web/lib/provider-rewrap";
import { createPoolLeaseFactory, runCli } from "./toard-admin";

const execFileAsync = promisify(execFile);
const INSTALLATION_ID = "019f7250-dc4d-78fd-98e8-a5465d0f5b69";
const UCK = Buffer.alloc(32, 0x56);
const OLD_FINGERPRINT = "local:111111111111111111111111";
const TARGET_FINGERPRINT = "aws-kms:222222222222222222222222";

async function waitForPostgres(connectionString: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const client = new Client({ connectionString, connectionTimeoutMillis: 1_000 });
    try {
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      return;
    } catch (error) {
      lastError = error;
      await client.end().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw lastError;
}

async function migrations(): Promise<string[]> {
  const names = (await readdir("migrations")).filter((name) => /^17000000\d+.*\.sql$/.test(name)).sort();
  return Promise.all(names.map(async (name) => (await readFile(`migrations/${name}`, "utf8")).split("-- Down Migration", 1)[0]!));
}

function providers(): { old: KeyManagementProvider; target: KeyManagementProvider } {
  const old: KeyManagementProvider = {
    name: "local", keyRef: "local:old", fingerprint: OLD_FINGERPRINT,
    async wrapKey(): Promise<WrappedUserKey> {
      return { provider: this.name, keyRef: this.keyRef, fingerprint: this.fingerprint,
        ciphertext: Buffer.alloc(64, 0x64), metadata: { version: "2" } };
    },
    async unwrapKey() { return Buffer.from(UCK); },
    async healthCheck() { return { status: "healthy", latencyMs: 1, checkedAt: new Date() }; },
    async describeCredentialSource() { return { kind: "test", staticCredential: false }; },
  };
  const target: KeyManagementProvider = {
    name: "aws-kms", keyRef: "arn:aws:kms:ap-northeast-2:123456789012:key/11111111-1111-4111-8111-111111111111",
    fingerprint: TARGET_FINGERPRINT,
    async wrapKey(): Promise<WrappedUserKey> {
      return { provider: this.name, keyRef: this.keyRef, fingerprint: this.fingerprint,
        ciphertext: Buffer.alloc(64, 0x65), metadata: { algorithm: "SYMMETRIC_DEFAULT" } };
    },
    async unwrapKey() { return Buffer.from(UCK); },
    async healthCheck() { return { status: "healthy", latencyMs: 1, checkedAt: new Date() }; },
    async describeCredentialSource() { return { kind: "test", staticCredential: false }; },
  };
  return { old, target };
}

test("provider rewrap uses user RLS, preserves managed ciphertext, and atomically retires the old wrapper", { timeout: 120_000 }, async () => {
  const container = `toard-provider-rewrap-${randomUUID().slice(0, 8)}`;
  let admin: Client | null = null;
  let app: Client | null = null;
  let operationalPool: Pool | null = null;
  try {
    await execFileAsync("docker", ["run", "-d", "--rm", "--name", container,
      "-e", "POSTGRES_PASSWORD=postgres", "-e", "POSTGRES_DB=toard",
      "-p", "127.0.0.1::5432", "postgres:16-alpine"]);
    const { stdout } = await execFileAsync("docker", ["port", container, "5432/tcp"]);
    const port = stdout.trim().match(/:(\d+)$/)?.[1];
    assert.ok(port);
    const connectionString = `postgresql://postgres:postgres@127.0.0.1:${port}/toard`;
    await waitForPostgres(connectionString);
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query("CREATE ROLE toard_app LOGIN PASSWORD 'integration-app-password' NOSUPERUSER NOBYPASSRLS");
    for (const sql of await migrations()) await admin.query(sql);
    await admin.query("GRANT USAGE ON SCHEMA public TO toard_app; GRANT SELECT ON users,prompt_records TO toard_app; GRANT SELECT,INSERT,UPDATE ON managed_content_keys TO toard_app");

    const userId = randomUUID();
    const actorId = randomUUID();
    await admin.query(
      "INSERT INTO users(id,email,role) VALUES($1,'provider-rewrap@example.com','member'),($2,'provider-rewrap-actor@example.com','admin')",
      [userId, actorId],
    );
    await admin.query("INSERT INTO providers(key,display_name,service_name_patterns,collection_method) VALUES('codex','Codex',ARRAY['codex'],'logfile')");
    await admin.query(
      `INSERT INTO managed_content_keys
        (user_id,key_version,provider,provider_key_ref,provider_fingerprint,wrapped_user_key,wrapper_metadata,state)
       VALUES($1,3,'local','local:old',$3,$2,'{"version":"1"}','active')`,
      [userId, Buffer.alloc(48, 0x33), OLD_FINGERPRINT],
    );
    const record = { dedupKey: "rewrap-canary", sessionId: "rewrap-session", providerKey: "codex",
      turnRole: "user" as const, ts: new Date("2026-07-17T01:02:03.000Z"), text: "managed canary" };
    const encrypted = encryptManagedContent(record, UCK, INSTALLATION_ID, userId, 3);
    await admin.query(
      `INSERT INTO prompt_records
        (dedup_key,user_id,session_id,provider_key,turn_role,ts,key_version,wrapped_dek,iv,ciphertext,auth_tag,
         encryption_scheme,content_owner_id,content_key_version,dek_wrap_iv,dek_wrap_auth_tag,aad_version)
       VALUES($1,$2,$3,$4,$5,$6,3,$7,$8,$9,$10,'managed_v1',NULL,3,$11,$12,2)`,
      [record.dedupKey, userId, record.sessionId, record.providerKey, record.turnRole, record.ts,
        encrypted.wrappedDek, encrypted.iv, encrypted.ciphertext, encrypted.authTag,
        encrypted.dekWrapIv, encrypted.dekWrapAuthTag],
    );
    const before = (await admin.query(
      "SELECT encode(wrapped_dek,'hex') AS wrapped,encode(ciphertext,'hex') AS body FROM prompt_records WHERE user_id=$1",
      [userId],
    )).rows[0];

    app = new Client({ connectionString });
    await app.connect();
    await app.query("SET ROLE toard_app");
    let databaseFailure: unknown;
    const db: RewrapDb = { query: async (sql, params = []) => {
      try {
        const result = await app!.query(sql, params);
        return { rows: result.rows, rowCount: result.rowCount };
      } catch (error) {
        databaseFailure = error;
        throw error;
      }
    } };
    assert.deepEqual(
      await getProviderRewrapUsers("local", OLD_FINGERPRINT, db),
      [userId],
    );
    const { old, target } = providers();
    const evicted: string[] = [];
    const runtime: ManagedContentRuntime = {
      installationId: INSTALLATION_ID, registry: new KeyProviderRegistry(old, target), health: null as never,
      userKeys: {
        async withActiveUserKey() { throw new Error("not used"); },
        async withUserKeyVersion() { throw new Error("not used"); },
        evict(id, version, fingerprint) { evicted.push(`${id}:${version}:${fingerprint}`); },
      },
    };
    const result = await rewrapUserKey(userId, runtime, db).catch((error) => {
      assert.fail(`rewrap failed; database cause=${databaseFailure instanceof Error ? databaseFailure.message : "none"}; service=${String(error)}`);
    });
    assert.deepEqual(result, { state: "migrated" });
    await app.query("RESET ROLE");

    const after = (await admin.query(
      "SELECT encode(wrapped_dek,'hex') AS wrapped,encode(ciphertext,'hex') AS body FROM prompt_records WHERE user_id=$1",
      [userId],
    )).rows[0];
    assert.deepEqual(after, before);
    assert.deepEqual((await admin.query(
      "SELECT provider,provider_fingerprint,state FROM managed_content_keys WHERE user_id=$1 ORDER BY state",
      [userId],
    )).rows, [
      { provider: "aws-kms", provider_fingerprint: TARGET_FINGERPRINT, state: "active" },
      { provider: "local", provider_fingerprint: OLD_FINGERPRINT, state: "retiring" },
    ]);
    assert.deepEqual(evicted, [`${userId}:3:${OLD_FINGERPRINT}`]);
    assert.deepEqual((await admin.query(
      `SELECT event_type,user_id,provider,provider_fingerprint,key_version,actor_user_id,app_instance_id
         FROM content_key_security_events WHERE user_id=$1 ORDER BY id`, [userId],
    )).rows, [{
      event_type: "user_key_rewrapped",
      user_id: userId,
      provider: "aws-kms",
      provider_fingerprint: TARGET_FINGERPRINT,
      key_version: 3,
      actor_user_id: null,
      app_instance_id: INSTALLATION_ID,
    }]);

    await app.query("SET ROLE toard_app");
    runtime.registry = new KeyProviderRegistry(target, old);
    assert.deepEqual(await rewrapUserKey(userId, runtime, db), { state: "migrated" });
    await app.query("RESET ROLE");
    assert.deepEqual((await admin.query(
      "SELECT provider,provider_fingerprint,state FROM managed_content_keys WHERE user_id=$1 ORDER BY state",
      [userId],
    )).rows, [
      { provider: "local", provider_fingerprint: OLD_FINGERPRINT, state: "active" },
      { provider: "aws-kms", provider_fingerprint: TARGET_FINGERPRINT, state: "retiring" },
    ]);
    assert.deepEqual((await admin.query(
      "SELECT encode(wrapped_dek,'hex') AS wrapped,encode(ciphertext,'hex') AS body FROM prompt_records WHERE user_id=$1",
      [userId],
    )).rows[0], before);

    const auditFailingUser = randomUUID();
    await admin.query(
      "INSERT INTO users(id,email) VALUES($1,'provider-rewrap-audit-fail@example.com')",
      [auditFailingUser],
    );
    await admin.query(
      `INSERT INTO managed_content_keys
        (user_id,key_version,provider,provider_key_ref,provider_fingerprint,wrapped_user_key,wrapper_metadata,state)
       VALUES($1,3,'local','local:old',$3,$2,'{"version":"1"}','active')`,
      [auditFailingUser, Buffer.alloc(48, 0x33), OLD_FINGERPRINT],
    );
    const auditFailingRecord = {
      ...record,
      dedupKey: "rewrap-audit-failing-canary",
      sessionId: "audit-failing-session",
    };
    const auditFailingEncrypted = encryptManagedContent(
      auditFailingRecord,
      UCK,
      INSTALLATION_ID,
      auditFailingUser,
      3,
    );
    await admin.query(
      `INSERT INTO prompt_records
        (dedup_key,user_id,session_id,provider_key,turn_role,ts,key_version,wrapped_dek,iv,ciphertext,auth_tag,
         encryption_scheme,content_owner_id,content_key_version,dek_wrap_iv,dek_wrap_auth_tag,aad_version)
       VALUES($1,$2,$3,$4,$5,$6,3,$7,$8,$9,$10,'managed_v1',NULL,3,$11,$12,2)`,
      [
        auditFailingRecord.dedupKey, auditFailingUser, auditFailingRecord.sessionId,
        auditFailingRecord.providerKey, auditFailingRecord.turnRole, auditFailingRecord.ts,
        auditFailingEncrypted.wrappedDek, auditFailingEncrypted.iv,
        auditFailingEncrypted.ciphertext, auditFailingEncrypted.authTag,
        auditFailingEncrypted.dekWrapIv, auditFailingEncrypted.dekWrapAuthTag,
      ],
    );
    await admin.query(`
      CREATE FUNCTION fail_selected_key_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.user_id='${auditFailingUser}'::uuid AND NEW.event_type='user_key_rewrapped' THEN
          RAISE EXCEPTION 'forced audit failure';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER fail_selected_key_audit_trigger BEFORE INSERT ON content_key_security_events
      FOR EACH ROW EXECUTE FUNCTION fail_selected_key_audit();
    `);
    runtime.registry = new KeyProviderRegistry(old, target);
    const evictionsBeforeAuditFailure = evicted.length;
    await app.query("SET ROLE toard_app");
    await assert.rejects(
      rewrapUserKey(auditFailingUser, runtime, db),
      (error: unknown) => (error as Error).message === "REWRAP_FAILED",
    );
    await app.query("RESET ROLE");
    assert.deepEqual((await admin.query(
      "SELECT provider,state FROM managed_content_keys WHERE user_id=$1 ORDER BY state",
      [auditFailingUser],
    )).rows, [{ provider: "local", state: "active" }]);
    assert.equal((await admin.query(
      "SELECT COUNT(*)::int AS count FROM content_key_security_events WHERE user_id=$1",
      [auditFailingUser],
    )).rows[0].count, 0);
    assert.equal(evicted.length, evictionsBeforeAuditFailure);
    await admin.query(`
      DROP TRIGGER fail_selected_key_audit_trigger ON content_key_security_events;
      DROP FUNCTION fail_selected_key_audit();
    `);
    await admin.query("DELETE FROM prompt_records WHERE user_id=$1", [auditFailingUser]);
    await admin.query("DELETE FROM managed_content_keys WHERE user_id=$1", [auditFailingUser]);
    await admin.query("DELETE FROM users WHERE id=$1", [auditFailingUser]);

    const failingUser = randomUUID();
    const noWrapperUser = randomUUID();
    await admin.query(
      `INSERT INTO users(id,email) VALUES
         ($1,'provider-rewrap-fail@example.com'),
         ($2,'provider-rewrap-none@example.com')`,
      [failingUser, noWrapperUser],
    );
    await admin.query(
      `INSERT INTO managed_content_keys
        (user_id,key_version,provider,provider_key_ref,provider_fingerprint,wrapped_user_key,wrapper_metadata,state)
       VALUES($1,3,'local','local:old',$3,$2,'{"version":"1"}','active')`,
      [failingUser, Buffer.alloc(48, 0x33), OLD_FINGERPRINT],
    );
    const failingRecord = { ...record, dedupKey: "rewrap-failing-canary", sessionId: "failing-session" };
    const failingEncrypted = encryptManagedContent(failingRecord, UCK, INSTALLATION_ID, failingUser, 3);
    await admin.query(
      `INSERT INTO prompt_records
        (dedup_key,user_id,session_id,provider_key,turn_role,ts,key_version,wrapped_dek,iv,ciphertext,auth_tag,
         encryption_scheme,content_owner_id,content_key_version,dek_wrap_iv,dek_wrap_auth_tag,aad_version)
       VALUES($1,$2,$3,$4,$5,$6,3,$7,$8,$9,$10,'managed_v1',NULL,3,$11,$12,2)`,
      [failingRecord.dedupKey, failingUser, failingRecord.sessionId, failingRecord.providerKey,
        failingRecord.turnRole, failingRecord.ts, failingEncrypted.wrappedDek, failingEncrypted.iv,
        failingEncrypted.ciphertext, failingEncrypted.authTag,
        failingEncrypted.dekWrapIv, failingEncrypted.dekWrapAuthTag],
    );
    await admin.query(`
      CREATE TABLE rewrap_pid_audit(user_id uuid NOT NULL, backend_pid int NOT NULL, next_state text NOT NULL);
      CREATE FUNCTION audit_rewrap_pid() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
      BEGIN
        INSERT INTO rewrap_pid_audit(user_id,backend_pid,next_state) VALUES(NEW.user_id,pg_backend_pid(),NEW.state);
        RETURN NEW;
      END $$;
      CREATE TRIGGER audit_rewrap_pid_trigger AFTER INSERT OR UPDATE ON managed_content_keys
      FOR EACH ROW EXECUTE FUNCTION audit_rewrap_pid();
      CREATE FUNCTION fail_selected_rewrap() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
      BEGIN
        IF NEW.user_id='${failingUser}'::uuid AND OLD.state='pending' AND NEW.state='active' THEN
          RAISE EXCEPTION 'forced promotion failure';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER fail_selected_rewrap_trigger BEFORE UPDATE ON managed_content_keys
      FOR EACH ROW EXECUTE FUNCTION fail_selected_rewrap();
    `);

    operationalPool = new Pool({
      connectionString: `postgresql://toard_app:integration-app-password@127.0.0.1:${port}/toard`,
      max: 2,
    });
    runtime.registry = new KeyProviderRegistry(old, target);
    const operational = await runCli(
      ["encryption", "rewrap-provider", "--from", "local", "--to", "aws-kms", "--actor-user-id", actorId],
      {
        runtime: async () => runtime,
        acquireDb: createPoolLeaseFactory(operationalPool),
        loadLegacyKek: () => Buffer.alloc(32),
        migrateServerBatch: async () => { throw new Error("not used"); },
        rewrapUser: rewrapUserKey,
        close: async () => operationalPool?.end(),
      },
    );
    assert.equal(operational.exitCode, 1);
    assert.match(operational.stdout, /migrated=1 failed=1/);
    assert.match(operational.stderr, /REWRAP_FAILED/);
    assert.doesNotMatch(operational.stderr, new RegExp(`${actorId}|${failingUser}`));

    const successPids = await admin.query(
      "SELECT COUNT(DISTINCT backend_pid)::int AS count,COUNT(*)::int AS events FROM rewrap_pid_audit WHERE user_id=$1",
      [userId],
    );
    assert.equal(successPids.rows[0].count, 1);
    assert.ok(successPids.rows[0].events >= 3);
    assert.equal((await admin.query("SELECT COUNT(*)::int AS count FROM rewrap_pid_audit WHERE user_id=$1", [failingUser])).rows[0].count, 0);
    assert.deepEqual((await admin.query(
      "SELECT provider,state FROM managed_content_keys WHERE user_id=$1 ORDER BY state",
      [failingUser],
    )).rows, [{ provider: "local", state: "active" }]);

    assert.deepEqual((await admin.query(
      `SELECT event_type,actor_user_id::text,provider,provider_fingerprint,app_instance_id
         FROM content_key_security_events
        WHERE event_type LIKE 'provider_migration_%'
        ORDER BY id`,
    )).rows, [{
      event_type: "provider_migration_started",
      actor_user_id: actorId,
      provider: "aws-kms",
      provider_fingerprint: TARGET_FINGERPRINT,
      app_instance_id: INSTALLATION_ID,
    }]);

    await admin.query(`
      DROP TRIGGER fail_selected_rewrap_trigger ON managed_content_keys;
      DROP FUNCTION fail_selected_rewrap();
    `);
    const completed = await runCli(
      ["encryption", "rewrap-provider", "--from", "local", "--to", "aws-kms", "--actor-user-id", actorId],
      {
        runtime: async () => runtime,
        acquireDb: createPoolLeaseFactory(operationalPool),
        loadLegacyKek: () => Buffer.alloc(32),
        migrateServerBatch: async () => { throw new Error("not used"); },
        rewrapUser: rewrapUserKey,
        close: async () => operationalPool?.end(),
      },
    );
    assert.deepEqual(completed, { exitCode: 0, stdout: "migrated=1 failed=0\n", stderr: "" });
    assert.deepEqual((await admin.query(
      `SELECT event_type,actor_user_id::text,provider,provider_fingerprint,app_instance_id
         FROM content_key_security_events
        WHERE event_type LIKE 'provider_migration_%'
        ORDER BY id`,
    )).rows, [
      {
        event_type: "provider_migration_started",
        actor_user_id: actorId,
        provider: "aws-kms",
        provider_fingerprint: TARGET_FINGERPRINT,
        app_instance_id: INSTALLATION_ID,
      },
      {
        event_type: "provider_migration_started",
        actor_user_id: actorId,
        provider: "aws-kms",
        provider_fingerprint: TARGET_FINGERPRINT,
        app_instance_id: INSTALLATION_ID,
      },
      {
        event_type: "provider_migration_completed",
        actor_user_id: actorId,
        provider: "aws-kms",
        provider_fingerprint: TARGET_FINGERPRINT,
        app_instance_id: INSTALLATION_ID,
      },
    ]);

    const lease = await createPoolLeaseFactory(operationalPool)();
    try {
      await assert.rejects(
        lease.db.query("SELECT user_id FROM managed_content_keys"),
        (error: unknown) => (error as { code?: string }).code === "22P02",
      );
      await lease.db.query("BEGIN");
      await lease.db.query("SELECT set_config('app.current_user_id',$1,true)", [userId]);
      const visible = await lease.db.query("SELECT DISTINCT user_id::text AS user_id FROM managed_content_keys");
      assert.deepEqual(visible.rows, [{ user_id: userId }]);
      await lease.db.query("COMMIT");
    } finally {
      await lease.release();
    }
    assert.equal(operationalPool.waitingCount, 0);
    assert.equal(operationalPool.idleCount, operationalPool.totalCount);
  } finally {
    await operationalPool?.end().catch(() => undefined);
    await app?.end().catch(() => undefined);
    await admin?.end().catch(() => undefined);
    await execFileAsync("docker", ["rm", "-f", container]).catch(() => undefined);
  }
});
