# Managed Encryption Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** local KEK 공급자만으로 설치 키 → 사용자 UCK → 레코드 DEK 계층과 `managed_v1` 저장 형식을 완성한다.

**Architecture:** 설치 UUID와 사용자별 wrapped UCK를 PostgreSQL에 저장하되 평문 UCK는 앱 메모리에만 둔다. `KeyManagementProvider` adapter는 versioned context payload만 감싸며, 본문은 사용자 UCK로 감싼 레코드별 DEK를 사용해 AES-256-GCM으로 암호화한다. 첫 계획은 외부 SDK 없이 local secret file 공급자와 30분 single-flight cache까지 구현해 다음 공급자 계획의 기준 계약을 만든다.

**Tech Stack:** Node.js >=20, TypeScript 5.7, Next.js 15, PostgreSQL 16 RLS, Node `crypto`, Node test runner, Docker migration integration tests.

## Global Constraints

- 신규 저장 형식은 `managed_v1`이며 신규 E2EE 설정을 만들지 않는다.
- 설치 ID는 비밀값이 아니며 DB singleton UUID로 생성하고 DB 백업과 함께 복구한다.
- UCK는 사용자별 32바이트, DEK는 레코드별 32바이트, 모든 AES-GCM nonce는 12바이트, tag는 16바이트다.
- 공급자가 감싸는 payload는 `TUK1 | SHA-256(canonical context) | UCK`의 고정 68바이트다.
- canonical context는 `installationId`, `userId`, `keyVersion`, `purpose=prompt-history` 순서 JSON이다.
- 평문 UCK·DEK·본문과 local KEK는 DB, 로그, 오류 응답, telemetry에 저장하지 않는다.
- user key cache 기본 TTL은 1,800초이며 허용 범위는 300~3,600초다.
- 같은 cache key의 동시 unwrap은 한 번의 provider 호출로 합친다.
- DB RLS와 애플리케이션 `user_id` 조건을 동시에 사용한다.
- `server_v1`과 `e2ee_v1` 데이터와 읽기 경로는 이 계획에서 제거하지 않는다.

---

## File Structure

- `migrations/1700000035_managed_content_foundation.sql`: 설치 UUID, managed UCK wrapper, `managed_v1` 행 제약, 비민감 집계 상태.
- `scripts/managed-content-migration.integration.test.ts`: migration 35 제약조건·RLS·집계 trigger 통합 검증.
- `apps/web/lib/key-management/types.ts`: 공급자·context·wrapper·health 공통 타입.
- `apps/web/lib/key-management/context.ts`: canonical context, 68바이트 payload encode/decode.
- `apps/web/lib/key-management/config.ts`: active/migration 프로필과 cache TTL 환경변수 parser.
- `apps/web/lib/key-management/local-provider.ts`: secret file 기반 AES-256-GCM local adapter.
- `apps/web/lib/key-management/registry.ts`: active/migration fingerprint resolver.
- `apps/web/lib/key-management/user-key-cache.ts`: TTL, zeroize, single-flight 메모리 cache.
- `apps/web/lib/managed-user-keys.ts`: 사용자 active UCK 생성·조회·unwrap repository.
- `apps/web/lib/managed-content-crypto.ts`: 레코드 DEK와 본문 AES-GCM, AAD v2.
- `apps/web/lib/legacy-content-crypto.ts`: 현재 `content-crypto.ts`의 `server_v1` 구현.
- `apps/web/lib/content-crypto.ts`: legacy와 managed 공개 API를 재수출하는 호환 facade.

---

### Task 1: managed 데이터 모델과 비민감 상태 집계

