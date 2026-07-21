import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import { Client } from "pg";
import type { DeviceEnvelopeWire, E2eePromptRecordWire } from "../apps/web/lib/e2ee-contract";
import {
  decryptE2eeRecord,
  encryptE2eeRecord,
  exportBrowserPublicKey,
  generateBrowserDeviceKey,
  openDeviceEnvelope,
  sealUckForDevice,
} from "../apps/web/lib/e2ee-browser-crypto";
import { saveE2eePromptRecords } from "../apps/web/lib/prompt-records";

const execFileAsync = promisify(execFile);
const CANARY = "TOARD_E2EE_PLAINTEXT_CANARY_7f39";
const CREDENTIAL_CANARY = "AWS_SECRET_ACCESS_KEY=TOARD_MUST_NOT_PERSIST_7f39";
const MIGRATIONS = [
  "1700000001_init.sql",
  "1700000010_prompt_records.sql",
  "1700000030_e2ee_content_foundation.sql",
  "1700000047_prompt_agent_metadata.sql",
];

test("E2EE canary는 승인된 browser envelope 복호화 뒤에만 나타난다", { timeout: 90_000 }, async () => {
  const container = `toard-e2ee-canary-${randomUUID().slice(0, 8)}`;
  let admin: Client | null = null;
  let app: Client | null = null;
  let uck: Uint8Array | null = null;
  let acquiredUck: Uint8Array | null = null;
  try {
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
    for (const filename of MIGRATIONS) {
      const sql = await readFile(new URL(`../migrations/${filename}`, import.meta.url), "utf8");
      await admin.query(sql.split("-- Down Migration", 1)[0]);
    }
    await admin.query(`
      GRANT USAGE ON SCHEMA public TO toard_app;
      GRANT SELECT ON users, providers TO toard_app;
      GRANT SELECT, INSERT ON prompt_records, content_accounts, content_devices, content_key_wrappers TO toard_app;
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO toard_app;
    `);

    const userId = randomUUID();
    await admin.query("INSERT INTO users (id,email) VALUES ($1,'e2ee-canary@example.test')", [userId]);
    await admin.query(
      "INSERT INTO providers (key,display_name,service_name_patterns,collection_method) VALUES ('codex','Codex',ARRAY['codex'],'logfile')",
    );
    const account = await admin.query<{ content_owner_id: string }>(
      `INSERT INTO content_accounts (user_id,state,recovery_confirmed_at)
       VALUES ($1,'active',now()) RETURNING content_owner_id`,
      [userId],
    );
    const ownerId = account.rows[0]!.content_owner_id;

    const approvedBrowser = await generateBrowserDeviceKey();
    const wrongBrowser = await generateBrowserDeviceKey();
    const publicKey = await exportBrowserPublicKey(approvedBrowser.publicKey);
    uck = crypto.getRandomValues(new Uint8Array(32));
    const envelope = await sealUckForDevice(publicKey, uck);
    const device = await admin.query<{ id: string }>(
      `INSERT INTO content_devices
       (user_id,kind,label,platform,public_key,algorithm_version,approved_at)
       VALUES($1,'browser','Security browser','test',$2,'hpke-p256-v1',now()) RETURNING id`,
      [userId, Buffer.from(publicKey, "base64url")],
    );
    await admin.query(
      `INSERT INTO content_key_wrappers
       (user_id,content_key_version,wrapper_type,wrapper_ref,kdf_version,encapsulated_key,wrapped_content_key)
       VALUES($1,1,'device',$2,'hpke-p256-v1',$3,$4)`,
      [userId, device.rows[0]!.id, Buffer.from(envelope.encapsulatedKey, "base64url"), Buffer.from(envelope.ciphertext, "base64url")],
    );

    const record = await encryptE2eeRecord(uck, {
      dedupKey: "canary-dedup",
      sessionId: "canary-session",
      providerKey: "codex",
      turnRole: "user",
      ts: new Date("2026-07-14T00:00:00.000Z"),
      text: CANARY,
    }, ownerId, 1);
    assert.equal(JSON.stringify([record]).includes(CANARY), false);

    const appUrl = `postgresql://toard_app:integration-app-password@127.0.0.1:${port}/toard`;
    app = new Client({ connectionString: appUrl });
    await app.connect();
    const saved = await inUserContext(app, userId, (db) => saveE2eePromptRecords(userId, [record], db));
    assert.deepEqual(saved, { inserted: 1, deduped: 0 });

    const dbScan = await inUserContext(app, userId, (db) => db.query<{ serialized: string }>(
      `SELECT concat_ws('|', dedup_key, session_id, provider_key, turn_role, ts::text,
               encode(wrapped_dek,'hex'), encode(iv,'hex'), encode(ciphertext,'hex'),
               encode(auth_tag,'hex'), content_owner_id::text, encode(dek_wrap_iv,'hex'),
               encode(dek_wrap_auth_tag,'hex')) AS serialized
       FROM prompt_records WHERE user_id = $1`,
      [userId],
    ));
    assertNoCanaryVariants(dbScan.rows.map((row) => row.serialized).join("\n"), [CANARY, Buffer.from(uck), CREDENTIAL_CANARY]);

    const { stdout: dump } = await execFileAsync("docker", [
      "exec", container, "pg_dump", "-U", "postgres", "--data-only", "--column-inserts", "toard",
    ], { maxBuffer: 8 * 1024 * 1024 });
    assertNoCanaryVariants(dump, [CANARY, Buffer.from(uck), CREDENTIAL_CANARY]);
    assert.match(dump, /content_key_wrappers/);
    assert.match(dump, /canary-dedup/);

    const storedEnvelope = await inUserContext(app, userId, async (db): Promise<DeviceEnvelopeWire> => {
      const result = await db.query<{ algorithm_version: string; encapsulated_key: Buffer; wrapped_content_key: Buffer }>(
        `SELECT device.algorithm_version, wrapper.encapsulated_key, wrapper.wrapped_content_key
         FROM content_key_wrappers wrapper
         JOIN content_devices device ON device.id::text=wrapper.wrapper_ref
         WHERE wrapper.user_id=$1 AND wrapper.wrapper_type='device'
           AND device.approved_at IS NOT NULL AND device.revoked_at IS NULL AND wrapper.revoked_at IS NULL`,
        [userId],
      );
      assert.equal(result.rows[0]!.algorithm_version, "hpke-p256-v1");
      return {
        algorithm: "hpke-p256-hkdf-sha256-aes256gcm-v1",
        encapsulatedKey: result.rows[0]!.encapsulated_key.toString("base64url"),
        ciphertext: result.rows[0]!.wrapped_content_key.toString("base64url"),
      };
    });
    acquiredUck = await openDeviceEnvelope(approvedBrowser, storedEnvelope);

    const stored = await inUserContext(app, userId, (db) => db.query<Record<string, unknown>>(
      `SELECT dedup_key, session_id, provider_key, turn_role, ts, content_owner_id,
              content_key_version, wrapped_dek, dek_wrap_iv, dek_wrap_auth_tag, iv,
              ciphertext, auth_tag, aad_version
       FROM prompt_records WHERE user_id=$1 AND encryption_scheme='e2ee_v1'`,
      [userId],
    ));
    const browserRecord = rowToWire(stored.rows[0]!);
    assert.equal(new TextDecoder().decode(await decryptE2eeRecord(acquiredUck, browserRecord)), CANARY);
    await assert.rejects(openDeviceEnvelope(wrongBrowser, storedEnvelope), /CONTENT_UNAVAILABLE/);
    const unapprovedBrowser = await generateBrowserDeviceKey();
    await assert.rejects(openDeviceEnvelope(unapprovedBrowser, storedEnvelope), /CONTENT_UNAVAILABLE/);
  } finally {
    uck?.fill(0);
    acquiredUck?.fill(0);
    await app?.end().catch(() => undefined);
    await admin?.end().catch(() => undefined);
    await execFileAsync("docker", ["rm", "-f", container]).catch(() => undefined);
  }
});

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

function rowToWire(row: Record<string, unknown>): E2eePromptRecordWire {
  const b64field = (name: string) => (row[name] as Buffer).toString("base64url");
  return {
    schema: "e2ee_v1", algorithm: "AES-256-GCM", aadVersion: 1,
    contentOwnerId: String(row.content_owner_id), contentKeyVersion: Number(row.content_key_version),
    dedupKey: String(row.dedup_key), sessionId: String(row.session_id), providerKey: String(row.provider_key),
    turnRole: row.turn_role as "user", ts: (row.ts as Date).toISOString(),
    wrappedDek: b64field("wrapped_dek"), dekWrapIv: b64field("dek_wrap_iv"),
    dekWrapAuthTag: b64field("dek_wrap_auth_tag"), iv: b64field("iv"),
    ciphertext: b64field("ciphertext"), authTag: b64field("auth_tag"),
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
