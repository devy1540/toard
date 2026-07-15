# E2EE Foundation, Collection, and History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 패스키 없이도 연결된 shim, Recovery Kit, 승인된 브라우저만으로 프롬프트 본문을 로컬 암호화·저장·조회할 수 있는 첫 E2EE 수직 슬라이스를 만든다.

**Architecture:** shim이 사용자 콘텐츠 키(UCK)와 레코드별 DEK를 생성하고 본문을 AES-256-GCM으로 암호화한 뒤 `e2ee_v1` payload만 서버에 전송한다. 서버는 암호문·래퍼·메타데이터만 저장하며, 브라우저는 비추출 P-256 기기 키와 HPKE wrapper를 이용해 UCK를 로컬에서 풀고 화면에 보이는 레코드만 복호화한다. 새 브라우저는 5분짜리 승인 요청을 만들고 연결된 shim이 확인 코드 검증 후 UCK를 HPKE로 감싸 전달한다.

**Tech Stack:** Rust 2021 shim, `aes-gcm 0.11`, `hkdf 0.13`, `hpke 0.14`, `bip39 2.2`, `keyring 4.1`, `zeroize 1.9`, Next.js 15, React 19, PostgreSQL 16, Web Crypto, IndexedDB, `@hpke/core 1.9`, `@scure/bip39 2.2`, Node test runner.

## Global Constraints

- `User Content Key(UCK)`는 사용자별 256비트 무작위 키이며 서버에 평문으로 전송하지 않는다.
- 각 레코드는 별도 256비트 DEK와 별도 12바이트 nonce로 AES-256-GCM 암호화한다.
- DEK 래핑 nonce와 본문 nonce는 서로 다른 값이어야 하며 각각 16바이트 인증 태그를 저장한다.
- AAD v1은 `schema`, `contentOwnerId`, `dedupKey`, `providerKey`, `turnRole`, `ts`를 고정 순서 JSON으로 직렬화한다.
- 기기 승인은 RFC 9180 HPKE의 DHKEM(P-256, HKDF-SHA256), HKDF-SHA256, AES-256-GCM 조합을 사용한다.
- 복구키는 256비트 recovery secret의 BIP-39 영어 24단어+checksum 표현이며, Recovery KEK는 계정별 공개 salt와 HKDF-SHA-256으로 만든다.
- Recovery Kit 저장과 임의 단어 확인이 성공하기 전에는 `collect_content=e2ee_v1`을 활성화하지 않는다.
- 브라우저 개인키는 `extractable:false`로 생성하고 IndexedDB에 `CryptoKey` 객체로 저장한다.
- `AUTH_MODE=open`과 개발용 첫 사용자 fallback에서는 E2EE 본문 API, 기기 승인, 복구를 모두 거부한다.
- 키, 복구 단어, PRF 출력, 평문, 전체 ciphertext를 서버 로그·shim 로그·telemetry·오류 응답에 기록하지 않는다.
- 기존 `server_v1` 읽기 경로와 `TOARD_CONTENT_KEK_B64`는 이 계획에서 제거하지 않으며 UI에서 `기존 서버 암호화`로 구분한다.
- 패스키 PRF, 레거시 `server_v1` 재암호화, UCK 회전, 관리자 집계는 별도 구현 계획으로 다룬다. 이 계획의 UI는 해당 기능을 제공한다고 표시하지 않는다.
- Node.js 최소 버전은 저장소 기준 `>=20`, Rust 최소 버전은 `keyring 4.1.4` 요구사항에 맞춰 `1.88`로 명시한다.

---

## File Structure

- `migrations/1700000030_e2ee_content_foundation.sql`: 콘텐츠 계정, 기기, UCK wrapper, 승인 요청, `prompt_records` E2EE 컬럼과 RLS.
- `scripts/e2ee-content-migration.integration.test.ts`: migration 30의 제약조건, RLS, 만료·일회 소비 동작 검증.
- `apps/web/lib/e2ee-contract.ts`: base64url wire 타입, AAD v1 정규화, payload 크기·알고리즘 검증.
- `apps/web/lib/e2ee-contract.test.ts`: 서버가 평문 필드를 거부하고 AAD를 결정론적으로 만드는 단위 테스트.
- `apps/web/lib/e2ee-test-fixtures.ts`: web 단위 테스트가 공유하는 유효 E2EE wire/device/wrapper fixture와 recording DB.
- `apps/web/lib/content-accounts.ts`: content account/device/wrapper/approval DB 연산의 단일 진입점.
- `apps/web/lib/content-session.ts`: 실제 Auth.js 세션만 허용하는 E2EE 사용자 게이트.
- `apps/web/lib/e2ee-browser-crypto.ts`: 브라우저 AES/HKDF/HPKE와 레코드 복호화 순수 함수.
- `apps/web/lib/content-key-vault.ts`: IndexedDB의 비추출 기기 키와 잠금 해제된 UCK 메모리 수명 관리.
- `apps/web/lib/e2ee-history.ts`: 서버 복호화 없이 E2EE 세션·턴의 메타데이터와 암호문 조회.
- `apps/web/app/api/v1/content/setup/route.ts`: ingest token으로 shim E2EE 계정 준비.
- `apps/web/app/api/v1/content/activate/route.ts`: Recovery Kit 확인 후 shim device/recovery wrapper 등록 및 활성화.
- `apps/web/app/api/v1/content/approval-requests/route.ts`: shim의 대기 승인 요청 조회.
- `apps/web/app/api/v1/content/approval-requests/[id]/approve/route.ts`: shim이 만든 HPKE envelope 전달.
- `apps/web/app/api/content/status/route.ts`: 로그인 브라우저의 E2EE 상태 조회.
- `apps/web/app/api/content/devices/approval-requests/route.ts`: 새 브라우저 승인 요청 생성.
- `apps/web/app/api/content/devices/approval-requests/[id]/route.ts`: 승인 상태 조회와 일회 envelope 소비.
- `apps/web/app/api/content/devices/[id]/wrapper/route.ts`: 승인된 기존 브라우저의 device wrapper 재조회.
- `apps/web/app/api/content/recovery/wrapper/route.ts`: 로그인 후 recovery wrapper와 공개 salt 조회.
- `apps/web/app/api/content/recovery/complete/route.ts`: 로컬 복구 성공 후 현재 브라우저 기기 등록.
- `apps/web/app/api/content/history/sessions/route.ts`: E2EE 세션 목록 암호문 페이지.
- `apps/web/app/api/content/history/sessions/[key]/route.ts`: E2EE 세션 상세 암호문 페이지.
- `apps/web/app/(dashboard)/history/e2ee-history-client.tsx`: 잠금 상태, 승인, 목록, 상세의 클라이언트 상태 머신.
- `apps/web/app/(dashboard)/history/locked-history.tsx`: 승인·복구 진입 화면.
- `shim/rust/src/content_crypto.rs`: 레코드 AES-GCM, UCK wrapper, AAD v1, HPKE helper.
- `shim/rust/src/content_keys.rs`: OS keyring의 UCK·기기 개인키 저장/조회/폐기.
- `shim/rust/src/recovery.rs`: 24단어 생성·checksum·Recovery KEK·wrapper.
- `shim/rust/src/e2ee_setup.rs`: setup API, loopback Recovery Kit, 확인 후 activate API.
- `shim/rust/src/e2ee_setup_page.html`: loopback 전용 Recovery Kit UI.
- `fixtures/e2ee-v1-golden.json`: Rust와 TypeScript가 함께 검증하는 고정 암호화 벡터.

---

### Task 1: E2EE 데이터 모델과 wire 계약

