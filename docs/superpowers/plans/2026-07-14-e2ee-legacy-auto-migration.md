# E2EE Legacy Auto-Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 승인된 브라우저가 기존 `server_v1` 프롬프트 기록을 사용자 조작 없이 페이지 단위로 재암호화하고, 동일 브라우저 재접속에서는 반복 승인 없이 자동 잠금 해제하도록 만든다.

**Architecture:** 서버는 승인된 브라우저에만 레거시 평문 페이지를 `no-store`로 제공하고, 브라우저는 메모리의 UCK로 각 기록을 `e2ee_v1` 형식으로 암호화한 뒤 로컬 round-trip 검증을 수행한다. 서버는 소유권·원본 digest·메타데이터·활성 키 버전을 다시 확인하고 기존 `prompt_records` 행을 한 트랜잭션에서 동일 PK로 갱신한다. 남은 `server_v1` 행 자체가 작업 큐이므로 별도 cursor 없이 중단·재개와 다중 탭 idempotency를 제공한다.

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript 5.7, PostgreSQL 16 RLS, Web Crypto AES-256-GCM, Node `crypto`, Node test runner, Docker integration tests.

## Global Constraints

- 운영 DB를 직접 수정하지 않는다. 마이그레이션과 임시 PostgreSQL 통합 테스트만 사용한다.
- 서버는 UCK, Recovery Kit, 브라우저 private key를 받거나 로그에 남기지 않는다.
- legacy 평문 API와 모든 오류 응답은 `Cache-Control: no-store`를 사용한다.
- E2EE 활성화 이후 새 `server_v1` 쓰기를 `409 E2EE_REQUIRED`로 차단한다.
- 기존 기록은 삭제·복제하지 않고 동일 `prompt_records.id`를 원자적으로 갱신한다.
- 배치는 최대 25건이며 한 건 검증 실패 시 전체 배치를 rollback한다.
- 같은 승인 브라우저는 새로고침·재실행·hidden 복귀 때 외부 승인을 요구하지 않는다.
- Passkey PRF, UCK 회전, 보존 기간 변경, 계정 탈퇴 삭제는 이번 범위에 포함하지 않는다.

---

### Task 1: 브라우저 재암호화 계약과 AES-GCM writer

**Files:**
- Create: `apps/web/lib/e2ee-legacy-contract.ts`
- Create: `apps/web/lib/e2ee-legacy-contract.test.ts`
- Modify: `apps/web/lib/e2ee-browser-crypto.ts`
- Modify: `apps/web/lib/e2ee-browser-crypto.test.ts`

**Interfaces:**
- Consumes: `canonicalContentAad`, `parseE2eePromptRecord`, `decryptE2eeRecord`.
- Produces: `LegacyMigrationSource`, `LegacyMigrationCommitItem`, `parseLegacyMigrationCommit`, `encryptE2eeRecord(uck, source, contentOwnerId, contentKeyVersion)`.

- [ ] **Step 1: legacy commit 계약의 실패 테스트를 작성한다**

```ts
test("legacy commit은 최대 25건이며 source와 E2EE metadata 일치를 요구한다", () => {
  assert.throws(() => parseLegacyMigrationCommit({ items: Array(26).fill(validItem) }), /최대 25건/);
  assert.throws(
    () => parseLegacyMigrationCommit({
      items: [{ ...validItem, record: { ...validItem.record, dedupKey: "changed" } }],
    }),
    /dedupKey/,
  );
});
```

- [ ] **Step 2: 계약 테스트가 올바르게 실패하는지 실행한다**

Run: `pnpm --filter @toard/web exec node --import tsx --test lib/e2ee-legacy-contract.test.ts`

Expected: `ERR_MODULE_NOT_FOUND` 또는 `parseLegacyMigrationCommit is not defined`로 FAIL.

- [ ] **Step 3: shared wire 계약을 구현한다**

```ts
export type LegacyMigrationSource = {
  id: string;
  dedupKey: string;
  sessionId: string | null;
  providerKey: string;
  turnRole: "user" | "assistant";
  ts: string;
  text: string;
  sourceDigest: string;
};

export type LegacyMigrationCommitItem = {
  id: string;
  sourceDigest: string;
  record: E2eePromptRecordWire;
};

export function parseLegacyMigrationCommit(value: unknown): LegacyMigrationCommitItem[] {
  const input = exactObject(value, ["items"]);
  if (!Array.isArray(input.items) || input.items.length === 0 || input.items.length > 25) {
    throw new E2eeContractError("legacy migration 배치는 1~25건이어야 합니다");
  }
  return input.items.map((raw) => {
    const item = exactObject(raw, ["id", "sourceDigest", "record"]);
    const record = parseE2eePromptRecord(item.record);
    const id = decimalId(item.id);
    const sourceDigest = base64url32(item.sourceDigest);
    return { id, sourceDigest, record };
  });
}
```