**Files:**
- Create: `migrations/1700000035_managed_content_foundation.sql`
- Create: `scripts/managed-content-migration.integration.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces table `installation_identity(singleton, installation_id, created_at)`.
- Produces table `managed_content_keys(user_id, key_version, provider, provider_key_ref, provider_fingerprint, wrapped_user_key, wrapper_metadata, context_version, state, created_at, verified_at, retired_at)`.
- Produces table `content_encryption_status(singleton, server_records, e2ee_records, managed_records, active_user_keys, pending_user_keys, retiring_user_keys, updated_at)`.
- Extends `prompt_records.encryption_scheme` with `managed_v1`.

- [ ] **Step 1: migration 통합 실패 테스트를 작성한다**

```ts
test("migration 35 creates managed key RLS and managed_v1 shape", { timeout: 90_000 }, async () => {
  const installation = await client.query(
    "SELECT installation_id FROM installation_identity WHERE singleton=TRUE",
  );
  assert.equal(installation.rowCount, 1);

  await client.query("BEGIN");
  await client.query("SELECT set_config('app.current_user_id', $1, true)", [userA]);
  await client.query(
    `INSERT INTO managed_content_keys
       (user_id,key_version,provider,provider_key_ref,provider_fingerprint,
        wrapped_user_key,wrapper_metadata,context_version,state)
     VALUES($1,1,'local','file:/run/secrets/toard-kek',$2,$3,'{}',1,'active')`,
    [userA, "local:test", Buffer.alloc(96, 7)],
  );
  assert.equal(
    (await client.query("SELECT user_id FROM managed_content_keys ORDER BY user_id")).rowCount,
    1,
  );
  await client.query("ROLLBACK");

  await assert.rejects(
    client.query(
      `INSERT INTO prompt_records
         (dedup_key,user_id,provider_key,turn_role,ts,key_version,wrapped_dek,iv,
          ciphertext,auth_tag,encryption_scheme,content_key_version,
          dek_wrap_iv,dek_wrap_auth_tag,aad_version)
       VALUES('broken',$1,'codex','user',now(),1,$2,$3,$4,$5,
              'managed_v1',1,NULL,$6,2)`,
      [userA, Buffer.alloc(32), Buffer.alloc(12), Buffer.from("x"), Buffer.alloc(16), Buffer.alloc(16)],
    ),
    /prompt_records_encryption_shape/,
  );
});
```

- [ ] **Step 2: 테스트가 migration 파일 부재로 실패하는지 확인한다**

Run: `node --import tsx --test scripts/managed-content-migration.integration.test.ts`

Expected: FAIL with `ENOENT ... 1700000035_managed_content_foundation.sql`.

- [ ] **Step 3: additive migration을 구현한다**

```sql
CREATE TABLE installation_identity (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  installation_id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO installation_identity(singleton) VALUES(TRUE);

CREATE TABLE managed_content_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_version SMALLINT NOT NULL CHECK (key_version > 0),
  provider TEXT NOT NULL CHECK (provider IN (
    'local','aws-kms','gcp-kms','azure-key-vault','vault-transit','openbao-transit'
  )),
  provider_key_ref TEXT NOT NULL CHECK (char_length(provider_key_ref) BETWEEN 1 AND 2048),
  provider_fingerprint TEXT NOT NULL CHECK (char_length(provider_fingerprint) BETWEEN 8 AND 128),
  wrapped_user_key BYTEA NOT NULL CHECK (octet_length(wrapped_user_key) BETWEEN 32 AND 16384),
  wrapper_metadata JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(wrapper_metadata) = 'object'),
  context_version SMALLINT NOT NULL DEFAULT 1 CHECK (context_version = 1),
  state TEXT NOT NULL CHECK (state IN ('active','pending','retiring')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_at TIMESTAMPTZ,
  retired_at TIMESTAMPTZ,
  UNIQUE(user_id, key_version, provider_fingerprint)
);
CREATE UNIQUE INDEX managed_content_keys_one_active
  ON managed_content_keys(user_id) WHERE state='active';
CREATE UNIQUE INDEX managed_content_keys_one_pending
  ON managed_content_keys(user_id) WHERE state='pending';

ALTER TABLE managed_content_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE managed_content_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY managed_content_keys_owner_select ON managed_content_keys
  FOR SELECT USING (user_id=current_setting('app.current_user_id', true)::uuid);
CREATE POLICY managed_content_keys_owner_insert ON managed_content_keys
  FOR INSERT WITH CHECK (user_id=current_setting('app.current_user_id', true)::uuid);
CREATE POLICY managed_content_keys_owner_update ON managed_content_keys
  FOR UPDATE
  USING (user_id=current_setting('app.current_user_id', true)::uuid)
  WITH CHECK (user_id=current_setting('app.current_user_id', true)::uuid);

