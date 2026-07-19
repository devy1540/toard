# Managed Content Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 신규 shim 본문 수집과 일반 히스토리 열람을 `managed_v1` 서버 관리형 암호화로 전환한다.

**Architecture:** 기존 무표식 plaintext wire는 저장 scheme와 분리해 `plaintext_v1`으로 해석하고, 서버 runtime이 사용자 UCK를 얻어 `managed_v1`으로 저장한다. 히스토리는 사용자 context 안에서 managed 행을 조회하고 서버에서 복호화한다. 기존 `server_v1`과 `e2ee_v1`은 legacy migration 계획을 위해 읽기·수집 호환만 유지한다.

**Tech Stack:** Next.js 15 App Router, TypeScript 5.7, PostgreSQL RLS, Rust 2021 shim, Node and Rust test runners.

## Global Constraints

- 이 계획은 foundation과 여섯 provider 계획 완료 후 실행한다.
- 신규 installer는 E2EE setup, Recovery Kit, 기기 승인을 요구하지 않는다.
- shim plaintext는 HTTPS 또는 localhost endpoint로만 전송한다.
- 서버는 저장 전에 `managed_v1` 암호화를 완료하고 암호화 실패 시 행을 쓰지 않는다.
- KMS/auth/key 장애는 `503 CONTENT_KEY_UNAVAILABLE`로 fail-closed한다.
- shim content cursor는 HTTP 저장 성공 뒤에만 진행한다. 기존 동작을 유지한다.
- 사용량·비용 이벤트 수집 경로는 본문 KMS 장애와 분리한다.
- 다른 사용자와 toard admin은 본문 API의 소유권 검사를 우회하지 못한다.
- 기존 E2EE credential과 payload는 migration 완료 전까지 거부하지 않는다.
- 일반 readiness는 일시 KMS 장애를 `degraded`로 표시하되 DB와 설정이 유효하면 HTTP 200을 유지한다.
- managed 행이 존재하는데 active provider 설정이 없거나 fingerprint를 해석할 수 없으면 readiness 503이다.

---

## File Structure

- `apps/web/lib/managed-content-runtime.ts`: provider registry, cache, installation ID, user key service process singleton.
- `apps/web/lib/managed-content-runtime.test.ts`: config disabled/invalid/active runtime 수명 테스트.
- `apps/web/lib/prompt-records.ts`: plaintext batch를 managed row로 저장.
- `apps/web/app/api/v1/prompts/route.ts`: managed 저장과 safe 503 mapping.
- `apps/web/lib/prompt-wire.ts`: `plaintext_v1`과 transitional `e2ee_v1` wire 분리.
- `apps/web/lib/prompt-history.ts`: `managed_v1` 서버 복호화와 transitional `server_v1`.
- `apps/web/lib/content-encryption-readiness.ts`: DB 상태+설정+provider health readiness.
- `apps/web/app/api/ready/route.ts`: `contentEncryption` payload.
- installer와 shim 파일: 신규 `collect_content=true`, E2EE setup 안내 제거.
- dashboard/settings/admin messages: 서버 관리형 보안 경계 문구.

---

### Task 1: process runtime과 managed prompt 저장

**Files:**
- Create: `apps/web/lib/managed-content-runtime.ts`
- Create: `apps/web/lib/managed-content-runtime.test.ts`
- Modify: `apps/web/lib/content-crypto.ts`
- Modify: `apps/web/lib/legacy-content-crypto.ts`
- Modify: `apps/web/lib/e2ee-legacy-retirement.ts`
- Modify: `apps/web/lib/e2ee-legacy-retirement.test.ts`
- Modify: `apps/web/lib/prompt-records.ts`
- Modify: `apps/web/lib/prompt-records.test.ts`

**Interfaces:**
- Consumes `loadKeyManagementConfig`, `createKeyProviderRegistry`, `ManagedUserKeyService`.
- Produces `getManagedContentRuntime(): Promise<ManagedContentRuntime>`.
- Produces `managedContentConfigured(env): boolean`.
- Keeps `legacyContentKeyConfigured(env)` only for `server_v1` migration and retirement.
- Produces `saveManagedPromptRecords(userId, records, runtime, db?)`.