`exactObject`, `decimalId`, `base64url32`는 이 파일의 private helper로 구현하고 추가 필드, 음수/0 ID, 32바이트가 아닌 digest를 거부한다.

- [ ] **Step 4: 브라우저 암호화 writer의 실패 테스트를 작성한다**

```ts
test("browser encrypt writer는 decryptE2eeRecord로 원문을 round-trip한다", async () => {
  const uck = crypto.getRandomValues(new Uint8Array(32));
  const record = await encryptE2eeRecord(uck, source, ownerId, 1);
  const plaintext = await decryptE2eeRecord(uck, record);
  assert.equal(new TextDecoder().decode(plaintext), source.text);
  assert.equal(record.dedupKey, source.dedupKey);
});
```

- [ ] **Step 5: writer 테스트가 함수 부재로 실패하는지 실행한다**

Run: `pnpm --filter @toard/web exec node --import tsx --test lib/e2ee-browser-crypto.test.ts`

Expected: `encryptE2eeRecord is not defined`로 FAIL.

- [ ] **Step 6: AES-GCM writer를 구현한다**

```ts
export async function encryptE2eeRecord(
  uck: Uint8Array,
  source: Omit<LegacyMigrationSource, "text" | "sourceDigest" | "id"> & { text: string },
  contentOwnerId: string,
  contentKeyVersion: number,
): Promise<E2eePromptRecordWire> {
  const base = {
    schema: "e2ee_v1" as const,
    algorithm: "AES-256-GCM" as const,
    aadVersion: 1 as const,
    contentOwnerId,
    contentKeyVersion,
    dedupKey: source.dedupKey,
    sessionId: source.sessionId,
    providerKey: source.providerKey,
    turnRole: source.turnRole,
    ts: new Date(source.ts).toISOString(),
  };
  const aad = canonicalContentAad(base);
  const dek = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const dekWrapIv = crypto.getRandomValues(new Uint8Array(12));
  try {
    const encryptedBody = await aesGcmEncrypt(dek, iv, aad, new TextEncoder().encode(source.text));
    const wrappedDek = await aesGcmEncrypt(uck, dekWrapIv, aad, dek);
    return parseE2eePromptRecord({
      ...base,
      wrappedDek: b64url(wrappedDek.ciphertext),
      dekWrapIv: b64url(dekWrapIv),
      dekWrapAuthTag: b64url(wrappedDek.authTag),
      iv: b64url(iv),
      ciphertext: b64url(encryptedBody.ciphertext),
      authTag: b64url(encryptedBody.authTag),
    });
  } finally {
    dek.fill(0);
  }
}
```

`aesGcmEncrypt`는 WebCrypto가 반환한 마지막 16바이트를 auth tag로 분리하고 raw key는 non-extractable `CryptoKey`로 import한다.

- [ ] **Step 7: Task 1 테스트와 타입 검사를 통과시킨다**

Run: `pnpm --filter @toard/web exec node --import tsx --test lib/e2ee-legacy-contract.test.ts lib/e2ee-browser-crypto.test.ts && pnpm --filter @toard/web typecheck`

Expected: 관련 테스트 PASS, TypeScript error 0.

- [ ] **Step 8: Task 1을 커밋한다**

```bash
git add apps/web/lib/e2ee-legacy-contract.ts apps/web/lib/e2ee-legacy-contract.test.ts apps/web/lib/e2ee-browser-crypto.ts apps/web/lib/e2ee-browser-crypto.test.ts
git commit -m "feat(security): 기존 기록 브라우저 재암호화 추가"
```

### Task 2: 서버 legacy migration 서비스와 원자적 UPDATE

**Files:**
- Create: `apps/web/lib/e2ee-legacy-migration.ts`
- Create: `apps/web/lib/e2ee-legacy-migration.test.ts`
- Modify: `migrations/1700000030_e2ee_content_foundation.sql`
- Modify: `scripts/e2ee-content-migration.integration.test.ts`

**Interfaces:**
- Consumes: `decryptContent`, `loadKek`, `parseLegacyMigrationCommit`, `withUserContext`.
- Produces: `getLegacyMigrationStatus`, `getLegacyMigrationPage`, `commitLegacyMigrationBatch`, `LegacyMigrationError`.

- [ ] **Step 1: RLS UPDATE와 Down guard 통합 실패 테스트를 추가한다**

통합 테스트에서 migration 30 적용 후 app role로 `server_v1` 행을 UPDATE하고, E2EE 행이 존재할 때 Down 부분이 오류를 내는지 검증한다.

```ts
await client.query("BEGIN");
await client.query("SELECT set_config('app.current_user_id', $1, true)", [userA]);
assert.equal((await client.query(
  "UPDATE prompt_records SET received_at = received_at WHERE user_id = $1 RETURNING id",
  [userA],
)).rowCount, 1);
await client.query("ROLLBACK");

await assert.rejects(applyDownMigration(client, "1700000030_e2ee_content_foundation.sql"), /E2EE rows exist/);
```