**Files:**
- Create: `migrations/1700000030_e2ee_content_foundation.sql`
- Create: `scripts/e2ee-content-migration.integration.test.ts`
- Create: `apps/web/lib/e2ee-contract.ts`
- Create: `apps/web/lib/e2ee-contract.test.ts`
- Create: `apps/web/lib/e2ee-test-fixtures.ts`
- Modify: `package.json:12-13`

**Interfaces:**
- Produces: `E2eePromptRecordWire`, `ContentKeyWrapperWire`, `DeviceEnvelopeWire`, `canonicalContentAad(input): Uint8Array`, `parseE2eePromptRecordsBody(value): E2eePromptRecordWire[]`.
- Produces DB tables: `content_accounts`, `content_devices`, `content_key_wrappers`, `content_device_approval_requests`.
- Produces `prompt_records.encryption_scheme`, `content_owner_id`, `content_key_version`, `dek_wrap_iv`, `dek_wrap_auth_tag`, `aad_version`.

- [ ] **Step 1: wire 계약의 실패 테스트를 작성한다**

```ts
test("e2ee wire rejects plaintext and non-canonical algorithms", () => {
  assert.throws(
    () => parseE2eePromptRecordsBody([{ ...VALID_E2EE_RECORD, text: "secret" }]),
    /허용되지 않은 필드: text/,
  );
  assert.throws(
    () => parseE2eePromptRecordsBody([{ ...VALID_E2EE_RECORD, algorithm: "AES-128-GCM" }]),
    /algorithm은 AES-256-GCM/,
  );
});

test("AAD v1 is deterministic and binds owner and metadata", () => {
  const aad = canonicalContentAad({
    schema: "e2ee_v1",
    contentOwnerId: "018f47d0-4d47-7b04-950b-7d18a86e1b43",
    dedupKey: "abc",
    providerKey: "codex",
    turnRole: "user",
    ts: "2026-07-14T00:00:00.000Z",
  });
  assert.equal(new TextDecoder().decode(aad),
    '{"schema":"e2ee_v1","contentOwnerId":"018f47d0-4d47-7b04-950b-7d18a86e1b43","dedupKey":"abc","providerKey":"codex","turnRole":"user","ts":"2026-07-14T00:00:00.000Z"}');
});
```

- [ ] **Step 2: 단위 테스트가 계약 모듈 부재로 실패하는지 확인한다**

Run: `pnpm --filter @toard/web test -- e2ee-contract.test.ts`

Expected: FAIL with `Cannot find module './e2ee-contract'`.

- [ ] **Step 3: 타입과 엄격한 parser를 구현한다**

```ts
export type ContentRole = "user" | "assistant";
export type E2eeAlgorithm = "AES-256-GCM";

export interface E2eePromptRecordWire {
  schema: "e2ee_v1";
  algorithm: E2eeAlgorithm;
  aadVersion: 1;
  contentOwnerId: string;
  contentKeyVersion: number;
  dedupKey: string;
  sessionId: string | null;
  providerKey: string;
  turnRole: ContentRole;
  ts: string;
  wrappedDek: string;
  dekWrapIv: string;
  dekWrapAuthTag: string;
  iv: string;
  ciphertext: string;
  authTag: string;
}

export interface ContentKeyWrapperWire {
  wrapperType: "device" | "recovery";
  wrapperRef: string;
  contentKeyVersion: number;
  kdfVersion: "hkdf-sha256-v1" | "hpke-p256-v1";
  publicSaltOrInput: string | null;
  nonce: string | null;
  authTag: string | null;
  encapsulatedKey: string | null;
  wrappedContentKey: string;
}

export interface DeviceEnvelopeWire {
  algorithm: "hpke-p256-hkdf-sha256-aes256gcm-v1";
  encapsulatedKey: string;
  ciphertext: string;
}

export function canonicalContentAad(input: {
  schema: "e2ee_v1";
  contentOwnerId: string;
  dedupKey: string;
  providerKey: string;
  turnRole: ContentRole;
  ts: string;
}): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    schema: input.schema,
    contentOwnerId: input.contentOwnerId,
    dedupKey: input.dedupKey,
    providerKey: input.providerKey,
    turnRole: input.turnRole,
    ts: new Date(input.ts).toISOString(),
  }));
}
```

`e2ee-test-fixtures.ts`는 `VALID_E2EE_RECORD`, `VALID_DEVICE`, `VALID_BROWSER`, `VALID_DEVICE_ENVELOPE`, `VALID_DEVICE_WRAPPER`, `VALID_RECOVERY_WRAPPER`, `VALID_ACTIVATION_INPUT`, `createRecordingDb()`를 export한다. 모든 bytes는 길이가 계약과 정확히 맞는 base64url 고정값이며 secret 표식은 `secret prompt` 하나로 통일해 평문 누출 assertion에 사용한다.

```ts
const b64 = (length: number): string => Buffer.alloc(length, 7).toString("base64url");

export const VALID_E2EE_RECORD: E2eePromptRecordWire = {
  schema: "e2ee_v1", algorithm: "AES-256-GCM", aadVersion: 1,
  contentOwnerId: "018f47d0-4d47-7b04-950b-7d18a86e1b43", contentKeyVersion: 1,
  dedupKey: "dedup-1", sessionId: "session-1", providerKey: "codex",
  turnRole: "user", ts: "2026-07-14T00:00:00.000Z",
  wrappedDek: b64(32), dekWrapIv: b64(12), dekWrapAuthTag: b64(16),
  iv: b64(12), ciphertext: b64(24), authTag: b64(16),
};

export const VALID_BROWSER = {
  kind: "browser" as const, label: "Chrome on Mac", platform: "macOS",
  publicKey: b64(65), algorithmVersion: "hpke-p256-v1" as const,
};
export const VALID_DEVICE = { ...VALID_BROWSER, kind: "shim" as const, label: "MacBook" };
export const VALID_DEVICE_ENVELOPE: DeviceEnvelopeWire = {
  algorithm: "hpke-p256-hkdf-sha256-aes256gcm-v1",
  encapsulatedKey: b64(65), ciphertext: b64(48),
};
export const VALID_DEVICE_WRAPPER: ContentKeyWrapperWire = {
  wrapperType: "device", wrapperRef: "device-1", contentKeyVersion: 1,
  kdfVersion: "hpke-p256-v1", publicSaltOrInput: null, nonce: null, authTag: null,
  encapsulatedKey: VALID_DEVICE_ENVELOPE.encapsulatedKey,
  wrappedContentKey: VALID_DEVICE_ENVELOPE.ciphertext,
};
export const VALID_RECOVERY_WRAPPER: ContentKeyWrapperWire = {
  wrapperType: "recovery", wrapperRef: "account", contentKeyVersion: 1,
  kdfVersion: "hkdf-sha256-v1", publicSaltOrInput: b64(32), nonce: b64(12),
  authTag: b64(16), encapsulatedKey: null, wrappedContentKey: b64(32),
};
export const VALID_ACTIVATION_INPUT = {
  recoveryConfirmed: true, device: VALID_DEVICE,
  wrappers: [VALID_RECOVERY_WRAPPER, VALID_DEVICE_WRAPPER],
};

export function createRecordingDb(options: { ownerUserId?: string } = {}) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  return {
    calls,
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      if (/SELECT[\s\S]+content_accounts/i.test(sql)) {
        return { rows: [{ user_id: options.ownerUserId ?? "user-1" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
  };
}
```

Parser는 정확히 위 키만 허용하고 base64url 디코딩 후 `wrappedDek=32B`, `dekWrapIv=12B`, `dekWrapAuthTag=16B`, `iv=12B`, `authTag=16B`, `ciphertext=1..1_048_576B`를 검사한다. 배치 최대 레코드는 1,000개로 제한한다.