- [ ] **Step 1: runtime singleton 실패 테스트를 작성한다**

```ts
test("runtime은 installation ID와 provider registry를 한 번만 만든다", async () => {
  const deps = createRuntimeDeps();
  const first = await getManagedContentRuntime(deps);
  const second = await getManagedContentRuntime(deps);
  assert.equal(first, second);
  assert.equal(deps.installationLoads, 1);
  assert.equal(deps.providerCreates, 1);
});

test("provider 미설정은 disabled이고 잘못된 설정은 예외다", async () => {
  assert.equal(await createManagedContentRuntime({ env: {}, ...deps }), null);
  await assert.rejects(
    createManagedContentRuntime({
      env: { TOARD_KEY_ACTIVE_PROVIDER: "aws-kms" },
      ...deps,
    }),
    /AWS_KEY_ARN/,
  );
});
```

- [ ] **Step 2: runtime 테스트가 모듈 부재로 실패하는지 확인한다**

Run: `pnpm --filter @toard/web exec node --import tsx --test lib/managed-content-runtime.test.ts`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: runtime singleton을 구현한다**

```ts
export type ManagedContentRuntime = {
  installationId: string;
  registry: KeyProviderRegistry;
  userKeys: ManagedUserKeyService;
  health: ProviderHealthCache;
};

let runtimePromise: Promise<ManagedContentRuntime | null> | undefined;

export function getManagedContentRuntime(
  deps: RuntimeDependencies = defaultRuntimeDependencies,
): Promise<ManagedContentRuntime | null> {
  runtimePromise ??= createManagedContentRuntime(deps);
  return runtimePromise;
}
```

`createManagedContentRuntime`은 `TOARD_KEY_ACTIVE_PROVIDER`가 없으면 `null`, 있으면 config를 strict parse한다. `installation_identity` row를 읽고 provider registry, `UserKeyCache`, `ManagedUserKeyService`, `ProviderHealthCache`를 한 번 생성한다. test 전용 `resetManagedContentRuntimeForTests()`는 `NODE_ENV=test`에서만 export한다.

- [ ] **Step 4: 신규 managed 활성 여부와 legacy KEK 확인을 분리한다**

```ts
export function managedContentConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!env.TOARD_KEY_ACTIVE_PROVIDER) return false;
  try {
    loadKeyManagementConfig(env);
    return true;
  } catch {
    return false;
  }
}

export function contentCollectionEnabled(): boolean {
  return managedContentConfigured();
}
```

`contentCollectionDefaultOn`은 위 managed 활성 여부에만 의존하게 바꾼다. 기존 `loadKek`, `encryptContent`, `decryptContent`는 `legacy-content-crypto.ts`에 남기되 `legacyContentKeyConfigured(env)`를 추가한다. `e2ee-legacy-retirement.ts`는 더 이상 `contentCollectionEnabled()`를 import하지 않고 `legacyContentKeyConfigured()`로 `server_v1` KEK 제거 가능 여부만 판단한다. 테스트는 managed provider만 설정된 경우와 legacy KEK만 설정된 경우를 각각 검증한다.

- [ ] **Step 5: managed 저장 실패 테스트를 작성한다**

```ts
test("plaintext records are encrypted as managed_v1 before INSERT", async () => {
  const result = await saveManagedPromptRecords(USER_ID, [PROMPT], runtime, db);
  assert.deepEqual(result, { inserted: 1, deduped: 0 });
  const insert = db.calls.find((call) => /INSERT INTO prompt_records/.test(call.sql))!;
  assert.match(insert.sql, /'managed_v1'/);
  assert.equal(insert.params.includes(PROMPT.text), false);
  assert.equal(insert.params.some((value) => Buffer.isBuffer(value) && value.includes(PROMPT.text)), false);
});

test("encryption failure writes no row", async () => {
  runtime.userKeys.failWith(new Error("KMS_UNAVAILABLE"));
  await assert.rejects(saveManagedPromptRecords(USER_ID, [PROMPT], runtime, db), /KMS_UNAVAILABLE/);
  assert.equal(db.calls.some((call) => /INSERT INTO prompt_records/.test(call.sql)), false);
});
```