- [ ] **Step 2: 통합 테스트가 UPDATE policy/guard 부재로 실패하는지 실행한다**

Run: `node --import tsx --test scripts/e2ee-content-migration.integration.test.ts`

Expected: UPDATE RLS 또는 Down guard assertion에서 FAIL.

- [ ] **Step 3: migration 30에 UPDATE policy와 rollback guard를 구현한다**

```sql
CREATE POLICY prompt_owner_update ON prompt_records
  FOR UPDATE
  USING (user_id = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

-- Down Migration
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM prompt_records WHERE encryption_scheme = 'e2ee_v1') THEN
    RAISE EXCEPTION 'migration 30 rollback blocked: E2EE rows exist';
  END IF;
END $$;
DROP POLICY IF EXISTS prompt_owner_update ON prompt_records;
```

- [ ] **Step 4: server service의 실패 테스트를 작성한다**

Fake DB query recorder로 다음을 각각 검증한다.

```ts
test("legacy page는 승인된 browser만 읽고 SHA-256 digest를 반환한다", async () => {
  const page = await getLegacyMigrationPage(userId, browserId, kek, 25, db);
  assert.equal(page.records[0]?.text, "legacy secret");
  assert.equal(page.records[0]?.sourceDigest, sha256Base64Url("legacy secret"));
  assert.match(db.queries[0]!.sql, /approved_at IS NOT NULL/);
  assert.match(db.queries[0]!.sql, /revoked_at IS NULL/);
});

test("commit은 digest 불일치 시 UPDATE 없이 배치 전체를 거부한다", async () => {
  await assert.rejects(
    commitLegacyMigrationBatch(userId, browserId, [{ ...item, sourceDigest: wrong }], kek, db),
    (error: LegacyMigrationError) => error.code === "LEGACY_SOURCE_CHANGED",
  );
  assert.equal(db.queries.some((query) => /^UPDATE prompt_records/.test(query.sql)), false);
});
```

- [ ] **Step 5: server service 테스트가 모듈 부재로 실패하는지 실행한다**

Run: `pnpm --filter @toard/web exec node --import tsx --test lib/e2ee-legacy-migration.test.ts`

Expected: `ERR_MODULE_NOT_FOUND`로 FAIL.

- [ ] **Step 6: status와 승인 브라우저 검증을 구현한다**

```ts
export async function getLegacyMigrationStatus(userId: string, kekAvailable: boolean, db?: LegacyMigrationDb) {
  const result = await runInContext(userId, db, (tx) => tx.query(
    `SELECT account.content_owner_id, account.active_key_version,
            COUNT(record.id) FILTER (WHERE record.encryption_scheme='server_v1') AS legacy_records,
            COUNT(record.id) FILTER (WHERE record.encryption_scheme='e2ee_v1') AS e2ee_records
       FROM content_accounts account
       LEFT JOIN prompt_records record ON record.user_id=account.user_id
      WHERE account.user_id=$1 AND account.state='active'
      GROUP BY account.content_owner_id, account.active_key_version`,
    [userId],
  ));
  const row = requiredRow(result.rows[0]);
  const legacyRecords = count(row.legacy_records);
  return {
    state: legacyRecords === 0 ? "complete" : kekAvailable ? "pending" : "blocked",
    contentOwnerId: string(row.content_owner_id),
    contentKeyVersion: positiveInt(row.active_key_version),
    legacyRecords,
    e2eeRecords: count(row.e2ee_records),
    totalRecords: legacyRecords + count(row.e2ee_records),
  } as const;
}
```

`assertApprovedBrowser`는 `content_accounts.state='active'`, `content_devices.kind='browser'`, `approved_at IS NOT NULL`, `revoked_at IS NULL`과 user/device 일치를 한 query로 확인한다.

- [ ] **Step 7: page 조회와 원문 digest를 구현한다**

`id ASC LIMIT $3`로 `server_v1` 행만 읽는다. `decryptContent`에 `key_version`, `wrapped_dek`, `iv`, `ciphertext`, `auth_tag`를 전달하고 `createHash("sha256").update(text, "utf8").digest("base64url")`로 digest를 계산한다. 본문과 digest는 반환값에만 존재하며 DB나 로그에 쓰지 않는다.

- [ ] **Step 8: commit의 원자적 동일 행 UPDATE를 구현한다**

각 항목에 대해 `SELECT ... FOR UPDATE` 후 원본 digest와 immutable metadata를 검증하고 아래 UPDATE를 수행한다.

```sql
UPDATE prompt_records
SET key_version=$3,
    wrapped_dek=$4,
    iv=$5,
    ciphertext=$6,
    auth_tag=$7,
    encryption_scheme='e2ee_v1',
    content_owner_id=$8,
    content_key_version=$3,
    dek_wrap_iv=$9,
    dek_wrap_auth_tag=$10,
    aad_version=1
WHERE id=$1 AND user_id=$2 AND encryption_scheme='server_v1'
```

