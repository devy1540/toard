# Managed Content Migrations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 기존 `server_v1`과 복구 가능한 `e2ee_v1` 행을 동일 PK의 `managed_v1`로 전환하고, 공급자 변경 시 사용자 UCK wrapper만 안전하게 재래핑한다.

**Architecture:** `server_v1`은 legacy KEK와 active KMS 권한을 가진 전용 content-admin 프로세스가 사용자 RLS context별로 batch 전환한다. `e2ee_v1`은 승인된 브라우저가 로컬 UCK로 복호화해 HTTPS로 평문 batch를 제출하고 서버가 즉시 managed 암호화한다. provider migration은 active와 migration provider를 동시에 로드해 pending wrapper를 검증한 뒤 사용자별로 승격한다.

**Tech Stack:** Next.js 15, React 19, TypeScript 5.7, PostgreSQL 16 RLS, Web Crypto, Node `crypto`, Node test runner, Docker integration tests.

## Global Constraints

- schema migration/seed 프로세스에는 KMS decrypt 권한을 주지 않는다.
- 별도 content-admin 프로세스만 앱 runtime과 같은 최소 wrap/unwrap 권한을 일시적으로 사용한다.
- 기존 행을 삭제·복제하지 않고 같은 `prompt_records.id`를 원자 UPDATE한다.
- 전환 실패 시 원래 scheme과 ciphertext가 그대로 남아야 한다.
- 배치는 최대 25건, JSON body는 최대 4MiB다.
- `server_v1` source digest는 legacy 평문 SHA-256과 metadata를 결합해 계산한다.
- `e2ee_v1` source digest는 서버가 가진 ciphertext와 metadata만으로 계산한다.
- 브라우저가 제출한 E2EE 평문은 응답, 로그, telemetry, DB 임시 컬럼에 남기지 않는다.
- E2EE 키가 없는 사용자는 명시 확인 후 `blocked`로 표시하고 ciphertext를 보존한다.
- blocked 상태는 나중에 Recovery Kit를 찾으면 `pending`으로 되돌릴 수 있다.
- provider 전환은 본문 ciphertext와 레코드 DEK wrapper를 변경하지 않는다.
- old provider wrapper는 유예 기간 동안 `retiring`으로 보존한다.
- provider 전환 완료 전 active 또는 migration provider 설정을 제거하지 않는다.

---

## File Structure

- `migrations/1700000036_managed_content_migration_state.sql`: E2EE migration state와 content account `migrated`.
- `scripts/managed-content-state-migration.integration.test.ts`: 상태·RLS·rollback guard 통합 테스트.
- `apps/web/lib/server-content-migration.ts`: `server_v1` → `managed_v1` batch.
- `apps/web/lib/e2ee-to-managed-contract.ts`: browser plaintext commit strict wire.
- `apps/web/lib/e2ee-to-managed-migration.ts`: status/page/commit/block/resume service.
- `apps/web/app/api/content/managed-migration/*`: 사용자 migration API.
- `apps/web/lib/e2ee-to-managed-worker.ts`: 브라우저 decrypt+commit 반복 worker.
- `apps/web/app/(dashboard)/history/e2ee-history-client.tsx`: migration progress와 완료 refresh.
- `apps/web/lib/provider-rewrap.ts`: active→pending→verified→active wrapper state machine.
- `scripts/toard-admin.ts`: server migration과 provider rewrap CLI.

---

### Task 1: E2EE migration 상태 모델

**Files:**
- Create: `migrations/1700000036_managed_content_migration_state.sql`
- Create: `scripts/managed-content-state-migration.integration.test.ts`
- Modify: `package.json`

**Interfaces:**
- Extends `content_accounts.state` to `pending | active | migrated`.
- Produces `content_e2ee_migrations(user_id, state, started_at, completed_at, blocked_at, blocked_reason, last_error_code, updated_at)`.
- Extends `content_encryption_status` with `e2ee_migration_pending`, `e2ee_migration_blocked`.

- [ ] **Step 1: 상태 migration 실패 테스트를 작성한다**