- [ ] **Step 6: managed batch 저장을 구현한다**

```ts
export async function saveManagedPromptRecords(
  userId: string,
  records: PromptRecordWire[],
  runtime: ManagedContentRuntime,
  db?: PromptDb,
): Promise<{ inserted: number; deduped: number }> {
  if (records.length === 0) return { inserted: 0, deduped: 0 };
  return runtime.userKeys.withActiveUserKey(userId, async (uck, keyVersion) => {
    const encrypted = records.map((record) =>
      encryptManagedContent(record, uck, runtime.installationId, userId, keyVersion));
    return runPromptContext(userId, db, async (tx) => {
      let inserted = 0;
      for (let index = 0; index < records.length; index += 1) {
        const record = records[index]!;
        const enc = encrypted[index]!;
        const result = await tx.query(
          `INSERT INTO prompt_records
             (dedup_key,user_id,session_id,provider_key,turn_role,ts,key_version,
              wrapped_dek,iv,ciphertext,auth_tag,encryption_scheme,content_key_version,
              dek_wrap_iv,dek_wrap_auth_tag,aad_version)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
                  'managed_v1',$7,$12,$13,2)
           ON CONFLICT(dedup_key) DO NOTHING`,
          [
            record.dedupKey, userId, record.sessionId, record.providerKey, record.turnRole,
            record.ts, enc.contentKeyVersion, enc.wrappedDek, enc.iv, enc.ciphertext,
            enc.authTag, enc.dekWrapIv, enc.dekWrapAuthTag,
          ],
        );
        inserted += result.rowCount ?? 0;
      }
      return { inserted, deduped: records.length - inserted };
    });
  });
}
```

- [ ] **Step 7: 저장 tests와 typecheck를 통과시킨다**

Run: `pnpm --filter @toard/web exec node --import tsx --test lib/managed-content-runtime.test.ts lib/e2ee-legacy-retirement.test.ts lib/prompt-records.test.ts && pnpm --filter @toard/web typecheck`

Expected: tests PASS, TypeScript error 0.

- [ ] **Step 8: Task 1을 커밋한다**

```bash
git add apps/web/lib/managed-content-runtime.ts apps/web/lib/managed-content-runtime.test.ts apps/web/lib/content-crypto.ts apps/web/lib/legacy-content-crypto.ts apps/web/lib/e2ee-legacy-retirement.ts apps/web/lib/e2ee-legacy-retirement.test.ts apps/web/lib/prompt-records.ts apps/web/lib/prompt-records.test.ts
git commit -m "feat(security): managed 본문 저장 runtime 연결"
```

---

### Task 2: ingest route를 managed 저장으로 전환

**Files:**
- Modify: `apps/web/lib/prompt-wire.ts`
- Modify: `apps/web/lib/prompt-wire.test.ts`
- Modify: `apps/web/app/api/v1/prompts/route.ts`
- Modify: `apps/web/app/api/v1/prompts/route.test.ts`

**Interfaces:**
- Produces `ParsedPromptBatch = plaintext_v1 | e2ee_v1`.
- Route consumes `getManagedContentRuntime`, `saveManagedPromptRecords`.
- Transitional E2EE route still consumes `saveE2eePromptRecords`.

- [ ] **Step 1: wire 명명과 route 실패 테스트를 수정한다**

```ts
test("schema 없는 기존 shim payload는 plaintext_v1으로 해석한다", () => {
  assert.deepEqual(parsePromptBatch([PLAIN_RECORD]).schema, "plaintext_v1");
});

test("plaintext route stores managed content even for an active legacy E2EE account", async () => {
  const handler = POST.withDependencies({
    authenticateIngestToken: auth,
    loadProviders: providers,
    getManagedContentRuntime: async () => runtime,
    saveManagedPromptRecords: async () => ({ inserted: 1, deduped: 0 }),
  });
  const response = await handler(request([PLAIN_RECORD]));
  assert.equal(response.status, 200);
});
```

- [ ] **Step 2: 기존 route test가 `E2EE_REQUIRED` 기대 때문에 실패하는지 확인한다**

