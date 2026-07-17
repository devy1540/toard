import assert from "node:assert/strict";
import test from "node:test";
import { KeyProviderRegistry } from "./key-management/registry";
import type {
  CredentialSourceSummary,
  KeyContext,
  KeyManagementProvider,
  KeyProviderHealth,
  WrappedUserKey,
} from "./key-management/types";
import { UserKeyCache } from "./key-management/user-key-cache";
import {
  ManagedUserKeyService,
  type ManagedUserKeyDatabase,
  type ManagedUserKeyRow,
} from "./managed-user-keys";

const INSTALLATION_ID = "018f47d0-4d47-7b04-950b-7d18a86e1b43";
const USER_ID = "01900000-0000-7000-8000-000000000001";

type DbCall = {
  sql: string;
  params: unknown[];
};

class FakeDatabase implements ManagedUserKeyDatabase {
  readonly calls: DbCall[] = [];
  readonly rows: ManagedUserKeyRow[] = [];
  insertError: Error | null = null;
  loseInsertRaceWith: ManagedUserKeyRow | null = null;

  async query<T extends Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rows: T[]; rowCount: number }> {
    this.calls.push({ sql, params });
    const compact = sql.replace(/\s+/g, " ").trim();

    if (/SELECT .* FROM managed_content_keys/.test(compact)) {
      const userId = String(params[0]);
      const row = /state = 'active'/.test(compact)
        ? this.rows.find((candidate) => candidate.userId === userId && candidate.state === "active")
        : this.rows.find((candidate) => (
          candidate.userId === userId
          && candidate.keyVersion === Number(params[1])
          && (candidate.state === "active" || candidate.state === "retiring")
        ));
      return {
        rows: (row ? [row] : []) as unknown as T[],
        rowCount: row ? 1 : 0,
      };
    }

    if (/INSERT INTO managed_content_keys/.test(compact)) {
      if (this.insertError) throw this.insertError;
      if (this.loseInsertRaceWith) {
        this.rows.push(this.loseInsertRaceWith);
        this.loseInsertRaceWith = null;
        return { rows: [], rowCount: 0 };
      }
      const row: ManagedUserKeyRow = {
        userId: String(params[0]),
        keyVersion: Number(params[1]),
        provider: String(params[2]) as ManagedUserKeyRow["provider"],
        providerKeyRef: String(params[3]),
        providerFingerprint: String(params[4]),
        wrappedUserKey: Buffer.from(params[5] as Buffer),
        wrapperMetadata: JSON.parse(String(params[6])) as Record<string, string>,
        state: "active",
      };
      this.rows.push(row);
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`UNEXPECTED_QUERY: ${compact}`);
  }
}

class FakeProvider implements KeyManagementProvider {
  readonly name = "local" as const;
  readonly keyRef = "file:/run/secrets/toard-kek";
  readonly fingerprint = "local:test-provider";
  readonly wrapContexts: KeyContext[] = [];
  readonly unwrapContexts: KeyContext[] = [];
  wrapCalls = 0;
  unwrapCalls = 0;
  wrapError: Error | null = null;

  async wrapKey(uck: Buffer, context: KeyContext): Promise<WrappedUserKey> {
    this.wrapCalls += 1;
    this.wrapContexts.push(context);
    if (this.wrapError) throw this.wrapError;
    return {
      provider: this.name,
      keyRef: this.keyRef,
      fingerprint: this.fingerprint,
      ciphertext: Buffer.from(uck),
      metadata: { format: "test-v1" },
    };
  }

  async unwrapKey(wrapped: WrappedUserKey, context: KeyContext): Promise<Buffer> {
    this.unwrapCalls += 1;
    this.unwrapContexts.push(context);
    return Buffer.from(wrapped.ciphertext);
  }

  async healthCheck(): Promise<KeyProviderHealth> {
    return { status: "healthy", latencyMs: 0, checkedAt: new Date(0) };
  }

  async describeCredentialSource(): Promise<CredentialSourceSummary> {
    return { kind: "test", staticCredential: false };
  }
}

function storedRow(
  overrides: Partial<ManagedUserKeyRow> = {},
): ManagedUserKeyRow {
  return {
    userId: USER_ID,
    keyVersion: 1,
    provider: "local",
    providerKeyRef: "file:/run/secrets/toard-kek",
    providerFingerprint: "local:test-provider",
    wrappedUserKey: Buffer.alloc(32, 7),
    wrapperMetadata: { format: "test-v1" },
    state: "active",
    ...overrides,
  };
}

function createService(input: {
  db?: FakeDatabase;
  provider?: FakeProvider;
  generatedKey?: Buffer;
}) {
  const db = input.db ?? new FakeDatabase();
  const provider = input.provider ?? new FakeProvider();
  const contexts: string[] = [];
  const service = new ManagedUserKeyService({
    installationId: INSTALLATION_ID,
    registry: new KeyProviderRegistry(provider, null),
    cache: new UserKeyCache({ ttlMs: 300_000 }),
    runInUserContext: async (userId, fn) => {
      contexts.push(userId);
      return fn(db);
    },
    randomBytes: () => input.generatedKey ?? Buffer.alloc(32, 9),
  });
  return { service, db, provider, contexts };
}