이미 `e2ee_v1`인 동일 ID는 `alreadyMigrated`로 세고 성공 처리한다. 다른 사용자, 다른 owner/key version, metadata 불일치, 손상된 legacy ciphertext는 코드가 있는 `LegacyMigrationError`로 거부한다.

- [ ] **Step 9: Task 2 테스트를 통과시킨다**

Run: `pnpm --filter @toard/web exec node --import tsx --test lib/e2ee-legacy-migration.test.ts && node --import tsx --test scripts/e2ee-content-migration.integration.test.ts`

Expected: service unit tests와 PostgreSQL RLS/Down guard test PASS.

- [ ] **Step 10: Task 2를 커밋한다**

```bash
git add apps/web/lib/e2ee-legacy-migration.ts apps/web/lib/e2ee-legacy-migration.test.ts migrations/1700000030_e2ee_content_foundation.sql scripts/e2ee-content-migration.integration.test.ts
git commit -m "feat(security): 기존 기록 원자적 E2EE 전환 추가"
```

### Task 3: migration API와 활성 계정 legacy write 차단

**Files:**
- Create: `apps/web/app/api/content/legacy-migration/status/route.ts`
- Create: `apps/web/app/api/content/legacy-migration/page/route.ts`
- Create: `apps/web/app/api/content/legacy-migration/commit/route.ts`
- Create: `apps/web/app/api/content/legacy-migration/routes.test.ts`
- Modify: `apps/web/app/api/v1/prompts/route.ts`
- Modify: `apps/web/app/api/v1/prompts/route.test.ts`
- Modify: `apps/web/lib/content-accounts.ts`
- Modify: `apps/web/lib/content-accounts.test.ts`
- Modify: `apps/web/lib/content-api-security.test.ts`

**Interfaces:**
- Consumes: Task 2 service, `requireContentSession`, `isContentAuthOpen`, `loadKek`.
- Produces: three authenticated `no-store` endpoints and `isE2eeContentActive(userId, db?)` dependency for ingest route.

- [ ] **Step 1: route 보안 실패 테스트를 작성한다**

```ts
test("legacy migration routes reject open mode with no-store", async () => {
  process.env.AUTH_MODE = "open";
  for (const response of await Promise.all([
    statusGet(new Request("http://localhost/api/content/legacy-migration/status")),
    pageGet(new Request("http://localhost/api/content/legacy-migration/page")),
    commitPost(new Request("http://localhost/api/content/legacy-migration/commit", { method: "POST" })),
  ])) {
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});
```

승인되지 않은 device, 잘못된 limit, invalid commit body, KEK 누락의 상태 코드도 각각 테스트한다.

- [ ] **Step 2: route 테스트가 모듈 부재로 실패하는지 실행한다**

Run: `pnpm --filter @toard/web exec node --import tsx --test app/api/content/legacy-migration/routes.test.ts`

Expected: route import 실패.

- [ ] **Step 3: status/page/commit route를 구현한다**

공통 순서는 다음과 같다.

```ts
if (isContentAuthOpen()) return problem(403, "E2EE_AUTH_REQUIRED");
const userId = await requireContentSession();
if (!userId) return problem(401, "UNAUTHORIZED");
```

page/commit은 `X-Toard-Content-Device-Id`가 없으면 `400 CONTENT_DEVICE_REQUIRED`, 미승인/폐기 기기면 `403 CONTENT_DEVICE_UNAPPROVED`를 반환한다. 모든 성공·실패 응답에 `Cache-Control: no-store`를 설정한다. KEK가 없으면 status는 `blocked`, page/commit은 `503 LEGACY_KEK_UNAVAILABLE`를 반환한다.

- [ ] **Step 4: legacy write 차단 실패 테스트를 작성한다**

```ts
test("active E2EE account rejects new server_v1 prompt writes", async () => {
  let saved = 0;
  const handler = POST.withDependencies({
    authenticateIngestToken: auth,
    loadProviders: providers,
    isE2eeContentActive: async () => true,
    savePromptRecords: async () => { saved += 1; return { inserted: 1, deduped: 0 }; },
  });
  const response = await handler(legacyRequest);
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { code: "E2EE_REQUIRED" });
  assert.equal(saved, 0);
});
```

- [ ] **Step 5: ingest test가 기존 200 응답으로 실패하는지 실행한다**

Run: `pnpm --filter @toard/web exec node --import tsx --test app/api/v1/prompts/route.test.ts`

Expected: expected 409, actual 200으로 FAIL.

- [ ] **Step 6: 활성 계정 확인과 409 차단을 구현한다**

`apps/web/lib/content-accounts.ts`에 `isE2eeContentActive(userId, db?)`를 추가하고 `content_accounts.state='active'` 존재 여부를 RLS context에서 읽는다. `PromptsPostDeps`에 이 함수를 추가한다. `e2ee_v1` 경로는 이 조회를 하지 않고 기존대로 저장한다. `server_v1` 경로는 KEK를 읽기 전에 활성 계정을 확인하고 true면 JSON `409 E2EE_REQUIRED`를 반환한다.

