import assert from "node:assert/strict";
import test from "node:test";
import { encryptManagedContent } from "./managed-content-crypto";
import type { ManagedContentRuntime } from "./managed-content-runtime";
import { KeyProviderRegistry } from "./key-management/registry";
import type { KeyContext, KeyManagementProvider, WrappedUserKey } from "./key-management/types";
import {
  getProviderRewrapUsers,
  rewrapErrorCode,
  rewrapUserKey,
  type RewrapDb,
} from "./provider-rewrap";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const INSTALLATION_ID = "019f7250-dc4d-78fd-98e8-a5465d0f5b69";
const UCK = Buffer.alloc(32, 0x21);
const OLD_FINGERPRINT = "local:111111111111111111111111";
const TARGET_FINGERPRINT = "aws-kms:222222222222222222222222";

function provider(name: "local" | "aws-kms", fingerprint: string, keyRef: string, calls: string[]) {
  let unwrapResult = Buffer.from(UCK);
  const seenWrapInputs: Buffer[] = [];
  let mutateUnwrapInput = false;
  let plaintextWrapper: "alias" | "copy" | null = null;
  let invalidMetadata = false;
  const wrappedOutputs: Buffer[] = [];
  const value: KeyManagementProvider & {
    unwrapResult: Buffer;
    seenWrapInputs: Buffer[];
    wrappedOutputs: Buffer[];
    mutateUnwrapInput: boolean;
    plaintextWrapper: "alias" | "copy" | null;
    invalidMetadata: boolean;
  } = {
    name,
    fingerprint,
    keyRef,
    seenWrapInputs,
    get unwrapResult() { return unwrapResult; },
    set unwrapResult(next) { unwrapResult = next; },
    get mutateUnwrapInput() { return mutateUnwrapInput; },
    set mutateUnwrapInput(next) { mutateUnwrapInput = next; },
    get plaintextWrapper() { return plaintextWrapper; },
    set plaintextWrapper(next) { plaintextWrapper = next; },
    get invalidMetadata() { return invalidMetadata; },
    set invalidMetadata(next) { invalidMetadata = next; },
    wrappedOutputs,
    async wrapKey(key: Buffer, _context: KeyContext): Promise<WrappedUserKey> {
      calls.push(`${name}.wrap`);
      seenWrapInputs.push(key);
      const ciphertext = plaintextWrapper === "alias"
        ? key
        : plaintextWrapper === "copy"
          ? Buffer.from(key)
          : Buffer.alloc(48, 0x44);
      wrappedOutputs.push(ciphertext);
      return {
        provider: name,
        fingerprint,
        keyRef,
        ciphertext,
        metadata: invalidMetadata ? { version: 7 as never } : { version: "1" },
      };
    },
    async unwrapKey(wrapped: WrappedUserKey, _context: KeyContext): Promise<Buffer> {
      calls.push(`${name}.unwrap`);
      if (mutateUnwrapInput) wrapped.ciphertext.fill(0);
      return unwrapResult;
    },
    async healthCheck() { return { status: "healthy", latencyMs: 1, checkedAt: new Date() }; },
    async describeCredentialSource() { return { kind: "test", staticCredential: false }; },
  };
  return value;
}

function activeRow() {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    userId: USER_ID,
    keyVersion: 3,
    provider: "local",
    providerKeyRef: "local:old",
    providerFingerprint: OLD_FINGERPRINT,
    wrappedUserKey: Buffer.alloc(48, 0x33),
    wrapperMetadata: { version: "1" },
    contextVersion: 1,
    state: "active",
  };
}

function canaryRow() {
  const record = {
    dedupKey: "canary",
    sessionId: "session-canary",
    providerKey: "codex",
    turnRole: "user" as const,
    ts: new Date("2026-07-17T01:02:03.000Z"),
    text: "secret canary",
  };
  const encrypted = encryptManagedContent(record, UCK, INSTALLATION_ID, USER_ID, 3);
  return {
    dedupKey: record.dedupKey,
    providerKey: record.providerKey,
    turnRole: record.turnRole,
    ts: record.ts,
    encryptionScheme: encrypted.encryptionScheme,
    contentKeyVersion: encrypted.contentKeyVersion,
    aadVersion: encrypted.aadVersion,
    wrappedDek: encrypted.wrappedDek,
    dekWrapIv: encrypted.dekWrapIv,
    dekWrapAuthTag: encrypted.dekWrapAuthTag,
    iv: encrypted.iv,
    ciphertext: encrypted.ciphertext,
    authTag: encrypted.authTag,
  };
}