test("첫 사용자 키는 wrap 후 active로 저장하고 재조회는 unwrap cache를 사용한다", async () => {
  const generatedKey = Buffer.alloc(32, 9);
  const { service, db, provider, contexts } = createService({ generatedKey });

  await service.withActiveUserKey(USER_ID, async (key, version) => {
    assert.equal(key.length, 32);
    assert.equal(key[0], 9);
    assert.equal(version, 1);
  });
  await service.withActiveUserKey(USER_ID, async (key, version) => {
    assert.equal(key[0], 9);
    assert.equal(version, 1);
  });

  assert.equal(provider.wrapCalls, 1);
  assert.equal(provider.unwrapCalls, 1);
  assert.equal(generatedKey.every((byte) => byte === 0), true);
  assert.deepEqual(provider.wrapContexts, [{
    installationId: INSTALLATION_ID,
    userId: USER_ID,
    keyVersion: 1,
    purpose: "prompt-history",
  }]);
  assert.deepEqual(provider.unwrapContexts, provider.wrapContexts);
  assert.deepEqual(contexts, [USER_ID, USER_ID]);
  const insert = db.calls.find((call) => /INSERT INTO managed_content_keys/.test(call.sql))!;
  assert.match(insert.sql, /VALUES \(\$1/);
  assert.match(insert.sql, /ON CONFLICT DO NOTHING/);
  assert.equal(insert.params[0], USER_ID);
});

test("모든 managed key 접근은 user context와 SQL user_id 조건을 함께 사용한다", async () => {
  const db = new FakeDatabase();
  db.rows.push(storedRow());
  const { service, contexts } = createService({ db });

  await service.withActiveUserKey(USER_ID, async () => undefined);
  await service.withUserKeyVersion(USER_ID, 1, async () => undefined);

  assert.deepEqual(contexts, [USER_ID, USER_ID]);
  const managedCalls = db.calls.filter((call) => /managed_content_keys/.test(call.sql));
  assert.equal(managedCalls.length, 2);
  for (const call of managedCalls) {
    assert.match(call.sql, /WHERE user_id\s*=\s*\$1/);
    assert.equal(call.params[0], USER_ID);
  }
});

test("버전 조회는 active와 retiring만 허용하고 pending은 사용하지 않는다", async () => {
  const db = new FakeDatabase();
  db.rows.push(
    storedRow({ keyVersion: 2, state: "pending", wrappedUserKey: Buffer.alloc(32, 2) }),
    storedRow({ keyVersion: 3, state: "retiring", wrappedUserKey: Buffer.alloc(32, 3) }),
  );
  const { service, provider } = createService({ db });

  await assert.rejects(
    service.withUserKeyVersion(USER_ID, 2, async () => undefined),
    /MANAGED_USER_KEY_NOT_FOUND/,
  );
  const value = await service.withUserKeyVersion(USER_ID, 3, async (key) => key[0]);

  assert.equal(value, 3);
  assert.equal(provider.unwrapCalls, 1);
  const versionSql = db.calls.find((call) => call.params[1] === 2)!.sql;
  assert.match(versionSql, /state IN \('active', 'retiring'\)/);
});

test("active 생성 race의 loser는 생성 UCK를 폐기하고 DB winner wrapper를 다시 읽는다", async () => {
  const generatedKey = Buffer.alloc(32, 0x11);
  const db = new FakeDatabase();
  db.loseInsertRaceWith = storedRow({ wrappedUserKey: Buffer.alloc(32, 0x22) });
  const { service, provider } = createService({ db, generatedKey });

  const value = await service.withActiveUserKey(USER_ID, async (key) => key[0]);

  assert.equal(value, 0x22);
  assert.equal(provider.wrapCalls, 1);
  assert.equal(provider.unwrapCalls, 1);
  assert.equal(generatedKey.every((byte) => byte === 0), true);
  assert.equal(
    db.calls.filter((call) => /SELECT .* FROM managed_content_keys/s.test(call.sql)).length,
    2,
  );
});

test("wrap 또는 INSERT 실패 경로에서도 생성 UCK를 zeroize한다", async () => {
  const wrapKey = Buffer.alloc(32, 0x33);
  const wrapProvider = new FakeProvider();
  wrapProvider.wrapError = new Error("WRAP_FAILED");
  const wrapFixture = createService({ provider: wrapProvider, generatedKey: wrapKey });

  await assert.rejects(
    wrapFixture.service.withActiveUserKey(USER_ID, async () => undefined),
    /WRAP_FAILED/,
  );
  assert.equal(wrapKey.every((byte) => byte === 0), true);

  const insertKey = Buffer.alloc(32, 0x44);
  const insertDb = new FakeDatabase();
  insertDb.insertError = new Error("INSERT_FAILED");
  const insertFixture = createService({ db: insertDb, generatedKey: insertKey });

  await assert.rejects(
    insertFixture.service.withActiveUserKey(USER_ID, async () => undefined),
    /INSERT_FAILED/,
  );
  assert.equal(insertKey.every((byte) => byte === 0), true);
});

test("생성 UCK가 32바이트가 아니면 provider 호출 전에 거부하고 zeroize한다", async () => {
  const generatedKey = Buffer.alloc(31, 0x55);
  const { service, provider } = createService({ generatedKey });

  await assert.rejects(
    service.withActiveUserKey(USER_ID, async () => undefined),
    /USER_KEY_LENGTH_INVALID/,
  );

  assert.equal(provider.wrapCalls, 0);
  assert.equal(generatedKey.every((byte) => byte === 0), true);
});

test("provider 전환 cache eviction은 정확한 installation/user/version/fingerprint 항목만 제거한다", async () => {
  const db = new FakeDatabase();
  db.rows.push(storedRow());
  const { service, provider } = createService({ db });

  await service.withActiveUserKey(USER_ID, async () => undefined);
  service.evict(USER_ID, 1, "local:other-provider");
  await service.withActiveUserKey(USER_ID, async () => undefined);
  assert.equal(provider.unwrapCalls, 1);

  service.evict(USER_ID, 1, "local:test-provider");
  await service.withActiveUserKey(USER_ID, async () => undefined);
  assert.equal(provider.unwrapCalls, 2);
});