```ts
test("E2EE migration state is owner-scoped and preserves blocked rows", { timeout: 90_000 }, async () => {
  await client.query("BEGIN");
  await client.query("SELECT set_config('app.current_user_id', $1, true)", [userA]);
  await client.query(
    `INSERT INTO content_e2ee_migrations(user_id,state,blocked_reason)
     VALUES($1,'blocked','key_unavailable')`,
    [userA],
  );
  assert.equal((await client.query("SELECT user_id FROM content_e2ee_migrations")).rowCount, 1);
  await client.query("ROLLBACK");

  await client.query("UPDATE content_accounts SET state='migrated' WHERE user_id=$1", [userA]);
  assert.equal(
    (await client.query("SELECT state FROM content_accounts WHERE user_id=$1", [userA])).rows[0].state,
    "migrated",
  );
});
```

- [ ] **Step 2: migration 파일 부재로 실패하는지 확인한다**

Run: `node --import tsx --test scripts/managed-content-state-migration.integration.test.ts`

Expected: FAIL with `ENOENT ... 1700000036_managed_content_migration_state.sql`.

- [ ] **Step 3: additive migration을 구현한다**

```sql
ALTER TABLE content_accounts DROP CONSTRAINT content_accounts_state_check;
ALTER TABLE content_accounts
  ADD CONSTRAINT content_accounts_state_check
  CHECK (state IN ('pending','active','migrated'));

CREATE TABLE content_e2ee_migrations (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','running','blocked','complete')),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  blocked_at TIMESTAMPTZ,
  blocked_reason TEXT CHECK (blocked_reason IS NULL OR blocked_reason='key_unavailable'),
  last_error_code TEXT CHECK (last_error_code IS NULL OR char_length(last_error_code) <= 80),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((state='blocked') = (blocked_at IS NOT NULL)),
  CHECK ((state='complete') = (completed_at IS NOT NULL))
);

INSERT INTO content_e2ee_migrations(user_id,state)
SELECT account.user_id,
       CASE WHEN EXISTS (
         SELECT 1 FROM prompt_records record
         WHERE record.user_id=account.user_id AND record.encryption_scheme='e2ee_v1'
       ) THEN 'pending' ELSE 'complete' END
FROM content_accounts account
WHERE account.state='active';
```

`content_encryption_status`에는 `e2ee_migration_pending`, `e2ee_migration_blocked` BIGINT 컬럼을 추가한다. pending 집계는 `state IN ('pending','running')`, blocked 집계는 `state='blocked'`로 초기 계산한다. migration state INSERT/UPDATE/DELETE trigger가 두 숫자만 증감한다. `content_e2ee_migrations`에는 owner SELECT/INSERT/UPDATE RLS를 적용한다. Down은 `state IN ('running','blocked')`, `content_accounts.state='migrated'`, 또는 `managed_v1`로 바뀐 과거 E2EE 행이 있으면 실패한다.

- [ ] **Step 4: migration 통합 테스트를 통과시킨다**

Run: `node --import tsx --test scripts/managed-content-state-migration.integration.test.ts && pnpm test:migrations`

Expected: new migration PASS, 전체 migration suite PASS.

- [ ] **Step 5: Task 1을 커밋한다**

```bash
git add migrations/1700000036_managed_content_migration_state.sql scripts/managed-content-state-migration.integration.test.ts package.json
git commit -m "feat(security): E2EE managed 전환 상태 추가"
```

---

### Task 2: `server_v1` 서버 측 batch 전환

**Files:**
- Create: `apps/web/lib/server-content-migration.ts`
- Create: `apps/web/lib/server-content-migration.test.ts`
- Create: `scripts/server-content-migration.integration.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces `migrateServerContentBatch(userId, limit, runtime, legacyKek, db?)`.
- Produces `getServerContentMigrationUsers(db): Promise<string[]>`.

- [ ] **Step 1: batch 원자성 실패 테스트를 작성한다**

```ts
test("server_v1 batch keeps same id and becomes managed_v1", async () => {
  const result = await migrateServerContentBatch(USER_ID, 25, runtime, LEGACY_KEK, db);
  assert.deepEqual(result, { migrated: 1, remaining: 0 });
  const update = db.calls.find((call) => /UPDATE prompt_records/.test(call.sql))!;
  assert.match(update.sql, /WHERE id=\\$1 AND user_id=\\$2 AND encryption_scheme='server_v1'/);
  assert.equal(update.params[0], "41");
  assert.equal(update.params.includes("legacy secret"), false);
});