- [ ] **Step 7: Task 3 테스트와 타입 검사를 통과시킨다**

Run: `pnpm --filter @toard/web exec node --import tsx --test app/api/content/legacy-migration/routes.test.ts app/api/v1/prompts/route.test.ts lib/content-accounts.test.ts lib/content-api-security.test.ts && pnpm --filter @toard/web typecheck`

Expected: 관련 route/security tests PASS, TypeScript error 0.

- [ ] **Step 8: Task 3을 커밋한다**

```bash
git add apps/web/app/api/content/legacy-migration apps/web/app/api/v1/prompts/route.ts apps/web/app/api/v1/prompts/route.test.ts apps/web/lib/content-accounts.ts apps/web/lib/content-accounts.test.ts apps/web/lib/content-api-security.test.ts
git commit -m "feat(api): 기존 기록 자동 전환 API 추가"
```

### Task 4: 브라우저 자동 migration worker

**Files:**
- Create: `apps/web/lib/e2ee-legacy-worker.ts`
- Create: `apps/web/lib/e2ee-legacy-worker.test.ts`
- Modify: `apps/web/app/(dashboard)/history/e2ee-history-client.tsx`

**Interfaces:**
- Consumes: `encryptE2eeRecord`, `decryptE2eeRecord`, `contentKeyVault.withUnlockedUck`, Task 3 APIs.
- Produces: `runLegacyMigrationBatch(input)`와 visible/online 기반 자동 반복 실행.

- [ ] **Step 1: worker 실패 테스트를 작성한다**

```ts
test("worker는 25건을 암호화·round-trip한 뒤 한 번 commit한다", async () => {
  const calls: string[] = [];
  const result = await runLegacyMigrationBatch({
    deviceId,
    contentOwnerId: ownerId,
    contentKeyVersion: 1,
    uck,
    fetchJson: async (url, init) => {
      calls.push(url);
      if (url.endsWith("/page?limit=25")) return { records: [source] };
      if (url.endsWith("/commit")) return { migrated: 1, alreadyMigrated: 0 };
      throw new Error("unexpected URL");
    },
  });
  assert.equal(result.migrated, 1);
  assert.deepEqual(calls, [pageUrl, commitUrl]);
});
```

round-trip 실패 시 commit 미호출, empty page 완료, AbortSignal 중단도 별도 테스트한다.

- [ ] **Step 2: worker 테스트가 모듈 부재로 실패하는지 실행한다**

Run: `pnpm --filter @toard/web exec node --import tsx --test lib/e2ee-legacy-worker.test.ts`

Expected: `ERR_MODULE_NOT_FOUND`로 FAIL.

- [ ] **Step 3: 한 batch 실행기를 구현한다**

```ts
export async function runLegacyMigrationBatch(input: LegacyWorkerInput) {
  const page = await input.fetchJson<{ records: LegacyMigrationSource[] }>(
    "/api/content/legacy-migration/page?limit=25",
    { headers: { "X-Toard-Content-Device-Id": input.deviceId }, signal: input.signal },
  );
  if (page.records.length === 0) return { migrated: 0, alreadyMigrated: 0, complete: true };
  const items = [];
  for (const source of page.records) {
    const record = await encryptE2eeRecord(input.uck, source, input.contentOwnerId, input.contentKeyVersion);
    const check = await decryptE2eeRecord(input.uck, record);
    if (!bytesEqual(check, new TextEncoder().encode(source.text))) throw new Error("LEGACY_ROUND_TRIP_FAILED");
    items.push({ id: source.id, sourceDigest: source.sourceDigest, record });
  }
  const result = await input.fetchJson<CommitResult>(commitUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Toard-Content-Device-Id": input.deviceId },
    body: JSON.stringify({ items }),
    signal: input.signal,
  });
  return { ...result, complete: false };
}
```

함수 종료 전 source 배열 참조를 버리고 원문을 로그에 포함하지 않는다.

- [ ] **Step 4: history client 자동 반복을 구현한다**

`state.kind === "unlocked"`, `document.visibilityState === "visible"`, `navigator.onLine`일 때 worker loop를 시작한다. 한 batch 후 250ms `setTimeout`으로 양보한다. hidden/offline/unmount에서는 `AbortController.abort()`로 멈춘다. 1·2·4초 backoff 세 번 실패 후 현재 mount에서는 정지하고 상태만 표시한다.

UCK는 장기 보관하지 않는다. 매 batch 직전에 `contentKeyVault.withUnlockedUck((uck) => uck.slice())`로 32바이트를 복사하고, worker 완료·중단·오류의 `finally`에서 `batchUck.fill(0)`으로 지운다. plaintext는 React state에 넣지 않는다. 각 batch 전 status API에서 `contentOwnerId`, `contentKeyVersion`, 남은 건수를 새로 읽어 다중 탭 진행률을 보정한다.

- [ ] **Step 5: Task 4 테스트와 타입 검사를 통과시킨다**