Run: `pnpm --filter @toard/web exec node --import tsx --test lib/prompt-wire.test.ts app/api/v1/prompts/route.test.ts`

Expected: active E2EE account test와 schema 이름 assertion에서 FAIL.

- [ ] **Step 3: parsed batch 이름을 저장 형식에서 분리한다**

```ts
export type ParsedPromptBatch =
  | { schema: "plaintext_v1"; records: PromptRecordWire[] }
  | { schema: "e2ee_v1"; records: E2eePromptRecordWire[] };

export function parsePromptBatch(body: unknown): ParsedPromptBatch {
  if (!Array.isArray(body)) throw new PromptWireError("본문은 PromptRecord 배열이어야 합니다");
  if (body.length === 0) return { schema: "plaintext_v1", records: [] };
  // e2ee_v1 exact parser는 유지한다.
  // schema가 없으면 plaintext_v1, 알 수 있는 schema가 있으면 fail-closed한다.
  return { schema: "plaintext_v1", records: parsePromptRecordsBody(body) };
}
```

- [ ] **Step 4: route의 plaintext branch를 managed runtime으로 교체한다**

```ts
const runtime = await deps.getManagedContentRuntime();
if (!runtime) {
  return Response.json({ code: "CONTENT_COLLECTION_DISABLED" }, { status: 503 });
}
try {
  return Response.json(await deps.saveManagedPromptRecords(auth.userId, batch.records, runtime));
} catch (error) {
  return Response.json(
    { code: toSafeContentErrorCode(error) },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}
```

`isE2eeContentActive`, `loadKek`, `E2EE_REQUIRED` plaintext gate를 제거한다. `e2ee_v1` branch는 migration 완료 전까지 그대로 둔다. 오류 body에 provider message를 포함하지 않는다.

- [ ] **Step 5: route tests와 plaintext leak assertion을 통과시킨다**

Run: `pnpm --filter @toard/web exec node --import tsx --test lib/prompt-wire.test.ts app/api/v1/prompts/route.test.ts`

Expected: tests PASS, 503 body와 captured logs 어디에도 `secret prompt` 없음.

- [ ] **Step 6: Task 2를 커밋한다**

```bash
git add apps/web/lib/prompt-wire.ts apps/web/lib/prompt-wire.test.ts apps/web/app/api/v1/prompts/route.ts apps/web/app/api/v1/prompts/route.test.ts
git commit -m "feat(security): 신규 본문 수집을 managed 암호화로 전환"
```

---

### Task 3: server-decrypted managed history

**Files:**
- Modify: `apps/web/lib/prompt-history.ts`
- Modify: `apps/web/lib/prompt-history.test.ts`
- Modify: `apps/web/app/(dashboard)/history/page.tsx`
- Modify: `apps/web/app/(dashboard)/history/session-detail.tsx`
- Modify: `apps/web/messages/ko/dashboard.json`
- Modify: `apps/web/messages/en/dashboard.json`

**Interfaces:**
- Consumes `ManagedContentRuntime.userKeys.withUserKeyVersion`.
- Produces managed and transitional server history from one server-side service.
- E2EE account branch remains until the migration plan marks it complete.

- [ ] **Step 1: mixed managed/server history 실패 테스트를 작성한다**

```ts
test("history decrypts managed rows with their content key version", async () => {
  const result = await getMyHistorySession(USER_ID, "session-1", { runtime, db, legacyKek });
  assert.equal(result.session?.turns[0]?.text, "managed secret");
  assert.deepEqual(runtime.userKeys.requestedVersions, [1]);
});

test("another user cannot select or decrypt managed rows", async () => {
  const result = await getMyHistorySession(OTHER_USER, "session-1", { runtime, db, legacyKek });
  assert.equal(result.session, null);
  assert.equal(runtime.userKeys.calls, 0);
});
```

- [ ] **Step 2: history tests가 `server_v1` 전용 조건 때문에 실패하는지 확인한다**

Run: `pnpm --filter @toard/web exec node --import tsx --test lib/prompt-history.test.ts`

Expected: managed row가 조회되지 않아 assertion FAIL.

- [ ] **Step 3: history cipher row와 scheme별 decrypt를 구현한다**