ALTER TABLE prompt_records DROP CONSTRAINT prompt_records_encryption_scheme_check;
ALTER TABLE prompt_records DROP CONSTRAINT prompt_records_e2ee_shape;
ALTER TABLE prompt_records
  ADD CONSTRAINT prompt_records_encryption_scheme_check
    CHECK (encryption_scheme IN ('server_v1','e2ee_v1','managed_v1')),
  ADD CONSTRAINT prompt_records_encryption_shape CHECK (
    encryption_scheme='server_v1'
    OR (
      encryption_scheme='e2ee_v1'
      AND content_owner_id IS NOT NULL
      AND content_key_version > 0
      AND octet_length(wrapped_dek)=32
      AND octet_length(dek_wrap_iv)=12
      AND octet_length(dek_wrap_auth_tag)=16
      AND octet_length(iv)=12
      AND octet_length(auth_tag)=16
      AND octet_length(ciphertext)>0
      AND aad_version=1
    )
    OR (
      encryption_scheme='managed_v1'
      AND content_owner_id IS NULL
      AND content_key_version > 0
      AND octet_length(wrapped_dek)=32
      AND octet_length(dek_wrap_iv)=12
      AND octet_length(dek_wrap_auth_tag)=16
      AND octet_length(iv)=12
      AND octet_length(auth_tag)=16
      AND octet_length(ciphertext)>0
      AND aad_version=2
    )
  );
```

같은 migration에서 `content_encryption_status`를 만들고 기존 행을 scheme별로 초기 집계한다. `prompt_records`의 INSERT/DELETE/`encryption_scheme` UPDATE와 `managed_content_keys.state` 변경 trigger가 해당 숫자만 증감하게 한다. trigger 함수는 `SECURITY DEFINER SET search_path=public,pg_temp`로 고정하고 wrapper·본문 값은 읽거나 복사하지 않는다.

- [ ] **Step 4: Down guard와 app role 권한을 추가한다**

```sql
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM prompt_records WHERE encryption_scheme='managed_v1')
     OR EXISTS (SELECT 1 FROM managed_content_keys) THEN
    RAISE EXCEPTION 'migration 35 rollback blocked: managed content exists';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='toard_app') THEN
    GRANT SELECT ON installation_identity, content_encryption_status TO toard_app;
    GRANT SELECT, INSERT, UPDATE ON managed_content_keys TO toard_app;
  END IF;
END $$;
```

- [ ] **Step 5: migration 테스트와 전체 migration suite를 통과시킨다**

Run: `node --import tsx --test scripts/managed-content-migration.integration.test.ts && pnpm test:migrations`

Expected: managed migration PASS, 기존 migration tests PASS, 임시 PostgreSQL container가 `finally`에서 제거됨.

- [ ] **Step 6: Task 1을 커밋한다**

```bash
git add migrations/1700000035_managed_content_foundation.sql scripts/managed-content-migration.integration.test.ts package.json
git commit -m "feat(security): managed 콘텐츠 데이터 모델 추가"
```

---

### Task 2: provider 계약, context payload, local adapter

**Files:**
- Create: `apps/web/lib/key-management/types.ts`
- Create: `apps/web/lib/key-management/context.ts`
- Create: `apps/web/lib/key-management/context.test.ts`
- Create: `apps/web/lib/key-management/config.ts`
- Create: `apps/web/lib/key-management/config.test.ts`
- Create: `apps/web/lib/key-management/local-provider.ts`
- Create: `apps/web/lib/key-management/local-provider.test.ts`
- Create: `apps/web/lib/key-management/registry.ts`
- Create: `apps/web/lib/key-management/registry.test.ts`

**Interfaces:**
- Produces `KeyManagementProvider`, `KeyContext`, `WrappedUserKey`, `KeyProviderHealth`.
- Produces `encodeUserKeyPayload(uck, context): Buffer`.
- Produces `decodeUserKeyPayload(payload, context): Buffer`.
- Produces `loadKeyManagementConfig(env): KeyManagementConfig`.
- Produces `LocalKeyManagementProvider`.
- Produces `KeyProviderRegistry.active`, `KeyProviderRegistry.migration`.
- Produces `KeyProviderRegistry.resolveWrappedKey(wrapped): KeyManagementProvider`.

- [ ] **Step 1: context와 config 실패 테스트를 작성한다**

```ts
test("context payload는 다른 사용자와 설치에서 열리지 않는다", () => {
  const uck = Buffer.alloc(32, 7);
  const payload = encodeUserKeyPayload(uck, CONTEXT);
  assert.equal(payload.length, 68);
  assert.deepEqual(decodeUserKeyPayload(payload, CONTEXT), uck);
  assert.throws(
    () => decodeUserKeyPayload(payload, { ...CONTEXT, userId: OTHER_USER }),
    /USER_KEY_CONTEXT_MISMATCH/,
  );
});