test("corrupt legacy row rolls back the whole batch", async () => {
  await assert.rejects(
    migrateServerContentBatch(USER_ID, 25, runtime, LEGACY_KEK, corruptDb),
    /LEGACY_SOURCE_CORRUPT/,
  );
  assert.equal(corruptDb.commits, 0);
  assert.equal(corruptDb.rollbacks, 1);
});
```

- [ ] **Step 2: service 부재로 실패하는지 확인한다**

Run: `pnpm --filter @toard/web exec node --import tsx --test lib/server-content-migration.test.ts`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: batch service를 구현한다**

```ts
export async function migrateServerContentBatch(
  userId: string,
  limit: number,
  runtime: ManagedContentRuntime,
  legacyKek: Buffer,
  db?: ServerMigrationDb,
): Promise<{ migrated: number; remaining: number }> {
  const bounded = Math.min(25, Math.max(1, Math.trunc(limit)));
  return runtime.userKeys.withActiveUserKey(userId, async (uck, keyVersion) =>
    runUserTransaction(userId, db, async (tx) => {
      const source = await tx.query(
        `SELECT id,dedup_key,session_id,provider_key,turn_role,ts,key_version,
                wrapped_dek,iv,ciphertext,auth_tag
           FROM prompt_records
          WHERE user_id=$1 AND encryption_scheme='server_v1'
          ORDER BY id ASC
          LIMIT $2
          FOR UPDATE SKIP LOCKED`,
        [userId, bounded],
      );
      for (const row of source.rows) {
        const text = decryptLegacyMigrationRow(row, legacyKek);
        const record = toPromptRecord(row, text);
        const sourceDigest = serverSourceDigest(record);
        const encrypted = encryptManagedContent(
          record, uck, runtime.installationId, userId, keyVersion,
        );
        const roundTripText = decryptManagedContent(
          { ...record, ...encrypted },
          uck,
          runtime.installationId,
          userId,
        );
        if (!timingSafeEqual(
          sourceDigest,
          serverSourceDigest({ ...record, text: roundTripText }),
        )) {
          throw new Error("MANAGED_ROUND_TRIP_FAILED");
        }
        await updateSameRow(tx, row.id, userId, encrypted);
      }
      const remaining = await tx.query(
        `SELECT COUNT(*)::int AS count FROM prompt_records
          WHERE user_id=$1 AND encryption_scheme='server_v1'`,
        [userId],
      );
      return { migrated: source.rows.length, remaining: remaining.rows[0]!.count };
    }),
  );
}
```

`serverSourceDigest`는 canonical record metadata와 UTF-8 평문을 SHA-256한다. `server_v1` source는 `FOR UPDATE` 잠금 안에서만 복호화하고 managed round-trip digest 검증이 끝난 뒤 UPDATE한다. `updateSameRow`는 managed shape 컬럼을 모두 채우고 `content_owner_id=NULL`, `aad_version=2`로 설정한다. source row가 이미 바뀌면 rowCount 0을 `SOURCE_CHANGED`로 처리해 transaction을 rollback한다.

- [ ] **Step 4: 실제 PostgreSQL 원자 전환 통합 테스트를 추가한다**

통합 테스트는 migrations 1, 10, 30, 31, 35를 적용하고 legacy canary 행을 넣은 뒤 service를 실행한다.

```ts
assert.equal(after.id, before.id);
assert.equal(after.dedup_key, before.dedup_key);
assert.equal(after.encryption_scheme, "managed_v1");
assert.equal(await decryptManagedFixture(after, runtime), "legacy canary");
assert.equal(serverRemaining, 0);
```

- [ ] **Step 5: unit/integration tests와 typecheck를 통과시킨다**

Run: `pnpm --filter @toard/web exec node --import tsx --test lib/server-content-migration.test.ts && node --import tsx --test scripts/server-content-migration.integration.test.ts && pnpm --filter @toard/web typecheck`

Expected: tests PASS, TypeScript error 0.

- [ ] **Step 6: Task 2를 커밋한다**

```bash
git add apps/web/lib/server-content-migration.ts apps/web/lib/server-content-migration.test.ts scripts/server-content-migration.integration.test.ts package.json
git commit -m "feat(security): server_v1 managed 전환 service 추가"
```

---

### Task 3: E2EE→managed wire, service, API

**Files:**
- Create: `apps/web/lib/e2ee-to-managed-contract.ts`
- Create: `apps/web/lib/e2ee-to-managed-contract.test.ts`
- Create: `apps/web/lib/e2ee-to-managed-migration.ts`
- Create: `apps/web/lib/e2ee-to-managed-migration.test.ts`
- Create: `apps/web/app/api/content/managed-migration/status/route.ts`
- Create: `apps/web/app/api/content/managed-migration/page/route.ts`
- Create: `apps/web/app/api/content/managed-migration/commit/route.ts`
- Create: `apps/web/app/api/content/managed-migration/state/route.ts`
- Create: `apps/web/app/api/content/managed-migration/routes.test.ts`

**Interfaces:**
- Produces `E2eeManagedMigrationSource`.
- Produces `parseE2eeManagedCommit(value): E2eeManagedCommitItem[]`.
- Produces `getE2eeManagedMigrationStatus`, `getE2eeManagedMigrationPage`, `commitE2eeManagedBatch`, `setE2eeManagedMigrationState`.

- [ ] **Step 1: plaintext commit strict parser 실패 테스트를 작성한다**

```ts
test("commit parser limits records and strips plaintext from errors", () => {
  assert.throws(
    () => parseE2eeManagedCommit({ items: Array(26).fill(VALID_ITEM) }),
    /1~25/,
  );
  try {
    parseE2eeManagedCommit({ items: [{ ...VALID_ITEM, text: "" }] });
    assert.fail("expected failure");
  } catch (error) {
    assert.equal(String(error).includes(VALID_ITEM.text), false);
  }
});
```

- [ ] **Step 2: source digest와 state 실패 테스트를 작성한다**

```ts
test("commit verifies ciphertext digest and replaces same row", async () => {
  const result = await commitE2eeManagedBatch(USER_ID, [VALID_ITEM], runtime, db);
  assert.deepEqual(result, { migrated: 1, remaining: 0, complete: true });
  assert.match(db.calls.find((call) => /UPDATE prompt_records/.test(call.sql))!.sql,
    /encryption_scheme='e2ee_v1'/);
});