```ts
type HistoryCipherRow = {
  encryption_scheme: "server_v1" | "managed_v1";
  content_key_version: number | null;
  key_version: number;
  wrapped_dek: Buffer;
  dek_wrap_iv: Buffer | null;
  dek_wrap_auth_tag: Buffer | null;
  iv: Buffer;
  ciphertext: Buffer;
  auth_tag: Buffer;
  dedup_key: string;
  session_id: string | null;
  provider_key: string;
  turn_role: "user" | "assistant";
  ts: Date;
};
```

```ts
async function decryptHistoryRow(
  row: HistoryCipherRow,
  userId: string,
  deps: HistoryDependencies,
): Promise<string | null> {
  try {
    if (row.encryption_scheme === "server_v1") {
      if (!deps.legacyKek) return null;
      return decryptContent(row, deps.legacyKek);
    }
    if (!row.content_key_version || !row.dek_wrap_iv || !row.dek_wrap_auth_tag) return null;
    return deps.runtime.userKeys.withUserKeyVersion(
      userId,
      row.content_key_version,
      (uck) => decryptManagedContent(row, uck, deps.runtime.installationId, userId),
    );
  } catch {
    return null;
  }
}
```

SQL condition은 `encryption_scheme IN ('server_v1','managed_v1')`로 바꾸고 항상 `user_id=$1`을 유지한다. preview도 `Promise.all`로 복호화하되 page size 20 경계를 유지한다.

- [ ] **Step 4: UI 문구를 서버 관리형 경계로 교체한다**

```json
{
  "privacyNote": "나만 볼 수 있습니다 — 관리자 화면과 다른 사용자는 조회할 수 없습니다.",
  "managedPrivacyNote": "DB와 백업에는 암호문으로 저장됩니다. 앱 서버와 키 관리 권한을 함께 가진 인프라 운영자는 복호화할 수 있습니다.",
  "contentUnavailable": "본문을 열 수 없습니다. 키 관리 공급자 상태를 확인하세요."
}
```

`legacyPrivacyNote`는 `server_v1` 행이 남아 있는 동안만 사용한다. 일반 managed history header는 `managedPrivacyNote`를 표시한다.

- [ ] **Step 5: history tests와 page source tests를 통과시킨다**

Run: `pnpm --filter @toard/web exec node --import tsx --test lib/prompt-history.test.ts app/'(dashboard)'/history/*.test.ts && pnpm --filter @toard/web typecheck`

Expected: tests PASS, TypeScript error 0.

- [ ] **Step 6: Task 3을 커밋한다**

```bash
git add apps/web/lib/prompt-history.ts apps/web/lib/prompt-history.test.ts apps/web/app/'(dashboard)'/history/page.tsx apps/web/app/'(dashboard)'/history/session-detail.tsx apps/web/messages/ko/dashboard.json apps/web/messages/en/dashboard.json
git commit -m "feat(history): managed 본문 서버 복호화 열람 추가"
```

---

### Task 4: readiness와 degraded 상태

**Files:**
- Create: `apps/web/lib/content-encryption-readiness.ts`
- Create: `apps/web/lib/content-encryption-readiness.test.ts`
- Modify: `apps/web/app/api/ready/route.ts`
- Modify: `apps/web/app/api/ready/route.test.ts`

**Interfaces:**
- Produces `getContentEncryptionReadiness(db, env, runtime): ContentEncryptionReadiness`.
- Adds `/api/ready.contentEncryption`.

- [ ] **Step 1: readiness 상태 전이 실패 테스트를 작성한다**

```ts
test("managed rows without active provider are not ready", async () => {
  await assert.rejects(
    getContentEncryptionReadiness(dbStatus({ managedRecords: 2 }), {}, null),
    /MANAGED_KEY_PROVIDER_MISSING/,
  );
});

test("temporary KMS outage is degraded but does not drop whole app readiness", async () => {
  const status = await getContentEncryptionReadiness(
    dbStatus({ managedRecords: 2 }),
    VALID_ENV,
    runtimeHealth("unavailable"),
  );
  assert.equal(status.status, "degraded");
});
```

- [ ] **Step 2: 테스트가 readiness 모듈 부재로 실패하는지 확인한다**