- [ ] **Step 4: migration과 RLS 정책을 작성한다**

```sql
CREATE TABLE content_accounts (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  content_owner_id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','active')),
  active_key_version SMALLINT NOT NULL DEFAULT 1 CHECK (active_key_version > 0),
  recovery_salt BYTEA NOT NULL DEFAULT gen_random_bytes(32),
  recovery_confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE prompt_records
  ADD COLUMN encryption_scheme TEXT NOT NULL DEFAULT 'server_v1'
    CHECK (encryption_scheme IN ('server_v1','e2ee_v1')),
  ADD COLUMN content_owner_id UUID REFERENCES content_accounts(content_owner_id),
  ADD COLUMN content_key_version SMALLINT,
  ADD COLUMN dek_wrap_iv BYTEA,
  ADD COLUMN dek_wrap_auth_tag BYTEA,
  ADD COLUMN aad_version SMALLINT;

ALTER TABLE prompt_records ADD CONSTRAINT prompt_records_e2ee_shape CHECK (
  encryption_scheme = 'server_v1' OR
  (content_owner_id IS NOT NULL AND content_key_version > 0 AND
   octet_length(dek_wrap_iv) = 12 AND octet_length(dek_wrap_auth_tag) = 16 AND aad_version = 1)
);
```

`content_devices`, `content_key_wrappers`, `content_device_approval_requests`에는 모두 `user_id`, 생성·최근 사용·폐기 시각을 두고 `app.current_user_id`와 일치하는 SELECT/INSERT/UPDATE 정책을 적용한다. `content_devices`는 `approved_at`이 NULL인 pending browser와 승인된 device를 구분한다. 승인 요청은 `expires_at`, `approved_at`, `consumed_at`, `confirmation_code_hash`, `encrypted_envelope`, `encapsulated_key`를 갖고 활성 요청 인덱스를 둔다.

- [ ] **Step 5: migration 통합 테스트를 추가한다**

테스트는 Postgres 16 임시 컨테이너에서 migration 1, 10, 28을 적용한 뒤 다음을 실제 SQL로 확인한다.

```ts
assert.equal(columns.rows.find((r) => r.column_name === "encryption_scheme")?.column_default, "'server_v1'::text");
await assert.rejects(
  client.query(`INSERT INTO prompt_records
    (dedup_key,user_id,provider_key,turn_role,ts,key_version,wrapped_dek,iv,ciphertext,auth_tag,
     encryption_scheme,content_owner_id,content_key_version,aad_version)
    VALUES ($1,$2,'codex','user',now(),1,'x','123456789012','x','1234567890123456',
            'e2ee_v1',$3,1,1)`, ["broken", userId, ownerId]),
  /prompt_records_e2ee_shape/,
);
```

- [ ] **Step 6: migration과 계약 테스트를 통과시킨다**

Run: `pnpm --filter @toard/web test && node --import tsx --test scripts/e2ee-content-migration.integration.test.ts`

Expected: all web tests PASS, migration test PASS, temporary container removed in `finally`.

- [ ] **Step 7: 변경을 커밋한다**

```bash
git add migrations/1700000030_e2ee_content_foundation.sql scripts/e2ee-content-migration.integration.test.ts apps/web/lib/e2ee-contract.ts apps/web/lib/e2ee-contract.test.ts apps/web/lib/e2ee-test-fixtures.ts package.json
git commit -m "feat(security): E2EE 콘텐츠 데이터 모델 추가"
```

---

### Task 2: shim 암호화 코어와 OS 보안 저장소

**Files:**
- Modify: `shim/rust/Cargo.toml:14-18`
- Modify: `shim/rust/src/main.rs:9-20`
- Create: `shim/rust/src/content_crypto.rs`
- Create: `shim/rust/src/content_keys.rs`
- Create: `shim/rust/src/recovery.rs`
- Create: `fixtures/e2ee-v1-golden.json`

**Interfaces:**
- Consumes: Task 1의 AAD v1과 wire 길이 계약.
- Produces: `encrypt_record(uck, metadata, plaintext) -> EncryptedPromptRecord`, `wrap_for_device(public_key, uck) -> DeviceEnvelope`, `RecoveryMaterial::generate`, `ContentKeyStore` trait.

- [ ] **Step 1: AES-GCM과 recovery 실패 테스트를 작성한다**

```rust
#[test]
fn record_round_trip_and_aad_tamper_failure() {
    let uck = [7u8; 32];
    let meta = test_metadata();
    let encrypted = encrypt_record(&uck, &meta, b"secret prompt").unwrap();
    assert_ne!(encrypted.iv, encrypted.dek_wrap_iv);
    assert_eq!(decrypt_record(&uck, &meta, &encrypted).unwrap(), b"secret prompt");
    let mut tampered = meta.clone();
    tampered.provider_key = "claude".into();
    assert!(decrypt_record(&uck, &tampered, &encrypted).is_err());
}

fn test_metadata() -> ContentMetadata {
    ContentMetadata {
        schema: "e2ee_v1".into(),
        content_owner_id: "018f47d0-4d47-7b04-950b-7d18a86e1b43".into(),
        dedup_key: "abc".into(),
        provider_key: "codex".into(),
        turn_role: "user".into(),
        ts: "2026-07-14T00:00:00.000Z".into(),
    }
}

#[test]
fn recovery_is_24_words_and_bad_checksum_is_rejected() {
    let recovery = RecoveryMaterial::generate().unwrap();
    assert_eq!(recovery.mnemonic.split_whitespace().count(), 24);
    assert!(RecoveryMaterial::from_mnemonic("abandon abandon").is_err());
}
```

- [ ] **Step 2: Rust 테스트가 모듈 부재로 실패하는지 확인한다**

Run: `cargo test --manifest-path shim/rust/Cargo.toml content_crypto recovery`

Expected: FAIL with unresolved module or function errors.

- [ ] **Step 3: 암호 의존성과 고정 알고리즘 타입을 추가한다**

```toml
aes-gcm = "0.11.0"
bip39 = { version = "2.2.2", features = ["rand"] }
hkdf = "0.13.0"
hpke = { version = "0.14.0", default-features = false, features = ["alloc", "getrandom", "aes", "nistp"] }
keyring = "4.1.4"
rand = "0.10.2"
zeroize = { version = "1.9.0", features = ["derive"] }
```

```rust
type HpkeKem = hpke::kem::DhP256HkdfSha256;
type HpkeKdf = hpke::kdf::HkdfSha256;
type HpkeAead = hpke::aead::AesGcm256;
pub const UCK_BYTES: usize = 32;
pub const NONCE_BYTES: usize = 12;
```

- [ ] **Step 4: 레코드 암호화와 AAD v1을 구현한다**

`EncryptedPromptRecord`는 `wrapped_dek`, `dek_wrap_iv`, `dek_wrap_auth_tag`, `iv`, `ciphertext`, `auth_tag`를 분리해 보유한다. `aes_gcm::Aes256Gcm`의 detached tag API를 사용하고, 모든 키 배열은 `Zeroizing<[u8; 32]>`로 감싼다. 오류 타입은 `ContentCryptoError::{InvalidKey,Encrypt,Decrypt,InvalidMetadata}`만 외부에 노출한다.

- [ ] **Step 5: keyring 저장소와 메모리 대체 구현을 만든다**

```rust
pub trait ContentKeyStore {
    fn put_uck(&self, owner_id: &str, version: u16, key: &[u8; 32]) -> Result<(), KeyStoreError>;
    fn get_uck(&self, owner_id: &str, version: u16) -> Result<Zeroizing<[u8; 32]>, KeyStoreError>;
    fn put_device_private_key(&self, device_id: &str, key: &[u8]) -> Result<(), KeyStoreError>;
    fn get_device_private_key(&self, device_id: &str) -> Result<Zeroizing<Vec<u8>>, KeyStoreError>;
}
```