test("cache TTL과 active local file을 엄격히 검증한다", () => {
  assert.throws(() => loadKeyManagementConfig({}), /TOARD_KEY_ACTIVE_PROVIDER/);
  assert.throws(
    () => loadKeyManagementConfig({
      TOARD_KEY_ACTIVE_PROVIDER: "local",
      TOARD_KEY_ACTIVE_LOCAL_KEK_FILE: "/run/secrets/kek",
      TOARD_USER_KEY_CACHE_TTL_SECONDS: "3601",
    }),
    /300~3600/,
  );
});
```

- [ ] **Step 2: 테스트가 모듈 부재로 실패하는지 확인한다**

Run: `pnpm --filter @toard/web exec node --import tsx --test lib/key-management/context.test.ts lib/key-management/config.test.ts`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: 공통 타입과 68바이트 payload를 구현한다**

```ts
export type KeyProviderName =
  | "local" | "aws-kms" | "gcp-kms" | "azure-key-vault"
  | "vault-transit" | "openbao-transit";

export type KeyContext = {
  installationId: string;
  userId: string;
  keyVersion: number;
  purpose: "prompt-history";
};

export type WrappedUserKey = {
  provider: KeyProviderName;
  keyRef: string;
  fingerprint: string;
  ciphertext: Buffer;
  metadata: Record<string, string>;
};

export interface KeyManagementProvider {
  readonly name: KeyProviderName;
  readonly keyRef: string;
  readonly fingerprint: string;
  wrapKey(uck: Buffer, context: KeyContext): Promise<WrappedUserKey>;
  unwrapKey(wrapped: WrappedUserKey, context: KeyContext): Promise<Buffer>;
  healthCheck(): Promise<KeyProviderHealth>;
  describeCredentialSource(): Promise<CredentialSourceSummary>;
}
```

```ts
const MAGIC = Buffer.from("TUK1");

export function canonicalKeyContext(context: KeyContext): Buffer {
  return Buffer.from(JSON.stringify({
    installationId: context.installationId,
    userId: context.userId,
    keyVersion: context.keyVersion,
    purpose: context.purpose,
  }), "utf8");
}

export function encodeUserKeyPayload(uck: Buffer, context: KeyContext): Buffer {
  if (uck.length !== 32) throw new Error("USER_KEY_LENGTH_INVALID");
  return Buffer.concat([MAGIC, createHash("sha256").update(canonicalKeyContext(context)).digest(), uck]);
}

export function decodeUserKeyPayload(payload: Buffer, context: KeyContext): Buffer {
  if (payload.length !== 68 || !timingSafeEqual(payload.subarray(0, 4), MAGIC)) {
    throw new Error("USER_KEY_PAYLOAD_INVALID");
  }
  const expected = createHash("sha256").update(canonicalKeyContext(context)).digest();
  if (!timingSafeEqual(payload.subarray(4, 36), expected)) {
    throw new Error("USER_KEY_CONTEXT_MISMATCH");
  }
  return Buffer.from(payload.subarray(36, 68));
}
```

- [ ] **Step 4: active/migration config parser를 구현한다**

```ts
export type ProviderProfile = {
  slot: "active" | "migration";
  provider: KeyProviderName;
  settings: Readonly<Record<string, string>>;
};

export type KeyManagementConfig = {
  active: ProviderProfile;
  migration: ProviderProfile | null;
  cacheTtlMs: number;
};

