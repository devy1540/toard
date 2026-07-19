import assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import test from "node:test";
import { encryptContent, type EncryptedContent } from "./legacy-content-crypto";
import type { ManagedContentRuntime } from "./managed-content-runtime";
import {
  assertServerSourceRoundTrip,
  getServerContentMigrationUsers,
  migrateServerContentBatch,
  ServerContentMigrationError,
  serverSourceDigest,
  type ServerMigrationDb,
} from "./server-content-migration";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const INSTALLATION_ID = "019f7250-dc4d-78fd-98e8-a5465d0f5b69";
const LEGACY_KEK = Buffer.alloc(32, 0x19);
const UCK = Buffer.alloc(32, 0x27);

type StoredRow = Record<string, unknown>;

function legacyRow(
  id: string,
  text: string,
  overrides: Record<string, unknown> = {},
): StoredRow {
  const encrypted = encryptContent(text, LEGACY_KEK);
  return {
    id,
    user_id: USER_A,
    dedup_key: `dedup-${id}`,
    session_id: `session-${id}`,
    provider_key: "codex",
    turn_role: "user",
    ts: new Date(`2026-07-17T03:04:${id.padStart(2, "0")}.000Z`),
    encryption_scheme: "server_v1",
    content_owner_id: null,
    content_key_version: null,
    dek_wrap_iv: null,
    dek_wrap_auth_tag: null,
    aad_version: null,
    key_version: encrypted.keyVersion,
    wrapped_dek: encrypted.wrappedDek,
    iv: encrypted.iv,
    ciphertext: encrypted.ciphertext,
    auth_tag: encrypted.authTag,
    ...overrides,
  };
}

function invalidUtf8LegacyRow(id: string): StoredRow {
  const dek = Buffer.alloc(32, 0x44);
  const bodyIv = Buffer.alloc(12, 0x45);
  const bodyCipher = createCipheriv("aes-256-gcm", dek, bodyIv);
  const ciphertext = Buffer.concat([bodyCipher.update(Buffer.from([0xc3, 0x28])), bodyCipher.final()]);
  const wrapIv = Buffer.alloc(12, 0x46);
  const wrapCipher = createCipheriv("aes-256-gcm", LEGACY_KEK, wrapIv);
  const wrapped = Buffer.concat([wrapCipher.update(dek), wrapCipher.final()]);
  const wrappedDek = Buffer.concat([wrapIv, wrapCipher.getAuthTag(), wrapped]);
  dek.fill(0);
  return legacyRow(id, "placeholder", {
    wrapped_dek: wrappedDek,
    iv: bodyIv,
    ciphertext,
    auth_tag: bodyCipher.getAuthTag(),
  });
}

function cloneRow(row: StoredRow): StoredRow {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    Buffer.isBuffer(value)
      ? Buffer.from(value)
      : value instanceof Date
        ? new Date(value.getTime())
        : value,
  ]));
}