운영 구현은 service `toard`, account `content:<owner>:uck:<version>`와 `content-device:<id>`를 사용한다. 단위 테스트는 `MemoryContentKeyStore`를 주입해 실제 OS keyring을 건드리지 않는다. keyring이 불가능한 Linux headless 환경에서는 setup을 실패시키고 평문 파일 fallback을 만들지 않는다.

- [ ] **Step 6: Rust/TypeScript 공유 golden vector를 고정한다**

fixture에는 고정 UCK, DEK, nonce 두 개, metadata, plaintext, 예상 AAD, ciphertext/tag/wrapped DEK/tag를 base64url로 넣는다. 테스트 전용 `encrypt_record_with_material`만 고정 nonce를 받고 운영 `encrypt_record`는 OS CSPRNG만 사용한다.

- [ ] **Step 7: shim 테스트를 통과시킨다**

Run: `cargo test --manifest-path shim/rust/Cargo.toml`

Expected: all shim tests PASS, AAD tamper and wrong UCK tests return authentication failure.

- [ ] **Step 8: 변경을 커밋한다**

```bash
git add shim/rust/Cargo.toml shim/rust/Cargo.lock shim/rust/src/main.rs shim/rust/src/content_crypto.rs shim/rust/src/content_keys.rs shim/rust/src/recovery.rs fixtures/e2ee-v1-golden.json
git commit -m "feat(shim): E2EE 암호화 코어와 키 저장소 추가"
```

---

### Task 3: 콘텐츠 계정 준비와 Recovery Kit 활성화

**Files:**
- Create: `apps/web/lib/content-accounts.ts`
- Create: `apps/web/lib/content-accounts.test.ts`
- Create: `apps/web/app/api/v1/content/setup/route.ts`
- Create: `apps/web/app/api/v1/content/activate/route.ts`
- Create: `shim/rust/src/e2ee_setup.rs`
- Create: `shim/rust/src/e2ee_setup_page.html`
- Modify: `shim/rust/src/cli.rs:22-73`
- Modify: `shim/rust/src/credentials.rs:5-86`

**Interfaces:**
- Consumes: Task 1 DB/wire, Task 2 `RecoveryMaterial`, `ContentKeyStore`, HPKE helper.
- Produces: `prepareContentAccount(userId)`, `activateContentAccount(userId, input)`, CLI `toard-shim e2ee setup`, `ContentCollectionMode`.

- [ ] **Step 1: 상태 전이와 민감 필드 거부 테스트를 작성한다**

```ts
test("activation requires recovery confirmation and two wrappers", async () => {
  await assert.rejects(
    activateContentAccount("user-1", {
      recoveryConfirmed: false,
      device: VALID_DEVICE,
      wrappers: [VALID_RECOVERY_WRAPPER, VALID_DEVICE_WRAPPER],
    }),
    /RECOVERY_CONFIRMATION_REQUIRED/,
  );
});

test("activation input rejects mnemonic, uck, and recoverySecret", () => {
  for (const field of ["mnemonic", "uck", "recoverySecret"]) {
    assert.throws(() => parseActivationInput({ ...VALID_ACTIVATION_INPUT, [field]: "secret" }), /허용되지 않은 필드/);
  }
});
```

- [ ] **Step 2: 테스트가 구현 부재로 실패하는지 확인한다**

Run: `pnpm --filter @toard/web test -- content-accounts.test.ts`

Expected: FAIL with missing exports.

- [ ] **Step 3: prepare/activate DB 트랜잭션을 구현한다**

`prepareContentAccount`는 사용자당 한 행을 멱등 생성하고 `{contentOwnerId,recoverySalt,activeKeyVersion,state}`를 반환한다. `activateContentAccount`는 device와 device/recovery wrapper를 같은 트랜잭션에 저장하고 `recovery_confirmed_at`을 기록한 뒤에만 `state='active'`로 바꾼다. wrapper 원문 필드 길이를 재검증하고 활성 recovery wrapper가 계정·키 버전당 하나만 존재하도록 부분 UNIQUE 인덱스를 사용한다.

- [ ] **Step 4: ingest-token setup/activate route를 구현한다**

```ts
const auth = await authenticateIngestToken(req.headers.get("authorization"));
if (!auth) return problem(401, "UNAUTHORIZED");
const prepared = await prepareContentAccount(auth.userId);
return Response.json(prepared, { status: prepared.state === "pending" ? 201 : 200 });
```

두 route 모두 `Cache-Control: no-store`를 설정한다. activate 오류는 코드만 반환하며 입력 객체나 wrapper bytes를 로그로 남기지 않는다.

- [ ] **Step 5: credentials의 bool을 명시적 모드로 바꾼다**

```rust
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ContentCollectionMode { Off, ServerV1, E2eeV1 }

impl ContentCollectionMode {
    fn parse(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "e2ee_v1" => Self::E2eeV1,
            "1" | "true" | "on" | "yes" | "server_v1" => Self::ServerV1,
            _ => Self::Off,
        }
    }
}
```

기존 `collect_content=true`는 호환을 위해 `ServerV1`로 해석한다. 새 E2EE setup이 성공할 때만 credentials를 원자적으로 `collect_content=e2ee_v1`, `content_owner_id`, `content_key_version`, `content_device_id`로 갱신한다.

- [ ] **Step 6: loopback Recovery Kit flow를 구현한다**

`toard-shim e2ee setup`은 다음 순서만 수행한다.

1. setup API에서 owner/salt/version을 받는다.
2. UCK, P-256 HPKE 기기 키, 24단어 recovery material을 로컬 생성한다.
3. `127.0.0.1:0`에 bind하고 32바이트 일회 capability를 URL fragment가 아닌 path segment로 포함한 `/recovery/<capability>`만 허용한다.
4. `Cache-Control: no-store`, `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-…'`, `Referrer-Policy: no-referrer`를 보낸다.
5. 저장 버튼은 로컬에서 Recovery Kit 파일을 만들고, 확인 폼은 서버가 고른 3개 단어 위치를 맞혀야 통과한다.
6. 확인 성공 후 device/recovery wrapper만 activate API로 보내고 keyring 저장과 credentials 갱신을 완료한다.
7. capability는 성공 또는 10분 경과 시 폐기하고 listener를 종료한다.

- [ ] **Step 7: 설정 중단 안전성을 테스트한다**

Run: `cargo test --manifest-path shim/rust/Cargo.toml e2ee_setup credentials`

Expected: 잘못된 capability, 3회 단어 불일치, 만료, activate API 실패에서 `collect_content`가 `Off` 또는 기존 값으로 유지되고 mnemonic이 captured output에 포함되지 않음.

- [ ] **Step 8: web과 shim 테스트를 통과시킨다**

Run: `pnpm --filter @toard/web test && cargo test --manifest-path shim/rust/Cargo.toml`

Expected: all tests PASS.

- [ ] **Step 9: 변경을 커밋한다**

```bash
git add apps/web/lib/content-accounts.ts apps/web/lib/content-accounts.test.ts apps/web/app/api/v1/content/setup/route.ts apps/web/app/api/v1/content/activate/route.ts shim/rust/src/e2ee_setup.rs shim/rust/src/e2ee_setup_page.html shim/rust/src/cli.rs shim/rust/src/credentials.rs
git commit -m "feat(security): Recovery Kit 기반 E2EE 활성화 추가"
```

---