export function loadKeyManagementConfig(env: NodeJS.ProcessEnv): KeyManagementConfig {
  const active = parseProfile("active", env);
  const migration = env.TOARD_KEY_MIGRATION_PROVIDER ? parseProfile("migration", env) : null;
  const ttl = Number(env.TOARD_USER_KEY_CACHE_TTL_SECONDS ?? "1800");
  if (!Number.isSafeInteger(ttl) || ttl < 300 || ttl > 3600) {
    throw new Error("TOARD_USER_KEY_CACHE_TTL_SECONDS는 300~3600 정수여야 합니다");
  }
  if (migration && migration.provider === active.provider
      && stableSettings(migration.settings) === stableSettings(active.settings)) {
    throw new Error("active와 migration provider fingerprint가 같을 수 없습니다");
  }
  return { active, migration, cacheTtlMs: ttl * 1000 };
}
```

`parseProfile`은 local일 때 `${PREFIX}_LOCAL_KEK_FILE` 절대경로 하나만 허용한다. `PREFIX`는 `TOARD_KEY_ACTIVE` 또는 `TOARD_KEY_MIGRATION`이다. secret raw 값 환경변수는 신규 정상 설정으로 허용하지 않는다.

- [ ] **Step 5: local adapter 실패 테스트를 작성한다**

```ts
test("local provider는 context payload를 AES-GCM으로 감싸고 secret을 노출하지 않는다", async () => {
  const provider = new LocalKeyManagementProvider({
    keyFile: fixture.path,
    readFile: fixture.readFile,
  });
  const wrapped = await provider.wrapKey(Buffer.alloc(32, 9), CONTEXT);
  assert.equal(wrapped.provider, "local");
  assert.equal(wrapped.metadata.algorithm, "aes-256-gcm");
  assert.equal(wrapped.ciphertext.includes(Buffer.alloc(32, 9)), false);
  assert.deepEqual(await provider.unwrapKey(wrapped, CONTEXT), Buffer.alloc(32, 9));
  await assert.rejects(provider.unwrapKey(wrapped, { ...CONTEXT, keyVersion: 2 }), /CONTEXT/);
});
```

- [ ] **Step 6: local adapter와 registry를 구현한다**

```ts
export class LocalKeyManagementProvider implements KeyManagementProvider {
  readonly name = "local" as const;
  readonly keyRef: string;
  readonly fingerprint: string;
  private readonly kek: Buffer;

  constructor(input: { keyFile: string; readFile?: typeof readFileSync }) {
    const raw = (input.readFile ?? readFileSync)(input.keyFile);
    if (raw.length !== 32) throw new Error("LOCAL_KEK_FILE_MUST_BE_32_BYTES");
    this.kek = Buffer.from(raw);
    this.keyRef = `file:${input.keyFile}`;
    this.fingerprint = `local:${createHash("sha256").update(this.kek).digest("hex").slice(0, 24)}`;
  }

  async wrapKey(uck: Buffer, context: KeyContext): Promise<WrappedUserKey> {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.kek, iv);
    cipher.setAAD(canonicalKeyContext(context));
    const encrypted = Buffer.concat([cipher.update(encodeUserKeyPayload(uck, context)), cipher.final()]);
    return {
      provider: this.name,
      keyRef: this.keyRef,
      fingerprint: this.fingerprint,
      ciphertext: Buffer.concat([iv, cipher.getAuthTag(), encrypted]),
      metadata: { algorithm: "aes-256-gcm", format: "local-v1" },
    };
  }
}
```

`unwrapKey`는 `[iv 12 | tag 16 | encrypted payload]` 길이를 검증하고 같은 AAD로 복호화한 뒤 `decodeUserKeyPayload`를 호출한다. `KeyProviderRegistry`는 active와 optional migration provider를 fingerprint Map으로 보유하고 wrapper의 provider·keyRef·fingerprint가 모두 일치할 때만 반환한다.

```ts
export class KeyProviderRegistry {
  readonly active: KeyManagementProvider;
  readonly migration: KeyManagementProvider | null;

  constructor(active: KeyManagementProvider, migration: KeyManagementProvider | null) {
    this.active = active;
    this.migration = migration;
  }