test("blocked state requires explicit key_unavailable confirmation", async () => {
  await assert.rejects(
    setE2eeManagedMigrationState(USER_ID, { action: "block", confirmation: "wrong" }, db),
    /BLOCK_CONFIRMATION_REQUIRED/,
  );
});
```

- [ ] **Step 3: tests가 모듈 부재로 실패하는지 확인한다**

Run: `pnpm --filter @toard/web exec node --import tsx --test lib/e2ee-to-managed-contract.test.ts lib/e2ee-to-managed-migration.test.ts`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 4: migration wire를 구현한다**

```ts
export type E2eeManagedMigrationSource = {
  id: string;
  sourceDigest: string;
  record: E2eePromptRecordWire;
};

export type E2eeManagedCommitItem = {
  id: string;
  sourceDigest: string;
  text: string;
};

export function parseE2eeManagedCommit(value: unknown): E2eeManagedCommitItem[] {
  const input = exactObject(value, ["items"]);
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 25) {
    throw new MigrationContractError("migration items는 1~25건이어야 합니다");
  }
  return input.items.map((raw) => {
    const item = exactObject(raw, ["id", "sourceDigest", "text"]);
    return {
      id: positiveDecimal(item.id),
      sourceDigest: base64urlDigest(item.sourceDigest),
      text: boundedText(item.text, 1_048_576),
    };
  });
}
```

- [ ] **Step 5: page와 commit service를 구현한다**

```ts
export async function getE2eeManagedMigrationPage(
  userId: string,
  limit = 25,
  db?: MigrationDb,
): Promise<{ records: E2eeManagedMigrationSource[] }> {
  return runInContext(userId, db, async (tx) => {
    const rows = await tx.query(
      `SELECT id,dedup_key,session_id,provider_key,turn_role,ts,content_owner_id,
              content_key_version,wrapped_dek,dek_wrap_iv,dek_wrap_auth_tag,
              iv,ciphertext,auth_tag,aad_version
         FROM prompt_records
        WHERE user_id=$1 AND encryption_scheme='e2ee_v1'
        ORDER BY id ASC LIMIT $2`,
      [userId, Math.min(25, Math.max(1, limit))],
    );
    return { records: rows.rows.map(toMigrationSource) };
  });
}
```

```ts
export async function commitE2eeManagedBatch(
  userId: string,
  rawItems: E2eeManagedCommitItem[],
  runtime: ManagedContentRuntime,
  db?: MigrationDb,
) {
  const items = parseE2eeManagedCommit({ items: rawItems });
  return runtime.userKeys.withActiveUserKey(userId, async (uck, keyVersion) =>
    runInContext(userId, db, async (tx) => {
      await markRunning(tx, userId);
      for (const item of items) {
        const source = await lockE2eeRow(tx, userId, item.id);
        if (!timingSafeDigestEqual(e2eeSourceDigest(source), item.sourceDigest)) {
          throw new E2eeManagedMigrationError("E2EE_SOURCE_CHANGED");
        }
        const encrypted = encryptManagedContent(
          toPromptRecord(source, item.text),
          uck,
          runtime.installationId,
          userId,
          keyVersion,
        );
        await replaceE2eeRow(tx, userId, item.id, encrypted);
      }
      return finishOrCount(tx, userId, items.length);
    }),
  );
}
```

`e2eeSourceDigest`는 plaintext 없이 canonical metadata와 모든 E2EE ciphertext bytes를 SHA-256한다. `finishOrCount`에서 remaining 0이면 migration `complete`, `content_accounts.state='migrated'`로 바꾼다.

- [ ] **Step 6: block/resume state를 구현한다**

```ts
if (input.action === "block") {
  if (input.confirmation !== "KEY_UNAVAILABLE") {
    throw new E2eeManagedMigrationError("BLOCK_CONFIRMATION_REQUIRED");
  }
  await tx.query(
    `UPDATE content_e2ee_migrations
        SET state='blocked', blocked_at=now(), blocked_reason='key_unavailable',
            last_error_code=NULL, updated_at=now()
      WHERE user_id=$1 AND state<>'complete'`,
    [userId],
  );
} else {
  await tx.query(
    `UPDATE content_e2ee_migrations
        SET state='pending', blocked_at=NULL, blocked_reason=NULL,
            last_error_code=NULL, updated_at=now()
      WHERE user_id=$1 AND state='blocked'`,
    [userId],
  );
}
```

- [ ] **Step 7: API routes에 session gate, no-store, 4MiB limit를 적용한다**

모든 route는 `requireContentSession()`으로 실제 로그인 사용자를 얻고 `AUTH_MODE=open`을 403으로 거부한다. page/status/state/commit 응답은 `Cache-Control:no-store`다. commit error mapping은 code만 JSON으로 반환하고 plaintext나 원본 exception을 반환하지 않는다.

- [ ] **Step 8: contract/service/route tests와 typecheck를 통과시킨다**

Run: `pnpm --filter @toard/web exec node --import tsx --test lib/e2ee-to-managed-contract.test.ts lib/e2ee-to-managed-migration.test.ts app/api/content/managed-migration/routes.test.ts && pnpm --filter @toard/web typecheck`

Expected: tests PASS, TypeScript error 0.

- [ ] **Step 9: Task 3을 커밋한다**

```bash
git add apps/web/lib/e2ee-to-managed-contract.ts apps/web/lib/e2ee-to-managed-contract.test.ts apps/web/lib/e2ee-to-managed-migration.ts apps/web/lib/e2ee-to-managed-migration.test.ts apps/web/app/api/content/managed-migration
git commit -m "feat(security): E2EE에서 managed 전환 API 추가"
```

---

### Task 4: 브라우저 자동 전환과 blocked UX

**Files:**
- Create: `apps/web/lib/e2ee-to-managed-worker.ts`
- Create: `apps/web/lib/e2ee-to-managed-worker.test.ts`
- Create: `apps/web/app/(dashboard)/history/managed-migration-panel.tsx`
- Create: `apps/web/app/(dashboard)/history/managed-migration-panel.test.tsx`
- Modify: `apps/web/app/(dashboard)/history/e2ee-history-client.tsx`
- Modify: `apps/web/lib/e2ee-history.ts`
- Modify: `apps/web/messages/ko/dashboard.json`
- Modify: `apps/web/messages/en/dashboard.json`

**Interfaces:**
- Produces `runE2eeToManagedBatch(input)`.
- E2EE client refreshes server component after complete.
- Blocked user can preserve or resume migration.

- [ ] **Step 1: worker decrypt/commit 실패 테스트를 작성한다**

```ts
test("worker decrypts locally and sends only id digest plaintext", async () => {
  const result = await runE2eeToManagedBatch({ uck: UCK, fetchJson });
  assert.deepEqual(result, { migrated: 1, remaining: 0, complete: true, payloadBytes: 91 });
  const commit = requests.find((request) => request.url.endsWith("/commit"))!;
  const body = JSON.parse(commit.body);
  assert.deepEqual(Object.keys(body.items[0]).sort(), ["id", "sourceDigest", "text"]);
  assert.equal(body.items[0].text, "secret prompt");
  assert.equal(commit.body.includes(VALID_E2EE_RECORD.ciphertext), false);
});
```

- [ ] **Step 2: worker 테스트가 모듈 부재로 실패하는지 확인한다**

Run: `pnpm --filter @toard/web exec node --import tsx --test lib/e2ee-to-managed-worker.test.ts`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: worker를 구현한다**

```ts
export async function runE2eeToManagedBatch(input: WorkerInput) {
  const page = await input.fetchJson("/api/content/managed-migration/page?limit=25", {
    signal: input.signal,
  }) as { records: E2eeManagedMigrationSource[] };
  if (page.records.length === 0) {
    return { migrated: 0, remaining: 0, complete: true, payloadBytes: 0 };
  }
  const items = [];
  for (const source of page.records) {
    const bytes = await decryptE2eeRecord(input.uck, source.record);
    try {
      items.push({
        id: source.id,
        sourceDigest: source.sourceDigest,
        text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      });
    } finally {
      bytes.fill(0);
    }
  }
  return input.fetchJson("/api/content/managed-migration/commit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ items }),
    signal: input.signal,
  });
}
```

body가 4MiB를 넘기기 전에 마지막 item을 제외하고 commit한다. 한 item만으로 초과하면 `MIGRATION_ITEM_TOO_LARGE`를 표시하고 server row를 보존한다.

- [ ] **Step 4: E2EE history client에 resume loop를 연결한다**

UCK unlock 뒤 migration status가 `pending|running`이고 E2EE rows가 있으면 worker를 반복한다. 탭 hidden/offline/abort에서 현재 request 후 중단하고 visible/online에서 재개한다. complete이면 UCK를 memory vault에서 지우고 `router.refresh()`해 server-managed history로 전환한다.

```tsx
if (migration.state === "pending" || migration.state === "running") {
  return (
    <ManagedMigrationPanel
      migrated={migration.migratedRecords}
      remaining={migration.e2eeRecords}
      onBlock={markKeyUnavailable}
    />
  );
}
```

마이그레이션 중 새로고침하면 partial history를 섞어 pagination하지 않고 progress 화면에서 자동 재개한다. DB 행은 보존되며 완료 직후 전체 managed history가 다시 나타난다.

- [ ] **Step 5: blocked와 resume UI를 구현한다**

blocked panel은 본문을 보여줄 수 없음을 명시하고 ciphertext 보존을 기본으로 한다. `키를 다시 찾았습니다`는 state API `resume`, `복구할 수 없음으로 표시`는 확인 dialog에서 정확히 `KEY_UNAVAILABLE`를 제출한다. 삭제 기능은 제공하지 않는다.

- [ ] **Step 6: 기존 server→E2EE worker 자동 실행을 제거한다**

`e2ee-history-client.tsx`에서 `runLegacyMigrationBatch` 호출을 제거한다. `apps/web/lib/e2ee-legacy-worker.ts`와 API는 `server_v1` migration 운영 기간 동안 컴파일 호환으로 남기되 UI에서 더 이상 호출하지 않는다.

- [ ] **Step 7: browser tests와 typecheck를 통과시킨다**

Run: `pnpm --filter @toard/web exec node --import tsx --test lib/e2ee-to-managed-worker.test.ts app/'(dashboard)'/history/managed-migration-panel.test.tsx app/'(dashboard)'/history/e2ee-history-state.test.ts && pnpm --filter @toard/web typecheck`

Expected: tests PASS, TypeScript error 0.

- [ ] **Step 8: Task 4를 커밋한다**

```bash
git add apps/web/lib/e2ee-to-managed-worker.ts apps/web/lib/e2ee-to-managed-worker.test.ts apps/web/app/'(dashboard)'/history/managed-migration-panel.tsx apps/web/app/'(dashboard)'/history/managed-migration-panel.test.tsx apps/web/app/'(dashboard)'/history/e2ee-history-client.tsx apps/web/lib/e2ee-history.ts apps/web/messages/ko/dashboard.json apps/web/messages/en/dashboard.json
git commit -m "feat(history): E2EE 기록 managed 자동 전환 추가"
```

---

### Task 5: provider rewrap와 content-admin CLI

**Files:**
- Create: `apps/web/lib/provider-rewrap.ts`
- Create: `apps/web/lib/provider-rewrap.test.ts`
- Create: `scripts/toard-admin.ts`
- Create: `scripts/toard-admin.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces `rewrapUserKey(userId, runtime, db?)`.
- CLI commands:
  - `encryption migrate-server --batch-size 25`
  - `encryption rewrap-provider --from <name> --to <name>`
  - `encryption status`