### Task 4: ciphertext-only 수집 경로

**Files:**
- Modify: `shim/rust/src/collect/mod.rs:260-335,721-832,994-1011`
- Modify: `shim/rust/src/collect/post.rs:102-113`
- Modify: `shim/rust/src/cli.rs:48-58`
- Modify: `apps/web/lib/prompt-wire.ts:1-73`
- Modify: `apps/web/lib/prompt-records.ts:1-43`
- Modify: `apps/web/app/api/v1/prompts/route.ts:1-52`
- Create: `apps/web/lib/prompt-records.test.ts`

**Interfaces:**
- Consumes: Task 1 `parseE2eePromptRecordsBody`, Task 2 `encrypt_record`, Task 3 active content account.
- Produces: `/api/v1/prompts` dual parser with `server_v1` and `e2ee_v1`; new shim installs only emit `e2ee_v1`.

- [ ] **Step 1: server 무복호화 저장 테스트를 작성한다**

```ts
test("e2ee records are inserted byte-for-byte without loadKek", async () => {
  const fakeTx = createRecordingDb();
  const result = await saveE2eePromptRecords("user-1", [VALID_E2EE_RECORD], fakeTx);
  assert.equal(result.inserted, 1);
  assert.equal(fakeTx.calls[0]?.params.includes("secret prompt"), false);
  assert.deepEqual(fakeTx.calls[0]?.params.at(-3), fromBase64Url(VALID_E2EE_RECORD.ciphertext));
});

test("owner id must belong to ingest token user", async () => {
  const fakeTx = createRecordingDb({ ownerUserId: "user-a" });
  await assert.rejects(saveE2eePromptRecords("user-b", [VALID_E2EE_RECORD], fakeTx), /CONTENT_OWNER_MISMATCH/);
});
```

- [ ] **Step 2: 테스트가 새 저장 함수 부재로 실패하는지 확인한다**

Run: `pnpm --filter @toard/web test -- prompt-records.test.ts`

Expected: FAIL with `saveE2eePromptRecords is not exported`.

- [ ] **Step 3: shim wire 생성을 암호문으로 교체한다**

```rust
fn to_e2ee_prompts_body(
    adapter: &str,
    owner_id: &str,
    key_version: u16,
    uck: &[u8; 32],
    records: &[RawContent],
) -> Result<String, ContentCryptoError> {
    records.iter().map(|r| {
        let meta = ContentMetadata::from_raw(adapter, owner_id, r);
        encrypt_record(uck, &meta, r.text.as_bytes()).map(|enc| enc.to_wire(&meta, key_version))
    }).collect::<Result<Vec<_>, _>>().map(|rows| serde_json::to_string(&rows).unwrap())
}
```

`E2eeV1` 모드에서 UCK/key metadata를 로드하지 못하면 전송과 content cursor 갱신을 모두 중단한다. dry-run은 본문이나 ciphertext를 출력하지 않고 레코드 수와 `e2ee_v1`만 표시한다.

- [ ] **Step 4: API를 schema dispatch로 바꾼다**

첫 레코드의 `schema`로 배치를 구분하고 혼합 배치를 400으로 거부한다. `e2ee_v1`에서는 `loadKek`와 `encryptContent`를 호출하지 않고 owner/user 매칭, provider, timestamp, 길이만 검증해 bytes를 저장한다. 기존 평문 wire는 `server_v1` 호환 경로에서만 허용한다.

- [ ] **Step 5: 로그·오류 평문 부재를 테스트한다**

Run: `pnpm --filter @toard/web test && cargo test --manifest-path shim/rust/Cargo.toml collect`

Expected: tests PASS; fixture plaintext가 route response, captured stderr/stdout, SQL string에 나타나지 않음.

- [ ] **Step 6: 변경을 커밋한다**

```bash
git add shim/rust/src/collect/mod.rs shim/rust/src/collect/post.rs shim/rust/src/cli.rs apps/web/lib/prompt-wire.ts apps/web/lib/prompt-records.ts apps/web/lib/prompt-records.test.ts apps/web/app/api/v1/prompts/route.ts
git commit -m "feat(ingest): E2EE 암호문 수집 경로 추가"
```

---

### Task 5: 브라우저 키 vault와 ciphertext history API

**Files:**
- Modify: `apps/web/package.json:11-31`
- Create: `apps/web/lib/content-session.ts`
- Create: `apps/web/lib/content-session.test.ts`
- Create: `apps/web/lib/e2ee-browser-crypto.ts`
- Create: `apps/web/lib/e2ee-browser-crypto.test.ts`
- Create: `apps/web/lib/content-key-vault.ts`
- Create: `apps/web/lib/e2ee-history.ts`
- Create: `apps/web/lib/e2ee-history.test.ts`
- Create: `apps/web/app/api/content/status/route.ts`
- Create: `apps/web/app/api/content/history/sessions/route.ts`
- Create: `apps/web/app/api/content/history/sessions/[key]/route.ts`

**Interfaces:**
- Consumes: Task 1 wire/AAD, Task 2 golden fixture, Task 3 content account.
- Produces: `requireContentSession()`, `generateBrowserDeviceKey()`, `decryptE2eeRecord()`, `contentKeyVault`, `getE2eeHistorySessions`, `getE2eeHistorySession`.

- [ ] **Step 1: 실세션 게이트 테스트를 작성한다**

```ts
test("content session rejects open mode and dev fallback", async () => {
  assert.equal(await requireContentSessionWith({ authMode: "open", sessionUserId: null }), null);
  assert.equal(await requireContentSessionWith({ authMode: "oauth", sessionUserId: null }), null);
  assert.equal(await requireContentSessionWith({ authMode: "oauth", sessionUserId: "u1" }), "u1");
});
```

- [ ] **Step 2: browser crypto golden test를 작성한다**

```ts
test("browser decrypts the Rust e2ee_v1 golden vector", async () => {
  const vector = JSON.parse(await readFile("../../fixtures/e2ee-v1-golden.json", "utf8"));
  assert.equal(await decryptE2eeRecord(fromBase64Url(vector.uck), vector.record), vector.plaintext);
});

test("metadata tamper fails closed", async () => {
  const vector = JSON.parse(await readFile("../../fixtures/e2ee-v1-golden.json", "utf8"));
  await assert.rejects(
    decryptE2eeRecord(fromBase64Url(vector.uck), { ...vector.record, providerKey: "claude" }),
    /CONTENT_UNAVAILABLE/,
  );
});
```

- [ ] **Step 3: 테스트가 구현 부재로 실패하는지 확인한다**

Run: `pnpm --filter @toard/web test -- content-session.test.ts e2ee-browser-crypto.test.ts`

Expected: FAIL with missing modules.

- [ ] **Step 4: HPKE/WebCrypto와 IndexedDB vault를 구현한다**

`apps/web/package.json` dependencies에 아래 버전을 고정하고 `pnpm install`로 lockfile을 갱신한다.

```json
"@hpke/core": "1.9.0",
"@scure/bip39": "2.2.0"
```

```ts
export async function generateBrowserDeviceKey(): Promise<CryptoKeyPair> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  ) as CryptoKeyPair;
  if (pair.privateKey.extractable) throw new Error("DEVICE_KEY_EXTRACTABLE");
  return pair;
}
```

`@hpke/core@1.9.0`의 `CipherSuite({kem:new DhkemP256HkdfSha256(),kdf:new HkdfSha256(),aead:new Aes256Gcm()})`를 사용한다. vault는 DB `toard-content-v1`, store `devices`에 `CryptoKeyPair`와 server device id를 저장하고, UCK는 IndexedDB에 저장하지 않고 모듈 메모리의 `ZeroizableUck`에만 유지한다. `lock()`은 배열을 0으로 덮고 참조를 제거한다.