  resolveWrappedKey(wrapped: WrappedUserKey): KeyManagementProvider {
    // provider, keyRef, fingerprint가 모두 일치하는 등록 provider만 반환한다.
  }
}
```

- [ ] **Step 7: Task 2 테스트와 typecheck를 통과시킨다**

Run: `pnpm --filter @toard/web exec node --import tsx --test 'lib/key-management/*.test.ts' && pnpm --filter @toard/web typecheck`

Expected: key-management tests PASS, TypeScript error 0.

- [ ] **Step 8: Task 2를 커밋한다**

```bash
git add apps/web/lib/key-management
git commit -m "feat(security): local 키 관리 provider 추가"
```

---

### Task 3: 사용자 키 cache와 managed UCK repository

**Files:**
- Create: `apps/web/lib/key-management/user-key-cache.ts`
- Create: `apps/web/lib/key-management/user-key-cache.test.ts`
- Create: `apps/web/lib/managed-user-keys.ts`
- Create: `apps/web/lib/managed-user-keys.test.ts`

**Interfaces:**
- Consumes `KeyProviderRegistry`, `KeyContext`, `managed_content_keys`, `installation_identity`.
- Produces `UserKeyCache.withKey(cacheKey, loader, fn)`.
- Produces `ManagedUserKeyService.withActiveUserKey(userId, fn)`.
- Produces `ManagedUserKeyService.withUserKeyVersion(userId, keyVersion, fn)`.

- [ ] **Step 1: cache single-flight와 zeroize 실패 테스트를 작성한다**

```ts
test("동시 cache miss는 loader 한 번으로 합쳐지고 만료 시 key를 zeroize한다", async () => {
  let loads = 0;
  const cache = new UserKeyCache({ ttlMs: 300_000, now: clock.now });
  const load = async () => { loads += 1; return Buffer.alloc(32, 7); };
  const values = await Promise.all([
    cache.withKey("u:1", load, async (key) => key[0]),
    cache.withKey("u:1", load, async (key) => key[0]),
  ]);
  assert.deepEqual(values, [7, 7]);
  assert.equal(loads, 1);
  clock.advance(300_001);
  await cache.withKey("u:1", load, async () => undefined);
  assert.equal(loads, 2);
});
```

- [ ] **Step 2: cache 테스트가 모듈 부재로 실패하는지 확인한다**

Run: `pnpm --filter @toard/web exec node --import tsx --test lib/key-management/user-key-cache.test.ts`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: callback 기반 cache를 구현한다**

```ts
export class UserKeyCache {
  private readonly entries = new Map<string, { key: Buffer; expiresAt: number }>();
  private readonly inflight = new Map<string, Promise<Buffer>>();

  async withKey<T>(
    cacheKey: string,
    loader: () => Promise<Buffer>,
    fn: (key: Buffer) => Promise<T> | T,
  ): Promise<T> {
    const key = await this.load(cacheKey, loader);
    return fn(key);
  }

  evict(cacheKey: string): void {
    const entry = this.entries.get(cacheKey);
    entry?.key.fill(0);
    this.entries.delete(cacheKey);
  }
}
```

`load`는 만료 entry를 먼저 `evict`, 기존 inflight를 await, 새 loader 결과가 정확히 32바이트인지 확인하고 cache에 보관한다. loader 실패는 cache하지 않으며 `finally`에서 inflight Map을 제거한다.

- [ ] **Step 4: managed UCK repository 실패 테스트를 작성한다**

```ts
test("첫 사용자 키는 wrap 후 active로 저장하고 재조회는 unwrap만 한다", async () => {
  const service = createService({ db, provider, installationId: INSTALLATION_ID });
  await service.withActiveUserKey(USER_ID, async (key) => assert.equal(key.length, 32));
  await service.withActiveUserKey(USER_ID, async (key) => assert.equal(key.length, 32));
  assert.equal(provider.wrapCalls, 1);
  assert.equal(provider.unwrapCalls, 1);
  assert.match(db.calls.find((call) => /INSERT INTO managed_content_keys/.test(call.sql))!.sql,
    /ON CONFLICT DO NOTHING/);
});
```

- [ ] **Step 5: UCK service를 구현한다**

```ts
export class ManagedUserKeyService {
  async withActiveUserKey<T>(
    userId: string,
    fn: (key: Buffer, version: number) => Promise<T> | T,
  ): Promise<T> {
    const row = await this.loadOrCreateActive(userId);
    const context = {
      installationId: this.installationId,
      userId,
      keyVersion: row.keyVersion,
      purpose: "prompt-history" as const,
    };
    const cacheKey = [
      this.installationId, userId, row.keyVersion, row.providerFingerprint,
    ].join(":");
    return this.cache.withKey(cacheKey, async () => {
      const provider = this.registry.resolveWrappedKey(toWrapped(row));
      return provider.unwrapKey(toWrapped(row), context);
    }, (key) => fn(key, row.keyVersion));
  }