Run: `pnpm --filter @toard/web exec node --import tsx --test lib/content-encryption-readiness.test.ts`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: readiness service를 구현한다**

```ts
export type ContentEncryptionReadiness = {
  status: "disabled" | "healthy" | "degraded";
  provider: KeyProviderName | null;
  keyRef: string | null;
  fingerprint: string | null;
  managedRecords: number;
  lastCheckAt: string | null;
  errorCode: string | null;
};
```

DB에서는 `content_encryption_status`만 읽는다. provider 미설정+managed 0건은 `disabled`, provider 미설정+managed>0은 예외, config parse 실패는 예외다. provider health가 일시 오류면 `degraded`, auth/key missing/disabled처럼 영구 설정 오류면 readiness 예외로 분류한다.

- [ ] **Step 4: `/api/ready` payload에 상태를 추가한다**

```ts
return NextResponse.json({
  status: "ready",
  contentEncryption,
  rollups: toTimezoneRollupReadyPayload(timezoneRollup),
  historicalPricingReader: {
    currentVersion: serverVersion,
    minimumVersion: HISTORICAL_PRICING_MIN_READER_VERSION,
    compatible: supportsHistoricalPricingReader(serverVersion),
  },
});
```

catch response는 기존처럼 `{status:"not-ready"}`만 반환해 secret이나 provider 원문 오류를 노출하지 않는다.

- [ ] **Step 5: readiness tests를 통과시킨다**

Run: `pnpm --filter @toard/web exec node --import tsx --test lib/content-encryption-readiness.test.ts app/api/ready/route.test.ts && pnpm --filter @toard/web typecheck`

Expected: disabled/healthy/degraded/503 cases PASS.

- [ ] **Step 6: Task 4를 커밋한다**

```bash
git add apps/web/lib/content-encryption-readiness.ts apps/web/lib/content-encryption-readiness.test.ts apps/web/app/api/ready/route.ts apps/web/app/api/ready/route.test.ts
git commit -m "feat(ops): managed 키 공급자 readiness 추가"
```

---

### Task 5: 신규 installer와 shim 기본 경로에서 E2EE 제거

**Files:**
- Modify: `apps/web/lib/onboarding-install.ts`
- Modify: `apps/web/lib/onboarding-install.test.ts`
- Modify: `apps/web/lib/shell-installer.ts`
- Modify: `apps/web/lib/shell-installer-e2ee.test.ts`
- Modify: `apps/web/lib/powershell-installer.ts`
- Modify: `apps/web/lib/powershell-installer.test.ts`
- Modify: `apps/web/app/(dashboard)/settings/onboarding-flow.ts`
- Modify: `apps/web/app/(dashboard)/settings/onboarding-flow.test.ts`
- Modify: `apps/web/app/(dashboard)/settings/onboarding-wizard.tsx`
- Modify: `shim/rust/src/credentials.rs`
- Modify: `shim/rust/src/collect/mod.rs`
- Modify: `shim/rust/src/cli.rs`
- Modify: `shim/README.md`

**Interfaces:**
- New installs write `collect_content=true`.
- Existing `collect_content=e2ee_v1` continues as `LegacyE2eeV1`.
- E2EE CLI remains visible only under a `legacy-e2ee` help section until migration retirement.

- [ ] **Step 1: installer 실패 테스트를 새 제품 흐름으로 바꾼다**

```ts
test("content opt-in install command selects server-managed collection", () => {
  const command = buildInstallCommand({ ...INPUT, collectContent: true });
  assert.match(command, /TOARD_SHIM_COLLECT_CONTENT='1'/);
  assert.doesNotMatch(command, /e2ee_v1|Recovery Kit|e2ee setup/);
});

test("onboarding completes without recovery step", () => {
  assert.deepEqual(flowSteps({ contentEnabled: true, collectContent: true }), [
    "platform", "install", "waiting", "complete",
  ]);
});
```

- [ ] **Step 2: 기존 installer tests가 E2EE 기대 때문에 실패하는지 확인한다**