- [ ] **Step 5: 서버 복호화 없는 history 쿼리를 구현한다**

목록 query는 그룹별 첫 user 턴의 암호문과 메타데이터, turn count, first/latest timestamp만 반환한다. 상세 query는 최대 500턴의 E2EE bytes를 base64url로 반환한다. `server_v1` 레코드는 이 API에서 제외하고 기존 SSR 경로가 담당한다.

- [ ] **Step 6: status와 history API를 구현한다**

모든 route는 `requireContentSession()` 실패 시 401, `AUTH_MODE=open`이면 403 `E2EE_AUTH_REQUIRED`, `Cache-Control:no-store`를 반환한다. status는 키나 wrapper bytes 없이 `{state,keyVersion,approvedDeviceCount,recoveryConfirmedAt}`만 반환한다.

- [ ] **Step 7: 테스트와 typecheck를 통과시킨다**

Run: `pnpm --filter @toard/web test && pnpm --filter @toard/web typecheck`

Expected: all tests PASS and TypeScript reports no errors.

- [ ] **Step 8: 변경을 커밋한다**

```bash
git add apps/web/package.json pnpm-lock.yaml apps/web/lib/content-session.ts apps/web/lib/content-session.test.ts apps/web/lib/e2ee-browser-crypto.ts apps/web/lib/e2ee-browser-crypto.test.ts apps/web/lib/content-key-vault.ts apps/web/lib/e2ee-history.ts apps/web/lib/e2ee-history.test.ts apps/web/app/api/content/status/route.ts apps/web/app/api/content/history/sessions/route.ts apps/web/app/api/content/history/sessions/'[key]'/route.ts
git commit -m "feat(web): 브라우저 E2EE 복호화 기반 추가"
```

---

### Task 6: 연결된 shim의 새 브라우저 승인

**Files:**
- Modify: `apps/web/lib/content-accounts.ts`
- Modify: `apps/web/lib/content-accounts.test.ts`
- Create: `apps/web/app/api/content/devices/approval-requests/route.ts`
- Create: `apps/web/app/api/content/devices/approval-requests/[id]/route.ts`
- Create: `apps/web/app/api/content/devices/[id]/wrapper/route.ts`
- Create: `apps/web/app/api/content/recovery/wrapper/route.ts`
- Create: `apps/web/app/api/content/recovery/complete/route.ts`
- Create: `apps/web/app/api/v1/content/approval-requests/route.ts`
- Create: `apps/web/app/api/v1/content/approval-requests/[id]/approve/route.ts`
- Modify: `shim/rust/src/e2ee_setup.rs`
- Modify: `shim/rust/src/cli.rs`

**Interfaces:**
- Consumes: Task 2 HPKE, Task 3 key store, Task 5 browser device key.
- Produces: `createApprovalRequest`, `listPendingApprovalRequests`, `approveRequest`, `consumeApprovedEnvelope`, `getDeviceWrapper`, `getRecoveryWrapper`, `registerRecoveredBrowser`, CLI `toard-shim e2ee approve`.

- [ ] **Step 1: 만료·코드·일회 소비 테스트를 작성한다**

```ts
test("approval expires after five minutes", async () => {
  const NOW = new Date("2026-07-14T00:00:00.000Z");
  const req = await createApprovalRequest("u1", VALID_BROWSER, NOW);
  assert.equal(req.expiresAt.toISOString(), new Date(NOW.getTime() + 300_000).toISOString());
  await assert.rejects(approveRequest("u1", req.id, req.code, VALID_DEVICE_ENVELOPE, new Date(NOW.getTime() + 300_001)), /DEVICE_APPROVAL_EXPIRED/);
});

test("approved envelope is consumed once", async () => {
  const now = new Date("2026-07-14T00:00:00.000Z");
  const req = await createApprovalRequest("u1", VALID_BROWSER, now);
  await approveRequest("u1", req.id, req.code, VALID_DEVICE_ENVELOPE, now);
  assert.deepEqual(await consumeApprovedEnvelope("u1", req.id, now), VALID_DEVICE_ENVELOPE);
  await assert.rejects(consumeApprovedEnvelope("u1", req.id, now), /DEVICE_APPROVAL_CONSUMED/);
});

test("recovery registers a browser without sending the recovery secret", async () => {
  const fakeDb = createRecordingDb();
  const result = await registerRecoveredBrowser("u1", {
    device: VALID_BROWSER,
    deviceWrapper: VALID_DEVICE_WRAPPER,
  });
  assert.equal(result.approved, true);
  assert.equal(JSON.stringify(fakeDb.calls).includes("abandon"), false);
});
```

- [ ] **Step 2: 테스트가 승인 함수 부재로 실패하는지 확인한다**

Run: `pnpm --filter @toard/web test -- content-accounts.test.ts`

Expected: FAIL with missing approval exports.

- [ ] **Step 3: 확인 코드 hash와 원자적 상태 전이를 구현한다**

확인 코드는 CSPRNG 6자리 숫자이며 DB에는 `sha256(request_id || ':' || code)`만 저장한다. approve는 `FOR UPDATE`, 미만료, 미승인, 미소비, user 일치를 한 트랜잭션에서 확인한다. consume은 envelope를 반환하면서 `consumed_at=now()`를 같은 UPDATE에서 기록한다.

- [ ] **Step 4: browser와 shim route를 구현한다**

browser route는 비추출 P-256 public key의 raw uncompressed point(65B), label 1..80자, platform 1..40자만 받는다. shim route는 ingest token의 user와 device ownership을 검증한다. 승인 응답에 위치는 넣지 않고 요청 시각, label, platform, confirmation code만 표시한다.

승인 완료 트랜잭션은 pending browser의 `approved_at`을 기록하고 `content_key_wrappers(wrapper_type='device')`를 생성한다. 이후 같은 브라우저는 `/api/content/devices/[id]/wrapper`에서 현재 키 버전의 wrapper를 다시 받아 IndexedDB private key로 UCK를 풀 수 있다. route는 다른 user, pending/revoked device, 이전 키 버전을 모두 거부한다.

- [ ] **Step 5: shim 승인 명령을 구현한다**

`toard-shim e2ee approve`는 pending 목록을 가져와 각 요청의 label/platform/code를 출력하고 사용자가 로컬에서 동일 코드를 확인한 뒤 승인한다. `--request <uuid>`는 허용하지만 코드는 명령 인자로 받지 않는다. UCK는 keyring에서 읽고 요청 public key에 HPKE seal한 envelope만 전송한다.

- [ ] **Step 6: Recovery Kit 브라우저 복구를 구현한다**

`/api/content/recovery/wrapper`는 실세션 사용자에게 현재 키 버전의 공개 salt, nonce, auth tag, wrapped UCK만 반환한다. 브라우저는 `@scure/bip39@2.2.0`으로 24단어 checksum을 검증하고 entropy 32바이트와 공개 salt로 HKDF-SHA-256 Recovery KEK를 만든 뒤 AES-256-GCM으로 UCK를 해제한다. mnemonic, entropy, Recovery KEK는 어떤 HTTP payload에도 포함하지 않는다.

복호화 성공 후 브라우저는 자신의 비추출 P-256 public key에 UCK를 HPKE seal하고 `/api/content/recovery/complete`에 device metadata와 device wrapper만 보낸다. 서버는 해당 브라우저를 즉시 approved로 등록하고 현재 키 버전 wrapper를 저장한다. UI는 `복구 완료 후 새 Recovery Kit 발급을 권장합니다`를 표시하되 재발급 버튼은 rotation 계획 전에는 제공하지 않는다.