function fakeDb(options: { changeBeforeLock?: boolean; changeContextBeforeLock?: boolean; targetRetiring?: boolean; noCanary?: boolean; failAt?: "insert" | "retire" | "activate" | "audit" } = {}) {
  let active = activeRow();
  let pending: Record<string, unknown> | null = null;
  let snapshot: { active: typeof active; pending: Record<string, unknown> | null } | null = null;
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const db: RewrapDb & { calls: typeof calls; active: () => typeof active; pending: () => Record<string, unknown> | null } = {
    calls,
    active: () => active,
    pending: () => pending,
    async query(sql, params = []) {
      calls.push({ sql, params: params.map((value) => Buffer.isBuffer(value) ? Buffer.from(value) : value) });
      if (sql === "BEGIN") {
        snapshot = { active: { ...active, wrappedUserKey: Buffer.from(active.wrappedUserKey) }, pending: pending ? { ...pending } : null };
        return { rows: [] };
      }
      if (sql.startsWith("SELECT set_config")) return { rows: [] };
      if (sql === "COMMIT") { snapshot = null; return { rows: [] }; }
      if (sql === "ROLLBACK") {
        if (snapshot) { active = snapshot.active; pending = snapshot.pending; }
        snapshot = null;
        return { rows: [] };
      }
      if (sql.includes("FROM managed_content_keys") && sql.includes("state='active'") && sql.includes("FOR UPDATE")) {
        if (options.changeBeforeLock) active = { ...active, providerFingerprint: "local:333333333333333333333333" };
        if (options.changeContextBeforeLock) active = { ...active, contextVersion: 2 };
        return { rows: [active] };
      }
      if (sql.includes("FROM managed_content_keys") && sql.includes("state='active'")) return { rows: [active] };
      if (sql.includes("FROM prompt_records") && sql.includes("managed_v1")) return { rows: options.noCanary ? [] : [canaryRow()] };
      if (sql.startsWith("INSERT INTO managed_content_keys")) {
        if (options.failAt === "insert") throw new Error("contains secret raw provider error");
        if (options.targetRetiring && !sql.includes("state IN ('pending','retiring')")) return { rows: [], rowCount: 0 };
        pending = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", state: "pending", providerFingerprint: params[4] };
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith("UPDATE managed_content_keys") && sql.includes("state='retiring'")) {
        if (options.failAt === "retire") throw new Error("contains secret raw provider error");
        active = { ...active, state: "retiring" };
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith("UPDATE managed_content_keys") && sql.includes("state='active'")) {
        if (options.failAt === "activate") throw new Error("contains secret raw provider error");
        active = {
          ...active,
          id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          provider: "aws-kms",
          providerKeyRef: "arn:new",
          providerFingerprint: TARGET_FINGERPRINT,
          wrappedUserKey: Buffer.alloc(48, 0x44),
          state: "active",
        };
        pending = null;
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith("INSERT INTO content_key_security_events")) {
        if (options.failAt === "audit") throw new Error("contains audit database secret");
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  return db;
}

function runtime(calls: string[], evicted: string[]) {
  const oldProvider = provider("local", OLD_FINGERPRINT, "local:old", calls);
  const target = provider("aws-kms", TARGET_FINGERPRINT, "arn:new", calls);
  const value: ManagedContentRuntime = {
    installationId: INSTALLATION_ID,
    registry: new KeyProviderRegistry(oldProvider, target),
    health: null as never,
    userKeys: {
      async withActiveUserKey() { throw new Error("not used"); },
      async withUserKeyVersion() { throw new Error("not used"); },
      evict(userId, keyVersion, fingerprint) { evicted.push(`${userId}:${keyVersion}:${fingerprint}`); },
    },
  };
  return { value, oldProvider, target };
}

function hasCode(code: string) {
  return (error: unknown) => rewrapErrorCode(error) === code && (error as Error).message === code;
}

test("rewrap verifies wrapper and managed canary before atomic promotion", async () => {
  const calls: string[] = [];
  const evicted: string[] = [];
  const { value, oldProvider, target } = runtime(calls, evicted);
  const db = fakeDb();

  assert.deepEqual(await rewrapUserKey(USER_ID, value, db), { state: "migrated" });
  assert.deepEqual(calls, ["local.unwrap", "aws-kms.wrap", "aws-kms.unwrap"]);
  assert.match(db.calls.find((call) => call.sql.includes("FOR UPDATE"))!.sql, /state='active'.*FOR UPDATE/s);
  assert.equal(db.calls.some((call) => call.sql.includes("FROM prompt_records") && call.sql.includes("managed_v1")), true);
  assert.equal(db.calls.some((call) => call.params.some((param) => param === "secret canary")), false);
  assert.deepEqual(evicted, [`${USER_ID}:3:${OLD_FINGERPRINT}`]);
  const audit = db.calls.find((call) => call.sql.startsWith("INSERT INTO content_key_security_events"))!;
  assert.deepEqual(audit.params, [
    "user_key_rewrapped", USER_ID, "aws-kms", TARGET_FINGERPRINT, 3, null, INSTALLATION_ID,
  ]);
  assert.equal(audit.params.some((value) => Buffer.isBuffer(value)), false);
  const auditIndex = db.calls.indexOf(audit);
  const activationIndex = db.calls.findIndex((call) => (
    call.sql.startsWith("UPDATE managed_content_keys") && call.sql.includes("state='active'")
  ));
  const commitAfterAudit = db.calls.findIndex((call, index) => index > auditIndex && call.sql === "COMMIT");
  assert.ok(activationIndex < auditIndex);
  assert.ok(auditIndex < commitAfterAudit);
  assert.equal(oldProvider.unwrapResult.every((byte) => byte === 0), true, "old provider output ownership transfers and is zeroized");
  assert.equal(target.unwrapResult.every((byte) => byte === 0), true, "verification output ownership transfers and is zeroized");
  assert.equal(target.seenWrapInputs[0]!.every((byte) => byte === 0), true, "temporary wrap input is zeroized");
});

test("mismatch, concurrent change, and transaction failure keep the old active and cache", async () => {
  {
    const calls: string[] = [], evicted: string[] = [];
    const { value, target } = runtime(calls, evicted);
    target.unwrapResult = Buffer.alloc(32, 8);
    const db = fakeDb();
    await assert.rejects(rewrapUserKey(USER_ID, value, db), hasCode("PENDING_WRAPPER_MISMATCH"));
    assert.equal(db.active().state, "active");
    assert.deepEqual(evicted, []);
    assert.equal(target.unwrapResult.every((byte) => byte === 0), true);
  }
  for (const options of [
    { changeBeforeLock: true },
    { changeContextBeforeLock: true },
    { failAt: "insert" as const },
    { failAt: "retire" as const },
    { failAt: "activate" as const },
    { failAt: "audit" as const },
  ]) {
    const calls: string[] = [], evicted: string[] = [];
    const { value } = runtime(calls, evicted);
    const db = fakeDb(options);
    await assert.rejects(rewrapUserKey(USER_ID, value, db), (error: unknown) => {
      const code = rewrapErrorCode(error);
      return code === "ACTIVE_WRAPPER_CHANGED" || code === "REWRAP_FAILED";
    });
    assert.equal(db.active().state, "active");
    assert.deepEqual(evicted, []);
  }
});

test("a formerly retiring target wrapper can be verified, replaced as pending, and reactivated", async () => {
  const calls: string[] = [], evicted: string[] = [];
  const { value } = runtime(calls, evicted);
  const db = fakeDb({ targetRetiring: true });
  assert.deepEqual(await rewrapUserKey(USER_ID, value, db), { state: "migrated" });
  const upsert = db.calls.find((call) => call.sql.startsWith("INSERT INTO managed_content_keys"))!;
  assert.match(upsert.sql, /state IN \('pending','retiring'\)/);
  assert.match(upsert.sql, /state='pending'/);
});

test("provider input ownership is isolated so unwrap mutation cannot corrupt the promoted wrapper", async () => {
  const calls: string[] = [], evicted: string[] = [];
  const { value, oldProvider, target } = runtime(calls, evicted);
  oldProvider.mutateUnwrapInput = true;
  target.mutateUnwrapInput = true;
  const db = fakeDb();
  await rewrapUserKey(USER_ID, value, db);
  const insert = db.calls.find((call) => call.sql.startsWith("INSERT INTO managed_content_keys"))!;
  assert.equal((insert.params[5] as Buffer).every((byte) => byte === 0x44), true);
});

test("target provider plaintext UCK wrapper fails before unwrap, DB promotion, or cache eviction and zeroizes every owned copy", async () => {
  for (const mode of ["alias", "copy"] as const) {
    const calls: string[] = [], evicted: string[] = [];
    const { value, oldProvider, target } = runtime(calls, evicted);
    target.plaintextWrapper = mode;
    const db = fakeDb();
    await assert.rejects(
      rewrapUserKey(USER_ID, value, db),
      hasCode("PENDING_WRAPPER_PLAINTEXT"),
    );
    assert.deepEqual(calls, ["local.unwrap", "aws-kms.wrap"]);
    assert.equal(db.calls.some((call) => call.sql.startsWith("INSERT INTO managed_content_keys")), false);
    assert.equal(db.active().state, "active");
    assert.deepEqual(evicted, []);
    assert.equal(oldProvider.unwrapResult.every((byte) => byte === 0), true);
    assert.equal(target.seenWrapInputs[0]!.every((byte) => byte === 0), true);
    assert.equal(target.wrappedOutputs[0]!.every((byte) => byte === 0), true);
  }
});

test("plaintext wrapper with invalid metadata is rejected before any internal ciphertext copy and zeroizes provider ownership", async () => {
  for (const mode of ["alias", "copy"] as const) {
    const calls: string[] = [], evicted: string[] = [];
    const { value, oldProvider, target } = runtime(calls, evicted);
    target.plaintextWrapper = mode;
    target.invalidMetadata = true;
    const db = fakeDb();
    const intrinsicFrom = Buffer.from;
    let internalCiphertextCopies = 0;
    Buffer.from = function (...args: Parameters<typeof Buffer.from>) {
      if (target.wrappedOutputs.includes(args[0] as Buffer)) internalCiphertextCopies += 1;
      return Reflect.apply(intrinsicFrom, Buffer, args) as Buffer;
    } as typeof Buffer.from;
    try {
      await assert.rejects(
        rewrapUserKey(USER_ID, value, db),
        hasCode("PENDING_WRAPPER_PLAINTEXT"),
      );
    } finally {
      Buffer.from = intrinsicFrom;
    }
    assert.equal(internalCiphertextCopies, 0);
    assert.deepEqual(calls, ["local.unwrap", "aws-kms.wrap"]);
    assert.equal(db.calls.some((call) => call.sql.startsWith("INSERT INTO managed_content_keys")), false);
    assert.equal(db.active().state, "active");
    assert.deepEqual(evicted, []);
    assert.equal(oldProvider.unwrapResult.every((byte) => byte === 0), true);
    assert.equal(target.seenWrapInputs[0]!.every((byte) => byte === 0), true);
    assert.equal(target.wrappedOutputs[0]!.every((byte) => byte === 0), true);
  }
});

test("missing migration provider, missing canary, and already-current are fail-safe", async () => {
  const calls: string[] = [], evicted: string[] = [];
  const { value, oldProvider } = runtime(calls, evicted);
  value.registry = new KeyProviderRegistry(oldProvider, null);
  await assert.rejects(rewrapUserKey(USER_ID, value, fakeDb()), hasCode("MIGRATION_PROVIDER_MISSING"));

  const canaryCalls: string[] = [], canaryEvicted: string[] = [];
  const withTarget = runtime(canaryCalls, canaryEvicted);
  await assert.rejects(
    rewrapUserKey(USER_ID, withTarget.value, fakeDb({ noCanary: true })),
    hasCode("MANAGED_CANARY_MISSING"),
  );
  assert.deepEqual(canaryEvicted, []);

  const currentDb = fakeDb();
  const target = provider("aws-kms", OLD_FINGERPRINT, "local:old", []);
  value.registry = { active: oldProvider, migration: target, resolveWrappedKey: () => oldProvider } as never;
  delete value.userKeys.evict;
  assert.deepEqual(await rewrapUserKey(USER_ID, value, currentDb), { state: "already-current" });
});

test("provider enumeration reads only users globally and checks exact wrapper inside deduplicated user transactions", async () => {
  const userC = "33333333-3333-4333-8333-333333333333";
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  let currentUser: string | null = null;
  const db: RewrapDb = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes("FROM users")) return { rows: [{ id: userC }, { id: USER_ID }, { id: userC }] };
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
      if (sql.startsWith("SELECT set_config")) { currentUser = String(params[0]); return { rows: [] }; }
      if (sql.includes("SELECT EXISTS") && sql.includes("managed_content_keys")) {
        assert.equal(params[0], currentUser);
        return { rows: [{ eligible: currentUser === USER_ID }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };

  assert.deepEqual(
    await getProviderRewrapUsers("local", OLD_FINGERPRINT, db),
    [USER_ID],
  );
  assert.match(calls[0]!.sql, /SELECT id::text AS id FROM users ORDER BY id ASC/);
  assert.equal(calls[0]!.sql.includes("managed_content_keys"), false);
  assert.equal(calls.filter((call) => call.sql === "BEGIN").length, 2);
  assert.deepEqual(
    calls.filter((call) => call.sql.startsWith("SELECT set_config")).map((call) => call.params[0]),
    [USER_ID, userC],
  );
});