Run: `pnpm --filter @toard/web exec node --import tsx --test lib/onboarding-install.test.ts lib/shell-installer-e2ee.test.ts lib/powershell-installer.test.ts app/'(dashboard)'/settings/onboarding-flow.test.ts`

Expected: `e2ee_v1`/recovery assertion에서 FAIL.

- [ ] **Step 3: installer 출력을 `collect_content=true`로 고정한다**

```ts
export function buildInstallCommand(input: InstallCommandInput): string {
  const collect = input.collectContent ? "1" : "0";
  // platform quoting은 기존 구현 유지
}
```

POSIX와 PowerShell script에서 `e2ee_v1` case와 `e2ee_setup_requested` 기록을 제거한다. content on은 `collect_content=true`, off는 필드 생략 또는 `collect_content=off`다.

- [ ] **Step 4: Rust credential enum을 호환 이름으로 명확히 한다**

```rust
pub enum ContentCollectionMode {
    Off,
    ServerManaged,
    LegacyE2eeV1,
}

impl ContentCollectionMode {
    pub fn parse(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "e2ee_v1" => Self::LegacyE2eeV1,
            "1" | "true" | "on" | "yes" | "server_v1" | "managed_v1" => Self::ServerManaged,
            _ => Self::Off,
        }
    }
}
```

`collect/mod.rs`는 `ServerManaged`에서 기존 plaintext `to_prompts_body`, `LegacyE2eeV1`에서 기존 로컬 암호화 경로를 사용한다. dry-run 표시는 각각 `managed_v1`, `legacy-e2ee_v1`로 바꾼다.

- [ ] **Step 5: E2EE CLI를 신규 주 경로에서 내린다**

기본 help의 본문 수집 설명은 `서버 관리형 암호화`로 바꾼다. `e2ee setup/status/approve` 명령 자체는 legacy 사용자 복구와 전환을 위해 제거하지 않고 아래 경고를 먼저 출력한다.

```rust
eprintln!("toard-shim: legacy E2EE 호환 명령입니다. 신규 연결에는 필요하지 않습니다.");
```

- [ ] **Step 6: web과 Rust tests를 통과시킨다**

Run:

```bash
pnpm --filter @toard/web test
pnpm --filter @toard/web typecheck
cargo test --manifest-path shim/rust/Cargo.toml
```

Expected: web tests PASS, TypeScript error 0, Rust tests PASS.

- [ ] **Step 7: Task 5를 커밋한다**

```bash
git add apps/web/lib/onboarding-install.ts apps/web/lib/onboarding-install.test.ts apps/web/lib/shell-installer.ts apps/web/lib/shell-installer-e2ee.test.ts apps/web/lib/powershell-installer.ts apps/web/lib/powershell-installer.test.ts apps/web/app/'(dashboard)'/settings/onboarding-flow.ts apps/web/app/'(dashboard)'/settings/onboarding-flow.test.ts apps/web/app/'(dashboard)'/settings/onboarding-wizard.tsx shim/rust/src/credentials.rs shim/rust/src/collect/mod.rs shim/rust/src/cli.rs shim/README.md
git commit -m "feat(onboarding): 신규 본문 연결을 서버 관리형으로 전환"
```

---

## Plan 3 Completion Gate

Run:

```bash
pnpm --filter @toard/web test
pnpm --filter @toard/web typecheck
cargo test --manifest-path shim/rust/Cargo.toml
pnpm test:migrations
git diff --check HEAD~5
```

Manual local-provider smoke:

```bash
head -c 32 /dev/urandom > /tmp/toard-local-kek
chmod 600 /tmp/toard-local-kek
TOARD_KEY_ACTIVE_PROVIDER=local \
TOARD_KEY_ACTIVE_LOCAL_KEK_FILE=/tmp/toard-local-kek \
pnpm --filter @toard/web dev
```

Expected:

- 새 installer에 Recovery Kit 단계가 없다.
- plaintext prompt POST가 DB에는 `managed_v1` ciphertext로 저장된다.
- 같은 사용자가 다른 브라우저에서 로그인하면 서버 복호화 history를 본다.
- 다른 사용자와 admin의 소유권 우회 test가 실패한다.
- KMS 장애 중 prompt POST는 503이고 usage event POST는 계속 성공한다.