- [ ] **Step 7: 승인·복구 통합 테스트를 통과시킨다**

Run: `pnpm --filter @toard/web test && cargo test --manifest-path shim/rust/Cargo.toml e2ee_setup`

Expected: wrong code, expired, other user, replay all fail; valid request returns envelope exactly once; recovery request/DB/log에 mnemonic과 recovery secret이 없음.

- [ ] **Step 8: 변경을 커밋한다**

```bash
git add apps/web/lib/content-accounts.ts apps/web/lib/content-accounts.test.ts apps/web/app/api/content/devices apps/web/app/api/content/recovery apps/web/app/api/v1/content/approval-requests shim/rust/src/e2ee_setup.rs shim/rust/src/cli.rs
git commit -m "feat(security): 연결 기기 기반 브라우저 승인 추가"
```

---

### Task 7: 잠긴/잠금 해제된 E2EE 히스토리 UI

**Files:**
- Create: `apps/web/app/(dashboard)/history/e2ee-history-client.tsx`
- Create: `apps/web/app/(dashboard)/history/locked-history.tsx`
- Create: `apps/web/app/(dashboard)/history/e2ee-history-state.ts`
- Create: `apps/web/app/(dashboard)/history/e2ee-history-state.test.ts`
- Modify: `apps/web/app/(dashboard)/history/page.tsx:77-341`
- Modify: `apps/web/app/(dashboard)/history/session-detail.tsx:22-249`
- Modify: `apps/web/components/dashboard/overview-view.tsx:147-165,411-452`
- Modify: `apps/web/messages/ko/dashboard.json`
- Modify: `apps/web/messages/en/dashboard.json`

**Interfaces:**
- Consumes: Task 5 vault/history API, Task 6 approval API.
- Produces: reducer states `loading | locked | approvalPending | unlocked | recordUnavailable | fatal`.

- [ ] **Step 1: UI 상태 머신 테스트를 작성한다**

```ts
test("PRF가 없어도 연결 기기 승인으로 unlock된다", () => {
  let state = reduce(initialState, { type: "status", hasLocalKey: false, hasPasskeyWrapper: false });
  assert.equal(state.kind, "locked");
  state = reduce(state, { type: "approval-created", requestId: "r1", code: "381204" });
  assert.equal(state.kind, "approvalPending");
  state = reduce(state, { type: "uck-unwrapped" });
  assert.equal(state.kind, "unlocked");
});

test("한 레코드 인증 실패는 페이지 전체를 막지 않는다", () => {
  const unlockedState = reduce(initialState, { type: "uck-unwrapped" });
  const state = reduce(unlockedState, { type: "record-failed", dedupKey: "bad" });
  assert.deepEqual(state.unavailable, new Set(["bad"]));
  assert.equal(state.kind, "unlocked");
});
```

- [ ] **Step 2: 상태 테스트가 reducer 부재로 실패하는지 확인한다**

Run: `pnpm --filter @toard/web test -- e2ee-history-state.test.ts`

Expected: FAIL with missing module.

- [ ] **Step 3: 잠긴 화면과 승인 polling을 구현한다**

화면의 기본 강조 버튼은 `연결된 컴퓨터로 승인`이다. 요청 생성 후 확인 코드와 5분 countdown을 표시하고 2초 간격으로 상태를 poll한다. 복구키 버튼은 Task 6의 recovery wrapper를 받아 24단어를 브라우저 로컬에서 검증·복호화하는 비상 패널을 연다. 패스키 버튼은 이 계획에서 렌더링하지 않는다.

- [ ] **Step 4: E2EE 목록과 상세를 client decrypt로 구현한다**

서버에서 받은 metadata/ciphertext를 현재 UCK로 복호화하고 목록 preview는 `toHistoryPreview()`를 브라우저에서 적용한다. 상세는 `TurnText`에 평문을 넘기되 React state 외 영구 저장소에는 넣지 않는다. auth tag 실패 행은 `CONTENT_UNAVAILABLE` 문구로 격리한다.

- [ ] **Step 5: legacy와 E2EE를 명확히 구분한다**

`/history` 상단에 `E2EE · 이 브라우저에서 잠금 해제됨` 또는 `기존 서버 암호화` badge를 표시한다. legacy 세션은 기존 SSR 상세로 연결하고 E2EE 세션은 client detail로 연다. 혼합 세션은 encryption scheme별로 별도 항목을 만들어 암호화 경계를 합치지 않는다.

- [ ] **Step 6: lock 수명주기를 연결한다**

`로그아웃`, `지금 잠그기`, `visibilitychange` 후 15분 비활성, `beforeunload`에서 `contentKeyVault.lock()`을 호출한다. Service Worker, localStorage, sessionStorage, React Query persistence에는 UCK와 평문을 저장하지 않는다.

- [ ] **Step 7: 번역·접근성·좁은 폭을 검증한다**

Run: `pnpm --filter @toard/web test && pnpm --filter @toard/web typecheck && pnpm --filter @toard/web build`

Expected: tests/typecheck/build PASS; lock screen의 세 버튼과 countdown에 accessible name이 있고 360px 폭에서 가로 overflow가 없음.

- [ ] **Step 8: 변경을 커밋한다**

```bash
git add apps/web/app/'(dashboard)'/history apps/web/components/dashboard/overview-view.tsx apps/web/messages/ko/dashboard.json apps/web/messages/en/dashboard.json
git commit -m "feat(history): 브라우저 E2EE 잠금과 조회 화면 추가"
```

---

### Task 8: 온보딩, 보안 설정, open-mode 차단, CSP

**Files:**
- Modify: `apps/web/app/(dashboard)/settings/onboarding-flow.ts:3-67`
- Modify: `apps/web/app/(dashboard)/settings/onboarding-flow.test.ts:1-46`
- Modify: `apps/web/app/(dashboard)/settings/onboarding-wizard.tsx:1-285`
- Modify: `apps/web/app/(dashboard)/settings/page.tsx:28-311`
- Create: `apps/web/app/(dashboard)/settings/history-security-panel.tsx`
- Modify: `apps/web/lib/onboarding-install.ts`
- Modify: `apps/web/lib/onboarding-install.test.ts`
- Modify: `apps/web/lib/shell-installer.ts`
- Modify: `apps/web/lib/powershell-installer.ts`
- Modify: `apps/web/next.config.ts:11-39`
- Modify: `apps/web/messages/ko/settings.json`
- Modify: `apps/web/messages/en/settings.json`

**Interfaces:**
- Consumes: Task 3 setup CLI, Task 5 status API, Task 6 approved devices.
- Produces: onboarding steps `recovery | e2ee-ready`, history security status panel, history-specific CSP.

- [ ] **Step 1: onboarding 필수 recovery 전이 테스트를 작성한다**

```ts
test("E2EE 선택 시 recovery 확인 전 success로 가지 않는다", () => {
  let state = connectedE2eeState;
  state = onboardingReducer(state, { type: "connected", lastHost: "MacBook" });
  assert.equal(state.step, "recovery");
  state = onboardingReducer(state, { type: "recovery-confirmed" });
  assert.equal(state.step, "success");
});
```

- [ ] **Step 2: installer 명령 테스트를 새 모드에 맞춰 실패시킨다**

```ts
const input = {
  platform: "macos" as const,
  baseUrl: "https://toard.example",
  token: "tk_test",
  collectContent: true,
};
assert.match(buildInstallCommand(input), /TOARD_SHIM_COLLECT_CONTENT='e2ee_v1'/);
assert.doesNotMatch(buildInstallCommand(input), /recovery|mnemonic|uck/i);
```