- [ ] **Step 1: pending wrapper 검증과 rollback 실패 테스트를 작성한다**

```ts
test("rewrap verifies pending wrapper and promotes atomically", async () => {
  const result = await rewrapUserKey(USER_ID, runtime, db);
  assert.equal(result.state, "migrated");
  assert.deepEqual(providerCalls, ["old.unwrap", "new.wrap", "new.unwrap"]);
  assert.match(db.calls.find((call) => /state='retiring'/.test(call.sql))!.sql, /FOR UPDATE/);
});

test("new unwrap mismatch keeps old active", async () => {
  newProvider.unwrapResult = Buffer.alloc(32, 8);
  await assert.rejects(rewrapUserKey(USER_ID, runtime, db), /PENDING_WRAPPER_MISMATCH/);
  assert.equal(db.calls.some((call) => /state='retiring'/.test(call.sql)), false);
});
```

- [ ] **Step 2: rewrap service 부재로 실패하는지 확인한다**

Run: `pnpm --filter @toard/web exec node --import tsx --test lib/provider-rewrap.test.ts`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: rewrap state machine을 구현한다**

```ts
export async function rewrapUserKey(
  userId: string,
  runtime: ManagedContentRuntime,
  db?: RewrapDb,
): Promise<{ state: "already-current" | "migrated" }> {
  const active = await loadActiveWrapper(userId, db);
  const target = runtime.registry.migration;
  if (!target) throw new RewrapError("MIGRATION_PROVIDER_MISSING");
  if (active.providerFingerprint === target.fingerprint) {
    return { state: "already-current" };
  }
  const oldProvider = runtime.registry.resolveWrappedKey(toWrapped(active));
  const context = toKeyContext(runtime.installationId, active);
  const uck = await oldProvider.unwrapKey(toWrapped(active), context);
  try {
    const pending = await target.wrapKey(uck, context);
    const verified = await target.unwrapKey(pending, context);
    if (!timingSafeEqual(uck, verified)) throw new RewrapError("PENDING_WRAPPER_MISMATCH");
    await verifyManagedCanary(userId, active.keyVersion, uck, runtime, db);
    await promotePendingWrapper(userId, active, pending, db);
    runtime.userKeys.evict(userId, active.keyVersion, active.providerFingerprint);
    return { state: "migrated" };
  } finally {
    uck.fill(0);
  }
}
```

