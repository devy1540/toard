import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import { Client } from "pg";
import { canonicalContentAad, type E2eePromptRecordWire } from "../apps/web/lib/e2ee-contract";
import { decryptE2eeRecord } from "../apps/web/lib/e2ee-browser-crypto";

const execFileAsync = promisify(execFile);
const CANARY = "TOARD_E2EE_PLAINTEXT_CANARY_7f39";
const MIGRATIONS = ["1700000001_init.sql", "1700000010_prompt_records.sql", "1700000030_e2ee_content_foundation.sql"];

test("E2EE canary exists only after approved-browser decryption", { timeout: 90_000 }, async () => {
  const container = `toard-e2ee-canary-${randomUUID().slice(0, 8)}`;
  let client: Client | null = null;
  let uck: Uint8Array | null = null;
  try {
    await execFileAsync("docker", [
      "run", "-d", "--rm", "--name", container,
      "-e", "POSTGRES_PASSWORD=postgres", "-e", "POSTGRES_DB=toard",
      "-p", "127.0.0.1::5432", "postgres:16-alpine",
    ]);
    const { stdout } = await execFileAsync("docker", ["port", container, "5432/tcp"]);
    const port = stdout.trim().match(/:(\d+)$/)?.[1];
    assert.ok(port);
    const connectionString = `postgresql://postgres:postgres@127.0.0.1:${port}/toard`;
    await waitForPostgres(connectionString);
    client = new Client({ connectionString });
    await client.connect();
    for (const filename of MIGRATIONS) {
      const sql = await readFile(new URL(`../migrations/${filename}`, import.meta.url), "utf8");
      await client.query(sql.split("-- Down Migration", 1)[0]);
    }

    const userId = randomUUID();
    await client.query("INSERT INTO users (id,email) VALUES ($1,'e2ee-canary@example.test')", [userId]);
    await client.query(
      "INSERT INTO providers (key,display_name,service_name_patterns,collection_method) VALUES ('codex','Codex',ARRAY['codex'],'logfile')",
    );
    const account = await client.query<{ content_owner_id: string }>(
      `INSERT INTO content_accounts (user_id,state,recovery_confirmed_at)
       VALUES ($1,'active',now()) RETURNING content_owner_id`,
      [userId],
    );
    const ownerId = account.rows[0]!.content_owner_id;
    uck = crypto.getRandomValues(new Uint8Array(32));
    const record = await encryptCanary(uck, ownerId);
    const ingestRequestBody = JSON.stringify([record]);
    assert.equal(ingestRequestBody.includes(CANARY), false);

    await client.query(
      `INSERT INTO content_key_wrappers
       (user_id,content_key_version,wrapper_type,wrapper_ref,kdf_version,
        public_salt_or_input,nonce,auth_tag,wrapped_content_key)
       VALUES($1,1,'recovery','recovery-v1','hkdf-sha256-v1',$2,$3,$4,$5)`,
      [userId, Buffer.alloc(32, 0x21), Buffer.alloc(12, 0x22), Buffer.alloc(16, 0x23), Buffer.alloc(32, 0x24)],
    );

    await client.query(
      `INSERT INTO prompt_records
         (dedup_key,session_id,user_id,provider_key,turn_role,ts,key_version,wrapped_dek,iv,
          ciphertext,auth_tag,encryption_scheme,content_owner_id,content_key_version,
          dek_wrap_iv,dek_wrap_auth_tag,aad_version)
       VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8,$9,$10,'e2ee_v1',$11,$12,$13,$14,1)`,
      [
        record.dedupKey, record.sessionId, userId, record.providerKey, record.turnRole, record.ts,
        Buffer.from(record.wrappedDek, "base64url"), Buffer.from(record.iv, "base64url"),
        Buffer.from(record.ciphertext, "base64url"), Buffer.from(record.authTag, "base64url"),
        record.contentOwnerId, record.contentKeyVersion, Buffer.from(record.dekWrapIv, "base64url"),
        Buffer.from(record.dekWrapAuthTag, "base64url"),
      ],
    );

    const dbScan = await client.query<{ serialized: string }>(
      `SELECT concat_ws('|', dedup_key, session_id, provider_key, turn_role, ts::text,
               encode(wrapped_dek,'hex'), encode(iv,'hex'), encode(ciphertext,'hex'),
               encode(auth_tag,'hex'), content_owner_id::text, encode(dek_wrap_iv,'hex'),
               encode(dek_wrap_auth_tag,'hex')) AS serialized
       FROM prompt_records WHERE user_id = $1`,
      [userId],
    );
    assert.equal(dbScan.rows.some((row) => row.serialized.includes(CANARY)), false);

    const { stdout: dump } = await execFileAsync("docker", [
      "exec", container, "pg_dump", "-U", "postgres", "--data-only", "--column-inserts", "toard",
    ], { maxBuffer: 8 * 1024 * 1024 });
    assert.equal(dump.includes(CANARY), false);
    assert.equal(dump.includes(Buffer.from(uck).toString("base64")), false);
    assert.equal(dump.includes("AWS_SECRET_ACCESS_KEY=TOARD_MUST_NOT_PERSIST"), false);
    assert.match(dump, /content_key_wrappers/);
    assert.match(dump, /canary-dedup/);

    const stored = await client.query<Record<string, unknown>>(
      `SELECT dedup_key, session_id, provider_key, turn_role, ts, content_owner_id,
              content_key_version, wrapped_dek, dek_wrap_iv, dek_wrap_auth_tag, iv,
              ciphertext, auth_tag, aad_version
       FROM prompt_records WHERE user_id = $1 AND encryption_scheme = 'e2ee_v1'`,
      [userId],
    );
    const browserRecord = rowToWire(stored.rows[0]!);
    const browserDecryptedText = new TextDecoder().decode(await decryptE2eeRecord(uck, browserRecord));
    assert.equal(browserDecryptedText, CANARY);
  } finally {
    uck?.fill(0);
    await client?.end().catch(() => undefined);
    await execFileAsync("docker", ["rm", "-f", container]).catch(() => undefined);
  }
});

async function encryptCanary(uck: Uint8Array, ownerId: string): Promise<E2eePromptRecordWire> {
  const metadata = {
    schema: "e2ee_v1" as const,
    contentOwnerId: ownerId,
    dedupKey: "canary-dedup",
    providerKey: "codex",
    turnRole: "user" as const,
    ts: "2026-07-14T00:00:00.000Z",
  };
  const aad = canonicalContentAad(metadata);
  const dek = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const dekWrapIv = crypto.getRandomValues(new Uint8Array(12));
  const contentKey = await crypto.subtle.importKey("raw", dek, "AES-GCM", false, ["encrypt"]);
  const wrappingKey = await crypto.subtle.importKey("raw", uck, "AES-GCM", false, ["encrypt"]);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, contentKey, new TextEncoder().encode(CANARY)));
  const wrapped = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: dekWrapIv, additionalData: aad }, wrappingKey, dek));
  dek.fill(0);
  return {
    ...metadata, algorithm: "AES-256-GCM", aadVersion: 1, contentKeyVersion: 1,
    sessionId: "canary-session",
    wrappedDek: b64(wrapped.slice(0, -16)), dekWrapIv: b64(dekWrapIv), dekWrapAuthTag: b64(wrapped.slice(-16)),
    iv: b64(iv), ciphertext: b64(sealed.slice(0, -16)), authTag: b64(sealed.slice(-16)),
  };
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

function b64(bytes: Uint8Array): string { return Buffer.from(bytes).toString("base64url"); }

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