Run: `pnpm --filter @toard/web test -- onboarding-flow.test.ts onboarding-install.test.ts`

Expected: FAIL because current command still emits `1` and reducer has no recovery state.

- [ ] **Step 3: wizard를 4단계 E2EE 흐름으로 확장한다**

E2EE 선택 시 설치·연결 뒤 `toard-shim e2ee setup` 실행 안내와 local Recovery Kit 완료 상태를 poll한다. 문구는 `이 컴퓨터에서 암호화한 뒤 전송합니다. 서버에 저장된 본문은 서버 키로 복호화할 수 없습니다.`를 사용한다. `사용량만 기록`은 기존 3단계 경로를 유지한다.

- [ ] **Step 4: installer가 pending 모드만 기록하게 바꾼다**

E2EE 선택 시 installer는 `collect_content=off`와 `e2ee_setup_requested=true`를 기록한다. setup CLI 성공 시에만 이를 `collect_content=e2ee_v1`로 원자 교체한다. 기존 `TOARD_SHIM_COLLECT_CONTENT=1`은 명시적 legacy 운영 호환으로 보존한다.

- [ ] **Step 5: 히스토리 보안 패널을 추가한다**

패널에는 E2EE 상태, 키 버전, 승인된 shim/browser label, 마지막 사용, recovery 확인일을 표시한다. 기기 폐기·키 회전·Recovery Kit 재발급 버튼은 실제 API가 준비되기 전 노출하지 않는다.

- [ ] **Step 6: open mode와 CSP를 하드닝한다**

E2EE API는 `getCurrentUserId()`가 아니라 `requireContentSession()`만 사용한다. `/history`와 `/api/content/*` 응답에 `Cache-Control:no-store`; history page에는 `script-src 'self'`, `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`, `require-trusted-types-for 'script'`를 적용한다. 현재 Mermaid 렌더가 필요한 상세 코드 블록과 충돌하는지 build 및 실브라우저로 확인하고 필요한 nonce는 서버 생성값만 사용한다.

- [ ] **Step 7: 설정·보안 테스트를 통과시킨다**

Run: `pnpm --filter @toard/web test && pnpm --filter @toard/web typecheck && pnpm --filter @toard/web build`

Expected: all checks PASS; open mode content endpoints return 403 while usage dashboard remains accessible.

- [ ] **Step 8: 변경을 커밋한다**

```bash
git add apps/web/app/'(dashboard)'/settings apps/web/lib/onboarding-install.ts apps/web/lib/onboarding-install.test.ts apps/web/lib/shell-installer.ts apps/web/lib/powershell-installer.ts apps/web/next.config.ts apps/web/messages/ko/settings.json apps/web/messages/en/settings.json
git commit -m "feat(settings): E2EE 온보딩과 보안 상태 추가"
```

---

### Task 9: 종단 검증과 운영 문서

**Files:**
- Create: `scripts/e2ee-ciphertext-only.integration.test.ts`
- Create: `docs/e2ee-prompt-history-runbook.md`
- Modify: `README.md`
- Modify: `SECURITY.md`
- Modify: `shim/README.md`

**Interfaces:**
- Consumes: Tasks 1-8의 실행 가능한 E2EE 수직 슬라이스.
- Produces: 재현 가능한 ciphertext-only 증거, 운영 enable/disable/진단 절차.

- [ ] **Step 1: ciphertext-only 통합 테스트를 작성한다**

테스트는 고유한 canary `TOARD_E2EE_PLAINTEXT_CANARY_7f39`를 shim fixture 로그에 넣고 setup→collect→history API까지 실행한다. DB의 모든 text/bytea를 `encode(...,'escape')`로 검사하고 app/shim captured logs와 HTTP bodies 중 서버 방향 payload를 검사한다.

```ts
assert.equal(dbScan.rows.some((row) => JSON.stringify(row).includes(CANARY)), false);
assert.equal(serverLogs.includes(CANARY), false);
assert.equal(ingestRequestBody.includes(CANARY), false);
assert.equal(browserDecryptedText, CANARY);
```

- [ ] **Step 2: 통합 테스트를 실행해 누락 경로를 찾는다**

Run: `node --import tsx --test scripts/e2ee-ciphertext-only.integration.test.ts`

Expected: PASS; DB/server logs/ingest body에는 canary가 없고 승인된 browser decrypt 결과에만 canary가 있음.

- [ ] **Step 3: 운영 runbook을 작성한다**

runbook에는 다음 명령과 성공 기준을 정확히 기록한다.

```bash
toard-shim e2ee setup
toard-shim e2ee status
toard-shim e2ee approve
curl -fsS http://localhost:3000/api/health
curl -fsS http://localhost:3000/api/ready
```

`TOARD_CONTENT_KEK_B64`는 legacy `server_v1`에만 필요하며 `e2ee_v1` 복호화 능력을 주지 않는다는 점, 복구키 상실 시 운영자도 복구할 수 없다는 점, `AUTH_MODE=open` 제한, keyring 미지원 Linux의 fail-closed 동작을 명시한다.

- [ ] **Step 4: 전체 검증을 실행한다**

Run: `cargo test --manifest-path shim/rust/Cargo.toml`

Expected: all shim tests PASS.

Run: `pnpm --filter @toard/web test && pnpm --filter @toard/web typecheck && pnpm --filter @toard/web build`

Expected: web tests, typecheck, build PASS.

Run: `pnpm test:migrations && node --import tsx --test scripts/e2ee-content-migration.integration.test.ts scripts/e2ee-ciphertext-only.integration.test.ts`

Expected: all migration/integration tests PASS and no Docker container remains.

Run: `git diff --check`

Expected: no output.

- [ ] **Step 5: 로컬 실브라우저 검증을 수행한다**

1. 새 사용자와 ingest token을 만든다.
2. E2EE를 선택해 shim 설치와 Recovery Kit 확인을 완료한다.
3. 패스키가 없는 새 browser profile에서 `/history`를 연다.
4. `연결된 컴퓨터로 승인`을 선택하고 확인 코드가 양쪽에서 같은지 본다.
5. shim 승인 뒤 목록 preview와 상세 turn이 복호화되는지 확인한다.
6. `지금 잠그기`, 로그아웃, IndexedDB 삭제 후 다시 잠금 화면이 보이는지 확인한다.
7. 360px, 768px, desktop 폭에서 screenshot을 남긴다.

Expected: 패스키 없이 승인·복호화가 성공하고, 잠금 뒤 평문이 다시 보이지 않으며, 좁은 폭에서 overflow가 없음.

- [ ] **Step 6: 문서와 검증 코드를 커밋한다**

```bash
git add scripts/e2ee-ciphertext-only.integration.test.ts docs/e2ee-prompt-history-runbook.md README.md SECURITY.md shim/README.md
git commit -m "docs(security): E2EE 운영과 검증 절차 추가"
```

---

## Follow-on Plans After This Slice

이 계획이 완료되고 첫 수직 슬라이스가 실브라우저에서 검증된 다음, 승인된 설계 문서에 따라 아래 세 계획을 각각 작성한다.

1. `E2EE Passkey PRF`: WebAuthn 로그인, PRF 지원 감지, passkey-wrapped UCK, 안전한 credential 삭제.
2. `E2EE Legacy Migration`: `server_v1` 페이지 단위 재암호화, 중단·재개, 해시 검증, legacy KEK 제거 조건.
3. `E2EE Rotation and Administration`: UCK 회전, DEK 재래핑, 기기 폐기, 관리자 집계, 브라우저 로컬 검색.

각 계획은 이 문서의 wire/DB 인터페이스를 소비하며, 첫 수직 슬라이스의 ciphertext-only 보장을 약화시키지 않아야 한다.