Run: `pnpm --filter @toard/web exec node --import tsx --test lib/e2ee-legacy-worker.test.ts && pnpm --filter @toard/web typecheck`

Expected: worker tests PASS, TypeScript error 0.

- [ ] **Step 6: Task 4를 커밋한다**

```bash
git add apps/web/lib/e2ee-legacy-worker.ts apps/web/lib/e2ee-legacy-worker.test.ts apps/web/app/'(dashboard)'/history/e2ee-history-client.tsx
git commit -m "feat(history): 기존 기록 자동 E2EE 전환 실행"
```

### Task 5: 승인된 브라우저 자동 재잠금 해제

**Files:**
- Create: `apps/web/lib/content-auto-unlock.ts`
- Create: `apps/web/lib/content-auto-unlock.test.ts`
- Modify: `apps/web/app/(dashboard)/history/e2ee-history-client.tsx`
- Modify: `apps/web/app/(dashboard)/history/locked-history.tsx`
- Modify: `apps/web/app/(dashboard)/history/e2ee-history-state.ts`
- Modify: `apps/web/app/(dashboard)/history/e2ee-history-state.test.ts`

**Interfaces:**
- Consumes: `contentKeyVault.loadDevice`, `openDeviceEnvelope`, device wrapper API.
- Produces: `unlockApprovedBrowser(fetchJson)`와 외부 승인 없는 `이 브라우저에서 잠금 해제` UI.

- [ ] **Step 1: 자동 unlock 실패 테스트를 작성한다**

```ts
test("stored approved device unwraps UCK without approval request", async () => {
  const result = await unlockApprovedBrowser({
    loadDevice: async () => storedDevice,
    loadWrapper: async (id) => wrapper,
    openEnvelope: async () => uck,
  });
  assert.equal(result?.deviceId, storedDevice.serverDeviceId);
  assert.deepEqual(result?.uck, uck);
});

test("missing local device returns null", async () => {
  assert.equal(await unlockApprovedBrowser({ ...deps, loadDevice: async () => null }), null);
});
```

- [ ] **Step 2: auto-unlock test가 모듈 부재로 실패하는지 실행한다**

Run: `pnpm --filter @toard/web exec node --import tsx --test lib/content-auto-unlock.test.ts`

Expected: `ERR_MODULE_NOT_FOUND`로 FAIL.

- [ ] **Step 3: auto-unlock helper를 구현한다**

```ts
export async function unlockApprovedBrowser(deps: AutoUnlockDeps): Promise<AutoUnlockResult | null> {
  const device = await deps.loadDevice();
  if (!device) return null;
  const wrapper = await deps.loadWrapper(device.serverDeviceId);
  const uck = await deps.openEnvelope(device.keyPair, {
    algorithm: "hpke-p256-hkdf-sha256-aes256gcm-v1",
    encapsulatedKey: wrapper.encapsulatedKey!,
    ciphertext: wrapper.wrappedContentKey,
  });
  return { deviceId: device.serverDeviceId, uck };
}
```

- [ ] **Step 4: reducer와 잠금 화면의 로컬 unlock 실패 테스트를 작성한다**

`lock` action에 `reason: "manual" | "hidden"`을 추가하고, 로컬 기기가 있으면 `canLocalUnlock=true`를 보존한다. `LockedHistory`는 `canLocalUnlock`일 때 첫 버튼을 `이 브라우저에서 잠금 해제`로 렌더링하고 shim 승인 버튼은 로컬 키가 없거나 로컬 unlock 실패 때만 표시한다.

- [ ] **Step 5: state test가 새 필드 부재로 실패하는지 실행한다**

Run: `pnpm --filter @toard/web exec node --import tsx --test app/'(dashboard)'/history/e2ee-history-state.test.ts`

Expected: `canLocalUnlock` assertion에서 FAIL.

- [ ] **Step 6: 초기·visible·manual unlock 흐름을 통합한다**

- mount: `unlockApprovedBrowser`를 자동 호출한다.
- hidden 15분: UCK와 화면 평문을 지우고 `reason="hidden"`으로 잠근다.
- visible 복귀: hidden lock이면 자동 호출한다.
- `지금 잠그기`: `reason="manual"`로 잠그고 자동 호출하지 않는다.
- 로컬 unlock 버튼: 같은 helper를 호출하며 shim 승인을 만들지 않는다.
- 로그아웃/unmount: 메모리 UCK를 지운다.

- [ ] **Step 7: Task 5 테스트와 타입 검사를 통과시킨다**

Run: `pnpm --filter @toard/web exec node --import tsx --test lib/content-auto-unlock.test.ts app/'(dashboard)'/history/e2ee-history-state.test.ts && pnpm --filter @toard/web typecheck`

Expected: tests PASS, TypeScript error 0.

- [ ] **Step 8: Task 5를 커밋한다**

