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
import { LocalKeyManagementProvider } from "../apps/web/lib/key-management/local-provider";
import { ProviderHealthCache } from "../apps/web/lib/key-management/provider-health-cache";
import { KeyProviderRegistry } from "../apps/web/lib/key-management/registry";
import type { KeyContext, WrappedUserKey } from "../apps/web/lib/key-management/types";
import { UserKeyCache } from "../apps/web/lib/key-management/user-key-cache";
import type { ManagedContentRuntime } from "../apps/web/lib/managed-content-runtime";
import { ManagedUserKeyService } from "../apps/web/lib/managed-user-keys";
import { getMyHistorySession } from "../apps/web/lib/prompt-history";
import { saveManagedPromptRecords } from "../apps/web/lib/prompt-records";
import { runCli, type AdminCliDependencies } from "./toard-admin";

const execFileAsync = promisify(execFile);
const PLAINTEXT = "TOARD_MANAGED_PLAINTEXT_CANARY_29e4";
const CLOUD_CREDENTIAL_MARKER = "AWS_SECRET_ACCESS_KEY=TOARD_MUST_NOT_PERSIST_29e4";

test("managed content는 운영 저장/열람에서도 DB dump, 타 사용자, 관리자, 무권한 process에 평문을 노출하지 않는다", { timeout: 180_000 }, async () => {
  const container = `toard-managed-security-${randomUUID().slice(0, 8)}`;
  const secretDirectory = await mkdtemp(join(tmpdir(), "toard-managed-security-"));
  const childDirectory = await mkdtemp(join(tmpdir(), "toard-managed-child-"));
  const keyFile = join(secretDirectory, "local-kek");
  const childBundle = join(childDirectory, "decrypt-child.mjs");
  let admin: Client | null = null;
  let appKeys: Client | null = null;
  let appPrompt: Client | null = null;
  const uck = randomBytes(32);
  const kek = randomBytes(32);
  try {
    await chmod(secretDirectory, 0o700);
    await chmod(childDirectory, 0o755);
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
      GRANT INSERT, UPDATE ON prompt_records, managed_content_keys, content_key_security_events TO toard_app;
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO toard_app;
    `);

    const userA = randomUUID();
    const userB = randomUUID();
    const adminUser = randomUUID();
    const legacyUser = randomUUID();
    const accountOnlyUser = randomUUID();
    await admin.query(
      `INSERT INTO users(id,email,role) VALUES
       ($1,'managed-security-a@example.test','member'),
       ($2,'managed-security-b@example.test','member'),
       ($3,'managed-security-admin@example.test','admin'),
       ($4,'managed-security-legacy@example.test','member'),
       ($5,'managed-security-account-only@example.test','member')`,
      [userA, userB, adminUser, legacyUser, accountOnlyUser],
    );
    await admin.query(
      "INSERT INTO providers(key,display_name,service_name_patterns,collection_method) VALUES('codex','Codex',ARRAY['codex'],'logfile')",
    );
    const installationId = String((await admin.query("SELECT installation_id FROM installation_identity WHERE singleton=TRUE")).rows[0]!.installation_id);
    const appUrl = `postgresql://toard_app:integration-app-password@127.0.0.1:${port}/toard`;
    appKeys = new Client({ connectionString: appUrl });
    appPrompt = new Client({ connectionString: appUrl });
    await appKeys.connect();
    await appPrompt.connect();

    const provider = new LocalKeyManagementProvider({ keyFile });
    const registry = new KeyProviderRegistry(provider, null);
    const userKeys = new ManagedUserKeyService({
      installationId,
      registry,
      cache: new UserKeyCache({ ttlMs: 300_000 }),
      randomBytes: () => Buffer.from(uck),
      runInUserContext: (userId, fn) => inUserContext(appKeys!, userId, fn),
    });
    const runtime: ManagedContentRuntime = {
      installationId,
      registry,
      userKeys,
      health: new ProviderHealthCache(),
    };
    const ts = new Date("2026-07-17T05:00:00.000Z");
    const saved = await inUserContext(appPrompt, userA, (db) => saveManagedPromptRecords(userA, [{
      dedupKey: "managed-security-canary",
      sessionId: "managed-security-session",
      providerKey: "codex",
      turnRole: "user",
      ts,
      text: PLAINTEXT,
    }], runtime, db));
    assert.deepEqual(saved, { inserted: 1, deduped: 0 });

    const legacyAccount = await admin.query<{ content_owner_id: string }>(
      `INSERT INTO content_accounts(user_id,state,recovery_confirmed_at)
       VALUES($1,'active',now()) RETURNING content_owner_id`,
      [legacyUser],
    );
    await admin.query(
      `INSERT INTO content_accounts(user_id,state,recovery_confirmed_at) VALUES($1,'active',now())`,
      [accountOnlyUser],
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
    const legacyBefore = await legacyCipherSnapshot(admin, legacyUser);
    assert.equal(await inUserContext(appPrompt, legacyUser, (db) => legacyE2eeCapability(legacyUser, db)), "migration");
    assert.equal(await inUserContext(appPrompt, accountOnlyUser, (db) => legacyE2eeCapability(accountOnlyUser, db)), "disabled");
    assert.equal(await inUserContext(appPrompt, userA, (db) => legacyE2eeCapability(legacyUser, db)), "disabled");
    await admin.query(
      `UPDATE content_e2ee_migrations SET state='blocked',blocked_at=now(),blocked_reason='key_unavailable',updated_at=now()
       WHERE user_id=$1`,
      [legacyUser],
    );
    assert.equal(await inUserContext(appPrompt, legacyUser, (db) => legacyE2eeCapability(legacyUser, db)), "recovery");
    assert.equal(await legacyCipherSnapshot(admin, legacyUser), legacyBefore, "capability gate는 기존 암호문을 변경하면 안 된다");

    const ownHistory = await inUserContext(appPrompt, userA, (db) => getMyHistorySession(
      userA, "managed-security-session", { db, runtime, legacyKek: null },
    ));
    assert.equal(ownHistory.session?.turns[0]?.text, PLAINTEXT);
    for (const actor of [userB, adminUser]) {
      const history = await inUserContext(appPrompt, actor, (db) => getMyHistorySession(
        userA, "managed-security-session", { db, runtime, legacyKek: null },
      ));
      assert.equal(history.session, null, `${actor === adminUser ? "admin" : "other user"} RLS context must not read owner history`);
      const keyCount = await inUserContext(appPrompt, actor, async (db) => (
        await db.query("SELECT COUNT(*)::int AS count FROM managed_content_keys WHERE user_id=$1", [userA])
      ).rows[0]!.count);
      assert.equal(keyCount, 0);
    }

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
    assertNoCanaryVariants(dump, [PLAINTEXT, uck, kek, CLOUD_CREDENTIAL_MARKER]);
    assert.match(dump, /managed-security-canary/);
    assert.match(dump, /managed_content_keys/);

    const injectedProviderError = [PLAINTEXT, CLOUD_CREDENTIAL_MARKER, uck.toString("base64"), kek.toString("hex")].join("|");
    assert.ok(injectedProviderError.includes(CLOUD_CREDENTIAL_MARKER), "credential marker must be used in the exercised error");
    const adminFailure = await runCli(["encryption", "status"], failingCliDependencies({ acquireDb: async () => { throw new Error(injectedProviderError); } }));
    const providerFailure = await runCli(["encryption", "migrate-server", "--batch-size", "1"], failingCliDependencies({ runtime: async () => { throw new Error(injectedProviderError); } }));
    assert.deepEqual([adminFailure.stderr, providerFailure.stderr], ["ADMIN_COMMAND_FAILED\n", "ADMIN_COMMAND_FAILED\n"]);
    assertNoCanaryVariants(`${adminFailure.stdout}${adminFailure.stderr}${providerFailure.stdout}${providerFailure.stderr}`, [PLAINTEXT, uck, kek, CLOUD_CREDENTIAL_MARKER]);

    const wrapperRow = (await admin.query<Record<string, unknown>>(
      `SELECT provider,provider_key_ref,provider_fingerprint,wrapped_user_key,wrapper_metadata,key_version
       FROM managed_content_keys WHERE user_id=$1 AND state='active'`, [userA],
    )).rows[0]!;
    const encryptedRow = (await admin.query<Record<string, unknown>>(
      `SELECT dedup_key,provider_key,turn_role,ts,content_key_version,wrapped_dek,dek_wrap_iv,
              dek_wrap_auth_tag,iv,ciphertext,auth_tag
       FROM prompt_records WHERE user_id=$1 AND encryption_scheme='managed_v1'`, [userA],
    )).rows[0]!;
    const context: KeyContext = { installationId, userId: userA, keyVersion: Number(wrapperRow.key_version), purpose: "prompt-history" };
    const wrapped: WrappedUserKey = {
      provider: wrapperRow.provider as "local",
      keyRef: String(wrapperRow.provider_key_ref),
      fingerprint: String(wrapperRow.provider_fingerprint),
      ciphertext: wrapperRow.wrapped_user_key as Buffer,
      metadata: wrapperRow.wrapper_metadata as Record<string, string>,
    };
    const childEnv = {
      CONTEXT: JSON.stringify(context),
      WRAPPED: JSON.stringify({ ...wrapped, ciphertext: wrapped.ciphertext.toString("base64") }),
      ROW: JSON.stringify({
        dedupKey: encryptedRow.dedup_key, providerKey: encryptedRow.provider_key, turnRole: encryptedRow.turn_role,
        ts: (encryptedRow.ts as Date).toISOString(), contentKeyVersion: encryptedRow.content_key_version,
        wrappedDek: (encryptedRow.wrapped_dek as Buffer).toString("base64"),
        dekWrapIv: (encryptedRow.dek_wrap_iv as Buffer).toString("base64"),
        dekWrapAuthTag: (encryptedRow.dek_wrap_auth_tag as Buffer).toString("base64"),
        iv: (encryptedRow.iv as Buffer).toString("base64"), ciphertext: (encryptedRow.ciphertext as Buffer).toString("base64"),
        authTag: (encryptedRow.auth_tag as Buffer).toString("base64"),
      }),
      KEY_FILE: keyFile,
      EXPECTED: PLAINTEXT,
    };
    await execFileAsync("node_modules/.bin/esbuild", [
      "scripts/managed-content-decrypt-child.ts", "--bundle", "--platform=node", "--format=esm", `--outfile=${childBundle}`,
    ]);
    await chmod(childBundle, 0o644);
    const dockerArgs = [
      "run", "--rm", "-v", `${secretDirectory}:${secretDirectory}:ro`, "-v", `${childDirectory}:${childDirectory}:ro`,
      ...Object.entries(childEnv).flatMap(([name, value]) => ["-e", `${name}=${value}`]),
      "node:24-bookworm-slim", "node", childBundle,
    ];
    const authorized = await execFileAsync("docker", dockerArgs);
    assert.equal(authorized.stdout.trim(), "DECRYPT_OK");
    assertNoCanaryVariants(authorized.stderr, [PLAINTEXT, uck, kek, CLOUD_CREDENTIAL_MARKER]);
    const unprivilegedArgs = [
      "run", "--rm", "--user", "65534:65534", "-v", `${childDirectory}:${childDirectory}:ro`,
      ...Object.entries(childEnv).flatMap(([name, value]) => ["-e", `${name}=${value}`]),
      "node:24-bookworm-slim", "node", childBundle,
    ];
    await assert.rejects(
      // KEK mount 자체를 부여하지 않은 uid 65534 process가 같은 production 경로를 실행한다.
      execFileAsync("docker", unprivilegedArgs),
      (error: unknown) => {
        const result = error as { stdout?: string; stderr?: string };
        assert.equal(result.stdout ?? "", "");
        assert.equal(result.stderr?.trim(), "LOCAL_KEK_FILE_UNAVAILABLE");
        assertNoCanaryVariants(`${result.stdout ?? ""}${result.stderr ?? ""}`, [PLAINTEXT, uck, kek, CLOUD_CREDENTIAL_MARKER]);
        return true;
      },
    );
  } finally {
    uck.fill(0);
    kek.fill(0);
    await appPrompt?.end().catch(() => undefined);
    await appKeys?.end().catch(() => undefined);
    await admin?.end().catch(() => undefined);
    await execFileAsync("docker", ["rm", "-f", container]).catch(() => undefined);
    await rm(secretDirectory, { recursive: true, force: true });
    await rm(childDirectory, { recursive: true, force: true });
  }
});

function failingCliDependencies(overrides: Partial<AdminCliDependencies>): AdminCliDependencies {
  return {
    runtime: async () => null,
    acquireDb: async () => { throw new Error("unused"); },
    loadLegacyKek: () => Buffer.alloc(32),
    migrateServerBatch: async () => ({ migrated: 0, remaining: 0 }),
    rewrapUser: async () => ({ state: "already-current" }),
    close: async () => undefined,
    ...overrides,
  };
}

function canaryVariants(value: string | Buffer): string[] {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
  return [...new Set([typeof value === "string" ? value : "", bytes.toString("utf8"), bytes.toString("hex"), bytes.toString("base64"), bytes.toString("base64url")].filter(Boolean))];
}

function assertNoCanaryVariants(haystack: string, canaries: Array<string | Buffer>): void {
  for (const canary of canaries) {
    const variants = canaryVariants(canary);
    assert.ok(variants.length >= 4, "canary variants must be exercised");
    for (const variant of variants) assert.equal(haystack.includes(variant), false, `leaked canary variant: ${variant.slice(0, 16)}`);
  }
}

async function legacyCipherSnapshot(client: Client, userId: string): Promise<string> {
  const result = await client.query(
    `SELECT dedup_key,encode(wrapped_dek,'hex') AS wrapped_dek,encode(iv,'hex') AS iv,
            encode(ciphertext,'hex') AS ciphertext,encode(auth_tag,'hex') AS auth_tag,
            encode(dek_wrap_iv,'hex') AS dek_wrap_iv,encode(dek_wrap_auth_tag,'hex') AS dek_wrap_auth_tag
     FROM prompt_records WHERE user_id=$1 AND encryption_scheme='e2ee_v1' ORDER BY id`,
    [userId],
  );
  return JSON.stringify(result.rows);
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