`promotePendingWrapper`는 user transaction에서 active row를 `FOR UPDATE`하고 fingerprint가 처음 읽은 값과 같은지 확인한 뒤 pending INSERT, old `retiring`, pending `active` 순서로 실행한다.

- [ ] **Step 4: CLI parser와 secret-safe 출력 테스트를 작성한다**

```ts
test("CLI accepts exact encryption subcommands and never prints env secrets", async () => {
  const output = await runCli(["encryption", "status"], deps);
  assert.match(output.stdout, /managedRecords/);
  assert.equal(output.stdout.includes(process.env.TOARD_CONTENT_KEK_B64 ?? "never"), false);
  assert.equal((await runCli(["encryption", "unknown"], deps)).exitCode, 2);
});
```

- [ ] **Step 5: CLI를 구현한다**

```ts
const [group, command, ...args] = argv;
if (group !== "encryption") return usage(2);
if (command === "migrate-server") return migrateAllServerRows(parseBatchSize(args));
if (command === "rewrap-provider") return rewrapAllUsers(parseProviderArgs(args));
if (command === "status") return printEncryptionStatus();
return usage(2);
```

`migrateAllServerRows`는 `users`를 ID 순서로 읽고 사용자별 batch를 remaining 0까지 실행한다. `rewrapAllUsers`는 old fingerprint가 active인 사용자만 반복하며 실패 사용자 ID와 safe code를 기록하고 다른 사용자를 계속한다. exit code는 전부 성공 0, 일부 실패 1, 사용법 오류 2다.