```bash
git add apps/web/lib/content-auto-unlock.ts apps/web/lib/content-auto-unlock.test.ts apps/web/app/'(dashboard)'/history/e2ee-history-client.tsx apps/web/app/'(dashboard)'/history/locked-history.tsx apps/web/app/'(dashboard)'/history/e2ee-history-state.ts apps/web/app/'(dashboard)'/history/e2ee-history-state.test.ts
git commit -m "fix(history): 승인된 브라우저 반복 인증 제거"
```

### Task 6: 진행 상태 UI와 운영 문서

**Files:**
- Modify: `apps/web/app/(dashboard)/history/e2ee-history-client.tsx`
- Modify: `apps/web/app/(dashboard)/settings/history-security-panel.tsx`
- Modify: `apps/web/messages/ko/dashboard.json`
- Modify: `apps/web/messages/en/dashboard.json`
- Modify: `apps/web/messages/ko/settings.json`
- Modify: `apps/web/messages/en/settings.json`
- Modify: `docs/e2ee-prompt-history-runbook.md`
- Modify: `SECURITY.md`
- Modify: `apps/web/lib/ui-commonization.test.ts`

**Interfaces:**
- Consumes: legacy migration status API and worker state.
- Produces: non-blocking remaining-count UI and operator rollout/KEK retirement procedure.

- [ ] **Step 1: locale/UI 실패 테스트를 추가한다**

```ts
test("legacy migration 상태 문구는 ko/en에 모두 존재한다", () => {
  for (const messages of [koDashboard, enDashboard]) {
    assert.equal(typeof messages.history.e2ee.legacyProtecting, "string");
    assert.equal(typeof messages.history.e2ee.legacyComplete, "string");
    assert.equal(typeof messages.history.e2ee.legacyBlocked, "string");
    assert.equal(typeof messages.history.e2ee.unlockThisBrowser, "string");
  }
});
```

- [ ] **Step 2: UI test가 번역 키 부재로 실패하는지 실행한다**

Run: `pnpm --filter @toard/web exec node --import tsx --test lib/ui-commonization.test.ts`

Expected: missing translation key assertion으로 FAIL.

- [ ] **Step 3: history의 non-blocking 상태를 구현한다**

worker가 실행 중이면 `기존 기록 보호 중 · {count}건 남음`, 0건이면 `모든 기록이 E2EE로 보호됨`, backoff 종료면 `기존 기록 보호 일시 중단 · 자동으로 다시 시도합니다`, KEK 누락이면 `관리자 확인 필요`를 작은 badge/description으로 표시한다. 모달과 페이지 이탈 경고는 추가하지 않는다.

- [ ] **Step 4: 설정 보안 패널에 잔여 건수를 추가한다**

기존 account/device query와 별도로 같은 RLS transaction에서 `prompt_records`의 scheme별 count를 집계한다. 레거시가 남으면 운영자가 서버 복호화 가능하다는 설명을 유지하고, 0건이면 전체 보호 완료를 표시한다.

- [ ] **Step 5: 런북과 SECURITY 정책을 갱신한다**

다음을 명시한다.

- E2EE 활성 이후 `server_v1` 409는 정상적인 구형 shim 차단이다.
- 자동 전환은 승인 브라우저가 잠금 해제·visible·online일 때만 진행한다.
- `TOARD_CONTENT_KEK_B64`는 전체 legacy 0건 및 백업 보존 기간 종료 전 제거하지 않는다.
- E2EE 행 생성 이후 migration 30 Down을 실행하지 않고 forward-fix한다.
- 확인 SQL은 scheme별 count만 출력하고 본문이나 ciphertext를 출력하지 않는다.

- [ ] **Step 6: Task 6 테스트와 타입 검사를 통과시킨다**

Run: `pnpm --filter @toard/web exec node --import tsx --test lib/ui-commonization.test.ts && pnpm --filter @toard/web typecheck`

Expected: locale/UI tests PASS, TypeScript error 0.

- [ ] **Step 7: Task 6을 커밋한다**

```bash
git add apps/web/app/'(dashboard)'/history/e2ee-history-client.tsx apps/web/app/'(dashboard)'/settings/history-security-panel.tsx apps/web/messages docs/e2ee-prompt-history-runbook.md SECURITY.md apps/web/lib/ui-commonization.test.ts
git commit -m "feat(settings): 기존 기록 보호 상태 표시"
```

### Task 7: 실제 PostgreSQL end-to-end 전환 검증

**Files:**
- Create: `scripts/e2ee-legacy-migration.integration.test.ts`
- Modify: `package.json`
- Modify: `docs/e2ee-prompt-history-runbook.md`

**Interfaces:**
- Consumes: migrations 1/10/28, server migration service, browser encryption writer.
- Produces: pre-existing legacy canary가 동일 PK E2EE 행으로 전환되고 plaintext/legacy row가 사라지는 release gate.

- [ ] **Step 1: 실제 DB 실패 통합 테스트를 작성한다**

