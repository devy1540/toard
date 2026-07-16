import assert from "node:assert/strict";
import test from "node:test";
import type { ManagedContentRuntime } from "./managed-content-runtime";
import {
  E2eeManagedMigrationError,
  commitE2eeManagedBatch,
  e2eeSourceDigest,
  getE2eeManagedMigrationPage,
  getE2eeManagedMigrationStatus,
  setE2eeManagedMigrationState,
  e2eeManagedMigrationErrorCode,
  type E2eeMigrationDb,
} from "./e2ee-to-managed-migration";

const USER = "11111111-1111-4111-8111-111111111111";
const OWNER = "22222222-2222-4222-8222-222222222222";
const row = () => ({
  id: "1", user_id: USER, dedup_key: "d1", session_id: "s1", provider_key: "codex",
  turn_role: "user", ts: new Date("2026-01-02T03:04:05.000Z"), encryption_scheme: "e2ee_v1",
  key_version: 3, content_owner_id: OWNER, content_key_version: 3, aad_version: 1,
  wrapped_dek: Buffer.alloc(32, 1), dek_wrap_iv: Buffer.alloc(12, 2),
  dek_wrap_auth_tag: Buffer.alloc(16, 3), iv: Buffer.alloc(12, 4),
  ciphertext: Buffer.from("cipher"), auth_tag: Buffer.alloc(16, 5),
});

function runtime(fail = false): ManagedContentRuntime {
  return {
    installationId: "33333333-3333-4333-8333-333333333333",
    registry: {} as ManagedContentRuntime["registry"], health: {} as ManagedContentRuntime["health"],
    userKeys: {
      withActiveUserKey: async (_userId, fn) => {
        if (fail) throw new Error("provider-secret");
        const key = Buffer.alloc(32, 9);
        try { return await fn(key, 7); } finally { key.fill(0); }
      },
      withUserKeyVersion: async () => { throw new Error("unused"); },
    },
  };
}

class Db implements E2eeMigrationDb {
  calls: { sql: string; params?: unknown[] }[] = [];
  source = row(); sourceRows: Record<string, unknown>[] | null = null; remaining: unknown = 0; updateCount = 1;
  async query(sql: string, params?: unknown[]) {
    this.calls.push({ sql, params });
    if (/SELECT .*FROM prompt_records/s.test(sql) && /FOR UPDATE/.test(sql)) return { rows: [this.source] };
    if (/SELECT .*FROM prompt_records/s.test(sql) && /ORDER BY/.test(sql)) return { rows: this.sourceRows ?? [this.source] };
    if (/COUNT\(\*\).*prompt_records/s.test(sql)) return { rows: [{ count: this.remaining }] };
    if (/UPDATE prompt_records/.test(sql)) return { rows: [], rowCount: this.updateCount };
    if (/SELECT migration\.state/.test(sql)) return { rows: [{ state: "pending", started_at: null, completed_at: null, blocked_at: null, blocked_reason: null, e2ee_records: 1, migrated_records: 0 }] };
    return { rows: [], rowCount: 1 };
  }
}

test("source digest는 canonical E2EE metadata/ciphertext 전체에 민감하고 plaintext를 받지 않는다", () => {
  const first = e2eeSourceDigest(row());
  const second = e2eeSourceDigest({ ...row(), ciphertext: Buffer.from("cipher2") });
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first, second);
  assert.equal(e2eeSourceDigest({ ...row(), session_id: null }), e2eeSourceDigest({ ...row(), session_id: null }));
  assert.throws(() => e2eeSourceDigest({ ...row(), wrapped_dek: Buffer.alloc(31) }), /E2EE_SOURCE_CORRUPT/);
  assert.throws(() => e2eeSourceDigest({ ...row(), key_version: "3" }), /E2EE_SOURCE_CORRUPT/);
  assert.throws(() => e2eeSourceDigest({ ...row(), ts: "2026-01-02T03:04:05.000Z" }), /E2EE_SOURCE_CORRUPT/);
  const hostile = { ...row() };
  Object.defineProperty(hostile, "ciphertext", { get() { throw new E2eeManagedMigrationError("private prompt"); } });
  assert.throws(() => e2eeSourceDigest(hostile), /^E2eeManagedMigrationError: E2EE_SOURCE_CORRUPT$/);
});