- [ ] **Step 6: root script를 추가한다**

```json
{
  "scripts": {
    "toard-admin": "TSX_TSCONFIG_PATH=apps/web/tsconfig.json node --import tsx scripts/toard-admin.ts"
  }
}
```

- [ ] **Step 7: rewrap/CLI tests와 typecheck를 통과시킨다**

Run: `pnpm --filter @toard/web exec node --import tsx --test lib/provider-rewrap.test.ts && node --import tsx --test scripts/toard-admin.test.ts && pnpm --filter @toard/web typecheck`

Expected: tests PASS, TypeScript error 0.

- [ ] **Step 8: Task 5를 커밋한다**

```bash
git add apps/web/lib/provider-rewrap.ts apps/web/lib/provider-rewrap.test.ts scripts/toard-admin.ts scripts/toard-admin.test.ts package.json
git commit -m "feat(ops): 콘텐츠 전환과 provider rewrap CLI 추가"
```

---

## Plan 4 Completion Gate

Run:

```bash
pnpm --filter @toard/web test
pnpm --filter @toard/web typecheck
pnpm test:migrations
node --import tsx --test scripts/server-content-migration.integration.test.ts
git diff --check HEAD~5
```

Expected:

- `server_v1` canary가 동일 id의 `managed_v1`로 바뀌고 평문이 일치한다.
- 승인·복구 가능한 E2EE 브라우저가 중단 후 남은 행부터 재개한다.
- 키가 없는 사용자는 blocked이고 E2EE ciphertext가 그대로 남는다.
- provider rewrap 뒤 본문 ciphertext와 `wrapped_dek` hash가 전후 동일하다.
- old provider를 제거하기 전까지 old wrapper가 `retiring`으로 남는다.