테스트는 임시 PostgreSQL 16 컨테이너를 만들고 migration 1/10까지만 적용한 후 `LEGACY_MIGRATION_CANARY_91d7` 평문으로 `server_v1` 행을 저장한다. migration 30 적용 후 실제 service와 browser writer를 호출한다.

```ts
const before = await client.query("SELECT id,dedup_key FROM prompt_records WHERE dedup_key=$1", [dedup]);
const source = (await getLegacyMigrationPage(userId, browserId, kek, 25, db)).records[0]!;
const record = await encryptE2eeRecord(uck, source, ownerId, 1);
await commitLegacyMigrationBatch(userId, browserId, [{ id: source.id, sourceDigest: source.sourceDigest, record }], kek, db);
const after = await client.query("SELECT id,dedup_key,encryption_scheme,content_owner_id FROM prompt_records WHERE dedup_key=$1", [dedup]);
assert.equal(after.rows[0].id, before.rows[0].id);
assert.equal(after.rows[0].encryption_scheme, "e2ee_v1");
assert.equal((await client.query("SELECT COUNT(*) FROM prompt_records WHERE encryption_scheme='server_v1'")).rows[0].count, "0");
assert.equal(JSON.stringify((await client.query("SELECT * FROM prompt_records")).rows).includes("LEGACY_MIGRATION_CANARY_91d7"), false);
```

`finally`에서 컨테이너를 항상 제거한다.

- [ ] **Step 2: 통합 테스트가 아직 없는 service/API 결함을 드러내는지 실행한다**

Run: `TSX_TSCONFIG_PATH=apps/web/tsconfig.json node --import tsx --test scripts/e2ee-legacy-migration.integration.test.ts`

Expected: 실제 경로의 누락 또는 잘못된 RLS/SQL이 있으면 FAIL; 구현이 완전하면 PASS.

- [ ] **Step 3: 통합 테스트가 발견한 최소 결함만 수정한다**

수정 범위는 Task 1~6 파일로 제한하고, 테스트를 약화하거나 DB를 superuser 전용 경로로 우회하지 않는다.

- [ ] **Step 4: package release gate에 통합 테스트를 연결한다**

root `package.json`의 migration test script가 새 파일도 실행하도록 추가한다. 기존 test script 이름을 깨지 않는다.

- [ ] **Step 5: 전체 검증을 새로 실행한다**

Run:

```bash
cargo test --manifest-path shim/rust/Cargo.toml
pnpm --filter @toard/web test
pnpm --filter @toard/web typecheck
pnpm --filter @toard/web build
pnpm test:migrations
TSX_TSCONFIG_PATH=apps/web/tsconfig.json node --import tsx --test \
  scripts/e2ee-content-migration.integration.test.ts \
  scripts/e2ee-ciphertext-only.integration.test.ts \
  scripts/e2ee-legacy-migration.integration.test.ts
git diff --check
```

Expected: 모든 명령 exit 0, 임시 Docker 컨테이너 0개, plaintext canary DB scan 0건.

- [ ] **Step 6: Task 7을 커밋한다**

```bash
git add scripts/e2ee-legacy-migration.integration.test.ts package.json docs/e2ee-prompt-history-runbook.md
git commit -m "test(security): 기존 기록 E2EE 전환 통합 검증"
```

### Task 8: 최종 범위·보안 검토

**Files:**
- Review: all files changed by Tasks 1-7

**Interfaces:**
- Consumes: completed implementation and fresh verification outputs.
- Produces: clean worktree-ready branch with documented residual limitations.

- [ ] **Step 1: plaintext leakage 정적 검사를 실행한다**

Run:

```bash
rg -n "console\.(log|error)|logger\.|JSON\.stringify\(.*text|source\.text" \
  apps/web/lib/e2ee-legacy-* \
  apps/web/app/api/content/legacy-migration \
  apps/web/app/'(dashboard)'/history/e2ee-history-client.tsx
```

Expected: plaintext를 로그에 전달하는 호출 0건. 암호화 입력과 비교 코드의 `source.text` 참조만 허용.

- [ ] **Step 2: API 응답 캐시와 auth 경계를 확인한다**

Run: `pnpm --filter @toard/web exec node --import tsx --test lib/content-api-security.test.ts app/api/content/legacy-migration/routes.test.ts`

Expected: open/unauthenticated/unapproved device가 차단되고 모든 응답에 `no-store` 존재.

- [ ] **Step 3: git 상태와 변경 범위를 확인한다**

Run: `git status --short && git diff --check && git log --oneline --max-count=12`

Expected: 추적되지 않은 임시 파일 없음, whitespace 오류 없음, Task별 커밋 존재.

- [ ] **Step 4: 남은 한계를 handoff에 기록한다**

최종 보고에는 Passkey PRF, UCK 회전, Recovery Kit 재발급, 사용자 보존 기간, 계정 탈퇴 삭제, backup 자동 삭제가 이번 범위 밖임을 명시한다. 브라우저 visual runtime 검증이 불가능하면 자동 테스트와 분리해 사실대로 보고한다.