  async withUserKeyVersion<T>(
    userId: string,
    keyVersion: number,
    fn: (key: Buffer) => Promise<T> | T,
  ): Promise<T> {
    const row = await this.loadVersion(userId, keyVersion);
    return this.withRowKey(userId, row, (key) => fn(key));
  }
}
```

`withActiveUserKey`와 `withUserKeyVersion`은 공통 private `withRowKey`를 사용한다. `loadOrCreateActive`는 먼저 user context에서 active row를 읽는다. 없으면 `randomBytes(32)` UCK를 active provider로 wrap하고 `INSERT ... ON CONFLICT DO NOTHING` 후 UCK를 `fill(0)`한다. race에서 insert가 0건이면 DB의 active row를 다시 읽고 그 wrapper를 사용한다. `loadVersion`은 active·retiring 상태에서 지정 버전을 찾으며 pending wrapper를 일반 읽기에 사용하지 않는다. 설치 ID는 `installation_identity`에서 한 번 읽어 service에 주입한다.

- [ ] **Step 6: Task 3 테스트와 typecheck를 통과시킨다**

Run: `pnpm --filter @toard/web exec node --import tsx --test lib/key-management/user-key-cache.test.ts lib/managed-user-keys.test.ts && pnpm --filter @toard/web typecheck`

Expected: tests PASS, TypeScript error 0.

- [ ] **Step 7: Task 3을 커밋한다**

```bash
git add apps/web/lib/key-management/user-key-cache.ts apps/web/lib/key-management/user-key-cache.test.ts apps/web/lib/managed-user-keys.ts apps/web/lib/managed-user-keys.test.ts
git commit -m "feat(security): 사용자 콘텐츠 키 cache와 repository 추가"
```

---

### Task 4: managed 레코드 암호 계약

**Files:**
- Create: `apps/web/lib/managed-content-crypto.ts`
- Create: `apps/web/lib/managed-content-crypto.test.ts`
- Create: `apps/web/lib/legacy-content-crypto.ts`
- Modify: `apps/web/lib/content-crypto.ts`
- Modify: `apps/web/lib/e2ee-legacy-migration.ts`
- Modify: `scripts/seed-dashboard-demo.ts`

**Interfaces:**
- Consumes UCK 32바이트와 `PromptRecordWire` metadata.
- Produces `encryptManagedContent(input, uck, installationId, keyVersion): ManagedEncryptedContent`.
- Produces `decryptManagedContent(row, uck, installationId): string`.
- Preserves `encryptContent`, `decryptContent`, `loadKek` legacy exports.

- [ ] **Step 1: managed AAD와 tamper 실패 테스트를 작성한다**

```ts
test("managed record는 metadata와 사용자에 결합되고 nonce가 분리된다", () => {
  const encrypted = encryptManagedContent(RECORD, UCK, INSTALLATION_ID, USER_ID, 1);
  assert.notDeepEqual(encrypted.iv, encrypted.dekWrapIv);
  assert.equal(
    decryptManagedContent({ ...RECORD, ...encrypted }, UCK, INSTALLATION_ID, USER_ID),
    RECORD.text,
  );
  assert.throws(
    () => decryptManagedContent(
      { ...RECORD, providerKey: "claude", ...encrypted },
      UCK,
      INSTALLATION_ID,
      USER_ID,
    ),
    /authenticate|CONTENT_DECRYPT_FAILED/,
  );
});
```

- [ ] **Step 2: 테스트가 모듈 부재로 실패하는지 확인한다**

Run: `pnpm --filter @toard/web exec node --import tsx --test lib/managed-content-crypto.test.ts`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: AAD v2와 레코드 암호화를 구현한다**

```ts
export function canonicalManagedContentAad(input: {
  installationId: string;
  userId: string;
  keyVersion: number;
  dedupKey: string;
  providerKey: string;
  turnRole: "user" | "assistant";
  ts: Date;
}): Buffer {
  return Buffer.from(JSON.stringify({
    schema: "managed_v1",
    installationId: input.installationId,
    userId: input.userId,
    dedupKey: input.dedupKey,
    providerKey: input.providerKey,
    turnRole: input.turnRole,
    ts: input.ts.toISOString(),
    contentKeyVersion: input.keyVersion,
  }), "utf8");
}
```

```ts
export function encryptManagedContent(
  record: PromptRecordWire,
  uck: Buffer,
  installationId: string,
  userId: string,
  keyVersion: number,
): ManagedEncryptedContent {
  const aad = canonicalManagedContentAad({ installationId, userId, keyVersion, ...record });
  const dek = randomBytes(32);
  const iv = randomBytes(12);
  const dekWrapIv = randomBytes(12);
  try {
    const body = encryptAesGcm(dek, iv, aad, Buffer.from(record.text, "utf8"));
    const wrapped = encryptAesGcm(uck, dekWrapIv, aad, dek);
    return {
      encryptionScheme: "managed_v1",
      contentKeyVersion: keyVersion,
      aadVersion: 2,
      wrappedDek: wrapped.ciphertext,
      dekWrapIv,
      dekWrapAuthTag: wrapped.authTag,
      iv,
      ciphertext: body.ciphertext,
      authTag: body.authTag,
    };
  } finally {
    dek.fill(0);
  }
}
```

`decryptManagedContent`는 같은 AAD로 DEK와 본문을 순서대로 복호화하고 DEK를 `finally`에서 zeroize한다. 오류는 원본 OpenSSL 메시지 대신 `CONTENT_DECRYPT_FAILED`로 변환한다.

- [ ] **Step 4: legacy 구현을 별도 파일로 이동하고 facade를 유지한다**

현재 `apps/web/lib/content-crypto.ts`의 `EncryptedContent`, `loadKek`, `encryptContent`, `decryptContent`를 내용 변경 없이 `legacy-content-crypto.ts`로 이동한다. `content-crypto.ts`는 아래 호환 export만 둔다.

```ts
export {
  contentCollectionDefaultOn,
  contentCollectionEnabled,
  decryptContent,
  encryptContent,
  loadKek,
  type EncryptedContent,
} from "./legacy-content-crypto";
export {
  canonicalManagedContentAad,
  decryptManagedContent,
  encryptManagedContent,
  type ManagedEncryptedContent,
} from "./managed-content-crypto";
```

- [ ] **Step 5: 기존 legacy 호출자가 그대로 동작하는지 검증한다**

Run: `pnpm --filter @toard/web exec node --import tsx --test lib/managed-content-crypto.test.ts lib/e2ee-legacy-migration.test.ts lib/prompt-history.test.ts && pnpm --filter @toard/web typecheck`

Expected: managed crypto와 기존 legacy tests PASS, TypeScript error 0.

- [ ] **Step 6: Task 4를 커밋한다**

```bash
git add apps/web/lib/managed-content-crypto.ts apps/web/lib/managed-content-crypto.test.ts apps/web/lib/legacy-content-crypto.ts apps/web/lib/content-crypto.ts apps/web/lib/e2ee-legacy-migration.ts scripts/seed-dashboard-demo.ts
git commit -m "feat(security): managed 레코드 암호 계약 추가"
```

---

## Plan 1 Completion Gate

Run:

```bash
pnpm --filter @toard/web test
pnpm --filter @toard/web typecheck
pnpm test:migrations
git diff --check HEAD~4
```

Expected:

- 모든 web tests PASS.
- TypeScript error 0.
- migration suite PASS.
- local secret file로 UCK wrap/unwrap 및 managed 레코드 round-trip PASS.
- 기존 `server_v1`·`e2ee_v1` tests에 회귀 없음.