test("remaining count malformed 값은 rollback하고 complete/account migrate를 실행하지 않는다", async () => {
  for (const remaining of [undefined, null, "", " ", "01", "1.0", "1e2", "-1", -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const db = new Db(); db.remaining = remaining;
    await assert.rejects(
      commitE2eeManagedBatch(USER, [{ id: "1", sourceDigest: e2eeSourceDigest(db.source), text: "private" }], runtime(), db),
      (error: unknown) => error instanceof E2eeManagedMigrationError && error.code === "MIGRATION_STATE_CORRUPT",
    );
    assert.equal(db.calls.at(-1)?.sql, "ROLLBACK");
    assert.equal(db.calls.some((call) => /SET state='complete'/.test(call.sql)), false);
    assert.equal(db.calls.some((call) => /UPDATE content_accounts/.test(call.sql)), false);
  }
  for (const remaining of [0, 1, "0", "1"]) {
    const db = new Db(); db.remaining = remaining;
    const result = await commitE2eeManagedBatch(USER, [{ id: "1", sourceDigest: e2eeSourceDigest(db.source), text: "private" }], runtime(), db);
    assert.equal(result.remaining, Number(remaining));
  }
});

test("migration error classifier는 module brand 없는 prototype/Proxy 위조를 거부한다", () => {
  const forged = Object.assign(Object.create(E2eeManagedMigrationError.prototype), { code: "MIGRATION_FAILED" });
  assert.equal(e2eeManagedMigrationErrorCode(forged), null);
  assert.equal(e2eeManagedMigrationErrorCode(new Proxy(forged, {})), null);
  assert.equal(e2eeManagedMigrationErrorCode(new E2eeManagedMigrationError("MIGRATION_FAILED")), "MIGRATION_FAILED");
});

test("page JSON은 ciphertext가 여러 건이어도 4MiB 경계 안에서 자른다", async () => {
  const db = new Db();
  db.sourceRows = Array.from({ length: 4 }, (_, index) => ({
    ...row(), id: String(index + 1), ciphertext: Buffer.alloc(1_048_576, index + 1),
  }));
  const page = await getE2eeManagedMigrationPage(USER, 25, db);
  assert.ok(page.records.length >= 1 && page.records.length < 4);
  assert.ok(Buffer.byteLength(JSON.stringify(page), "utf8") <= 4_194_304);
});

test("page는 사용자/e2ee 조건으로 ciphertext wire만 반환하고 limit를 clamp한다", async () => {
  const db = new Db();
  const result = await getE2eeManagedMigrationPage(USER, 99, db);
  assert.equal(result.records.length, 1);
  assert.equal("text" in result.records[0]!.record, false);
  assert.equal(result.records[0]!.sourceDigest, e2eeSourceDigest(row()));
  const select = db.calls.find((call) => /ORDER BY/.test(call.sql))!;
  assert.equal(select.sql.includes("content_e2ee_migration_sources"), false, "app role cannot read the immutable marker table");
  assert.match(select.sql, /record\.user_id=\$1/);
  assert.deepEqual(select.params, [USER, 25]);
});

test("commit은 source lock/digest를 검증하고 managed roundtrip 후 같은 E2EE row만 교체한다", async () => {
  const db = new Db();
  const digest = e2eeSourceDigest(db.source);
  const result = await commitE2eeManagedBatch(USER, [{ id: "1", sourceDigest: digest, text: "private prompt" }], runtime(), db);
  assert.deepEqual(result, { migrated: 1, remaining: 0, complete: true });
  const update = db.calls.find((call) => /UPDATE prompt_records/.test(call.sql))!;
  assert.match(update.sql, /id=\$1 AND user_id=\$2 AND encryption_scheme='e2ee_v1'/);
  assert.match(update.sql, /content_owner_id=NULL/);
  assert.match(update.sql, /aad_version=\$10/);
  assert.equal(update.params?.includes("private prompt"), false);
  assert.equal(db.calls[0]?.sql, "BEGIN");
  assert.equal(db.calls.at(-1)?.sql, "COMMIT");
});

test("stale digest, update race, runtime failure는 전체 transaction을 rollback하고 안전한 code만 낸다", async () => {
  for (const [index, configure] of [
    (db: Db) => ({ digest: Buffer.alloc(32).toString("base64url"), rt: runtime() }),
    (db: Db) => { db.updateCount = 0; return { digest: e2eeSourceDigest(db.source), rt: runtime() }; },
    (db: Db) => ({ digest: e2eeSourceDigest(db.source), rt: runtime(true) }),
  ].entries()) {
    const db = new Db(); const { digest, rt } = configure(db);
    await assert.rejects(commitE2eeManagedBatch(USER, [{ id: "1", sourceDigest: digest, text: "secret" }], rt, db), E2eeManagedMigrationError);
    if (index < 2) assert.equal(db.calls.at(-1)?.sql, "ROLLBACK");
    else assert.equal(db.calls.length, 0, "key provider failure happens before opening a DB transaction");
  }
});

test("status/state는 user scoped이고 complete는 reopen하지 않으며 block은 명시 확인을 요구한다", async () => {
  const db = new Db();
  assert.equal((await getE2eeManagedMigrationStatus(USER, db)).state, "pending");
  await assert.rejects(setE2eeManagedMigrationState(USER, { action: "block", confirmation: "wrong" } as never, db), /BLOCK_CONFIRMATION_REQUIRED/);
  await setE2eeManagedMigrationState(USER, { action: "block", confirmation: "KEY_UNAVAILABLE" }, db);
  await setE2eeManagedMigrationState(USER, { action: "resume" }, db);
  const updates = db.calls.filter((call) => /UPDATE content_e2ee_migrations/.test(call.sql));
  assert.ok(updates.every((call) => call.params?.[0] === USER));
  assert.match(updates[0]!.sql, /state<>'complete'/);
  assert.match(updates[1]!.sql, /state='blocked'/);
});

test("service DB failure는 SQL/detail을 버린 고정 오류로 변환한다", async () => {
  const secret = "postgresql://user:password@host/private";
  const db: E2eeMigrationDb = { async query() { throw new Error(secret); } };
  for (const operation of [
    () => getE2eeManagedMigrationStatus(USER, db),
    () => getE2eeManagedMigrationPage(USER, 1, db),
    () => setE2eeManagedMigrationState(USER, { action: "resume" }, db),
  ]) {
    await assert.rejects(operation(), (error: unknown) =>
      error instanceof E2eeManagedMigrationError
      && error.code === "MIGRATION_FAILED"
      && !String(error).includes(secret));
  }
});