function fakeDb(initialRows: StoredRow[], options: { sourceChangedId?: string } = {}) {
  let rows = initialRows.map(cloneRow);
  let snapshot: StoredRow[] | undefined;
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  let commits = 0;
  let rollbacks = 0;
  const db: ServerMigrationDb & {
    readonly calls: typeof calls;
    readonly commits: number;
    readonly rollbacks: number;
    readonly rows: StoredRow[];
  } = {
    calls,
    get commits() { return commits; },
    get rollbacks() { return rollbacks; },
    get rows() { return rows; },
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      if (sql === "BEGIN") {
        snapshot = rows.map(cloneRow);
        return { rows: [] };
      }
      if (sql.startsWith("SELECT set_config")) return { rows: [{ set_config: params[0] }] };
      if (sql === "COMMIT") {
        commits += 1;
        snapshot = undefined;
        return { rows: [] };
      }
      if (sql === "ROLLBACK") {
        rollbacks += 1;
        if (snapshot) rows = snapshot;
        snapshot = undefined;
        return { rows: [] };
      }
      if (sql.includes("FROM users")) {
        const users = [...new Set(rows.map((row) => String(row.user_id)))].sort().reverse();
        return { rows: [...users, ...users].map((id) => ({ id })) };
      }
      if (sql.includes("SELECT EXISTS") && sql.includes("prompt_records")) {
        const [userId] = params;
        return { rows: [{ eligible: rows.some((row) => row.user_id === userId && row.encryption_scheme === "server_v1") }] };
      }
      if (sql.includes("FOR UPDATE SKIP LOCKED")) {
        const [userId, limit] = params as [string, number];
        const selected = rows
          .filter((row) => row.user_id === userId && row.encryption_scheme === "server_v1")
          .sort((a, b) => Number(a.id) - Number(b.id))
          .slice(0, limit)
          .map(cloneRow);
        return { rows: selected };
      }
      if (sql.startsWith("UPDATE prompt_records")) {
        const [id, userId, keyVersion, wrappedDek, iv, ciphertext, authTag, dekWrapIv, dekWrapAuthTag, aadVersion] = params;
        if (String(id) === options.sourceChangedId) return { rows: [], rowCount: 0 };
        const row = rows.find((candidate) =>
          String(candidate.id) === String(id)
          && candidate.user_id === userId
          && candidate.encryption_scheme === "server_v1");
        if (!row) return { rows: [], rowCount: 0 };
        Object.assign(row, {
          key_version: keyVersion,
          wrapped_dek: wrappedDek,
          iv,
          ciphertext,
          auth_tag: authTag,
          encryption_scheme: "managed_v1",
          content_owner_id: null,
          content_key_version: keyVersion,
          dek_wrap_iv: dekWrapIv,
          dek_wrap_auth_tag: dekWrapAuthTag,
          aad_version: aadVersion,
        });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("COUNT(*)::int AS count")) {
        const [userId] = params;
        return {
          rows: [{ count: rows.filter((row) =>
            row.user_id === userId && row.encryption_scheme === "server_v1").length }],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  return db;
}

function runtime(): ManagedContentRuntime {
  return {
    installationId: INSTALLATION_ID,
    registry: null as never,
    health: null as never,
    userKeys: {
      async withActiveUserKey(userId, fn) {
        assert.equal(userId, USER_A);
        return fn(UCK, 3);
      },
      async withUserKeyVersion(_userId, _keyVersion, fn) {
        return fn(UCK);
      },
    },
  };
}

function assertCode(code: string) {
  return (error: unknown) =>
    error instanceof ServerContentMigrationError
    && error.code === code
    && error.message === code;
}

test("server_v1 batch keeps the same id and writes the complete managed_v1 shape", async () => {
  const db = fakeDb([legacyRow("41", "legacy secret")]);
  const kekBefore = Buffer.from(LEGACY_KEK);
  const uckBefore = Buffer.from(UCK);

  const result = await migrateServerContentBatch(USER_A, 25, runtime(), LEGACY_KEK, db);

  assert.deepEqual(result, { migrated: 1, remaining: 0 });
  assert.equal(db.commits, 1);
  assert.equal(db.rollbacks, 0);
  const select = db.calls.find((call) => call.sql.includes("FOR UPDATE SKIP LOCKED"))!;
  assert.match(select.sql, /SELECT id,user_id,dedup_key,session_id,provider_key,turn_role,ts,key_version,/);
  assert.deepEqual(select.params, [USER_A, 25]);
  const update = db.calls.find((call) => call.sql.startsWith("UPDATE prompt_records"))!;
  assert.match(update.sql, /content_owner_id=NULL/);
  assert.match(update.sql, /content_key_version=\$3/);
  assert.match(update.sql, /dek_wrap_iv=\$8, dek_wrap_auth_tag=\$9, aad_version=\$10/);
  assert.match(update.sql, /WHERE id=\$1 AND user_id=\$2 AND encryption_scheme='server_v1'/);
  assert.equal(update.params[0], "41");
  assert.equal(update.params[2], 3);
  assert.equal(update.params[9], 2);
  assert.equal(update.params.some((value) => value === "legacy secret"), false);
  assert.equal(db.rows[0]?.encryption_scheme, "managed_v1");
  assert.equal(db.rows[0]?.content_owner_id, null);
  assert.equal(db.rows[0]?.content_key_version, 3);
  assert.deepEqual(LEGACY_KEK, kekBefore);
  assert.deepEqual(UCK, uckBefore);
});

test("corrupt legacy row rolls back the whole batch", async () => {
  const db = fakeDb([
    legacyRow("41", "first secret"),
    legacyRow("42", "second secret", { auth_tag: Buffer.alloc(15) }),
  ]);

  await assert.rejects(
    migrateServerContentBatch(USER_A, 25, runtime(), LEGACY_KEK, db),
    assertCode("LEGACY_SOURCE_CORRUPT"),
  );
  assert.equal(db.commits, 0);
  assert.equal(db.rollbacks, 1);
  assert.deepEqual(db.rows.map((row) => row.encryption_scheme), ["server_v1", "server_v1"]);
});

test("authenticated malformed UTF-8 fails closed instead of replacement decoding", async () => {
  const db = fakeDb([invalidUtf8LegacyRow("43")]);
  await assert.rejects(
    migrateServerContentBatch(USER_A, 25, runtime(), LEGACY_KEK, db),
    assertCode("LEGACY_SOURCE_CORRUPT"),
  );
  assert.equal(db.rollbacks, 1);
  assert.equal(db.rows[0]?.encryption_scheme, "server_v1");
});

test("legacy version, owner, and every encrypted byte length are validated", async () => {
  const corruptions: Record<string, unknown>[] = [
    { key_version: 2 },
    { wrapped_dek: Buffer.alloc(59) },
    { iv: Buffer.alloc(11) },
    { ciphertext: Buffer.alloc(0) },
    { auth_tag: Buffer.alloc(15) },
  ];
  for (const corruption of corruptions) {
    const db = fakeDb([legacyRow("44", "legacy", corruption)]);
    await assert.rejects(
      migrateServerContentBatch(USER_A, 25, runtime(), LEGACY_KEK, db),
      assertCode("LEGACY_SOURCE_CORRUPT"),
    );
  }

  const otherUserDb = fakeDb([legacyRow("45", "other", { user_id: USER_B })]);
  assert.deepEqual(
    await migrateServerContentBatch(USER_A, 25, runtime(), LEGACY_KEK, otherUserDb),
    { migrated: 0, remaining: 0 },
  );
  assert.equal(otherUserDb.rows[0]?.encryption_scheme, "server_v1");
});

test("source change and managed round-trip mismatch are safe errors", async () => {
  const changed = fakeDb([legacyRow("46", "legacy")], { sourceChangedId: "46" });
  await assert.rejects(
    migrateServerContentBatch(USER_A, 25, runtime(), LEGACY_KEK, changed),
    assertCode("SOURCE_CHANGED"),
  );
  assert.equal(changed.rollbacks, 1);

  assert.throws(
    () => assertServerSourceRoundTrip({
      dedupKey: "digest",
      sessionId: null,
      providerKey: "codex",
      turnRole: "user",
      ts: new Date("2026-07-17T00:00:00.000Z"),
      text: "source",
    }, "different"),
    assertCode("MANAGED_ROUND_TRIP_FAILED"),
  );
});

test("second-row SOURCE_CHANGED rolls back the first managed update", async () => {
  const db = fakeDb([
    legacyRow("51", "first source"),
    legacyRow("52", "changed source"),
  ], { sourceChangedId: "52" });

  await assert.rejects(
    migrateServerContentBatch(USER_A, 25, runtime(), LEGACY_KEK, db),
    assertCode("SOURCE_CHANGED"),
  );
  assert.equal(db.commits, 0);
  assert.equal(db.rollbacks, 1);
  assert.deepEqual(
    db.rows.map((row) => row.encryption_scheme),
    ["server_v1", "server_v1"],
  );
});

test("limit accepts safe integers, clamps to 1..25, and rejects non-integers", async () => {
  for (const [input, expected] of [[0, 1], [1, 1], [25, 25], [99, 25]] as const) {
    const db = fakeDb([]);
    await migrateServerContentBatch(USER_A, input, runtime(), LEGACY_KEK, db);
    const select = db.calls.find((call) => call.sql.includes("FOR UPDATE SKIP LOCKED"))!;
    assert.equal(select.params[1], expected);
  }
  for (const input of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(
      migrateServerContentBatch(USER_A, input, runtime(), LEGACY_KEK, fakeDb([])),
      assertCode("INVALID_LIMIT"),
    );
  }
});

test("strict user id and legacy key validation happens before any SQL", async () => {
  for (const userId of [
    "",
    "not-a-uuid",
    `${USER_A} `,
    "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
  ]) {
    const db = fakeDb([]);
    await assert.rejects(
      migrateServerContentBatch(userId, 1, runtime(), LEGACY_KEK, db),
      assertCode("INVALID_USER_ID"),
    );
    assert.equal(db.calls.length, 0);
  }
  const db = fakeDb([]);
  await assert.rejects(
    migrateServerContentBatch(USER_A, 1, runtime(), Buffer.alloc(31), db),
    assertCode("INVALID_LEGACY_KEK"),
  );
  assert.equal(db.calls.length, 0);
});

test("canonical digest is type/length delimited and metadata-sensitive", () => {
  const base = {
    dedupKey: "ab",
    sessionId: "c",
    providerKey: "codex",
    turnRole: "user" as const,
    ts: new Date("2026-07-17T00:00:00.000Z"),
    text: "secret",
  };
  assert.notDeepEqual(
    serverSourceDigest(base),
    serverSourceDigest({ ...base, dedupKey: "a", sessionId: "bc" }),
  );
  assert.notDeepEqual(serverSourceDigest(base), serverSourceDigest({ ...base, sessionId: null }));
  assert.notDeepEqual(serverSourceDigest(base), serverSourceDigest({ ...base, text: "secret\u0000" }));
});

test("content-admin enumerates only users globally and checks server rows inside fixed-client user transactions", async () => {
  const db = fakeDb([
    legacyRow("47", "a", { user_id: USER_B }),
    legacyRow("48", "b", { user_id: USER_A }),
    legacyRow("49", "c", { user_id: USER_B }),
  ]);
  assert.deepEqual(await getServerContentMigrationUsers(db), [USER_A, USER_B]);
  assert.match(db.calls[0]!.sql, /SELECT id::text AS id FROM users ORDER BY id ASC/);
  assert.equal(db.calls[0]!.sql.includes("prompt_records"), false);
  assert.equal(db.calls.filter((call) => call.sql === "BEGIN").length, 2);
  assert.equal(db.calls.filter((call) => call.sql === "COMMIT").length, 2);
  assert.deepEqual(
    db.calls.filter((call) => call.sql.startsWith("SELECT set_config")).map((call) => call.params[0]),
    [USER_A, USER_B],
  );
  const eligibility = db.calls.filter((call) => call.sql.includes("SELECT EXISTS"));
  assert.equal(eligibility.length, 2);
  assert.equal(eligibility.every((call) => call.sql.includes("user_id=$1")), true);
});

test("no SQL, error, or return value contains plaintext, KEK, UCK, or digest", async () => {
  const secret = "unique legacy secret";
  const db = fakeDb([legacyRow("50", secret)]);
  const result = await migrateServerContentBatch(USER_A, 25, runtime(), LEGACY_KEK, db);
  assert.deepEqual(result, { migrated: 1, remaining: 0 });
  const rendered = JSON.stringify(db.calls, (_key, value) =>
    Buffer.isBuffer(value) ? `[buffer:${value.length}]` : value);
  assert.equal(rendered.includes(secret), false);
  assert.equal(rendered.includes(LEGACY_KEK.toString("hex")), false);
  assert.equal(rendered.includes(UCK.toString("hex")), false);
  assert.deepEqual(Object.keys(result).sort(), ["migrated", "remaining"]);
});
