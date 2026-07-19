# Late Unpriced Ingest Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 가격 동기화가 끝난 뒤 늦게 저장된 `unpriced` 사용량도 PostgreSQL과 ClickHouse에서 durable 가격 복구 작업을 자동 예약한다.

**Architecture:** PostgreSQL singleton 상태에 `queued_target_to`를 추가하고 migration이 제공하는 `enqueue_pricing_repair(timestamptz)` 함수로 저장 transaction과 복구 예약을 결합한다. 현재 worker가 실행 중이면 generation을 교체하지 않고 queue watermark를 병합하며, ClickHouse는 raw insert 성공 후 outbox delivery를 확정하는 transaction에서만 예약한다.

**Tech Stack:** TypeScript, Node.js test runner, PostgreSQL 16 SQL migration, `pg`, ClickHouse outbox, pnpm 9.15.0

## Global Constraints

- 실제로 새로 저장된 `unpriced` 이벤트가 있는 batch만 복구를 예약한다.
- PostgreSQL usage insert와 enqueue는 같은 transaction이어야 한다.
- ClickHouse enqueue는 raw insert 성공 후 delivery 확정 transaction 안에서 실행한다.
- 실행 중인 worker generation과 retry backoff를 신규 수집이 초기화하지 않는다.
- 가격 source, historical pricing 알고리즘, rollup 공정성, 조직 타임존 기본값은 변경하지 않는다.
- migration은 기존 82건을 위해 업그레이드 시 one-shot 복구 요청을 만든다.
- `corepack pnpm`을 사용한다.

---

## File Map

- Create `migrations/1700000041_late_unpriced_ingest_repair.sql`: queue 컬럼, 공통 enqueue 함수, 업그레이드 one-shot, down migration.
- Create `scripts/pricing-late-ingest-repair-migration.integration.test.ts`: 실제 PostgreSQL에서 함수와 migration 상태 전이를 검증.
- Modify `package.json`: 신규 migration integration test를 `test:migrations`에 등록.
- Modify `apps/web/lib/pricing-repair.ts`: claim과 progress 저장 시 queued watermark 병합.
- Modify `apps/web/lib/pricing-repair.test.ts`: 실행 중 enqueue를 모사한 repository SQL 전이 회귀 테스트.
- Modify `packages/storage-postgres/src/storage.ts`: 새 unpriced insert batch의 transaction 내 enqueue.
- Modify `packages/storage-postgres/src/storage.test.ts`: inserted/deduped/status별 enqueue와 rollback 계약.
- Modify `packages/storage-clickhouse/src/storage.ts`: 성공한 outbox delivery의 unpriced batch enqueue.
- Modify `packages/storage-clickhouse/src/storage.test.ts`: delivery 전 미예약, delivery 후 예약, 실패 재시도 계약.

---

### Task 1: Durable enqueue schema and migration

**Files:**
- Create: `scripts/pricing-late-ingest-repair-migration.integration.test.ts`
- Create: `migrations/1700000041_late_unpriced_ingest_repair.sql`
- Modify: `package.json`

**Interfaces:**
- Produces: SQL function `enqueue_pricing_repair(requested_to TIMESTAMPTZ) RETURNS VOID`
- Produces: nullable `pricing_repair_status.queued_target_to TIMESTAMPTZ`
- Consumes: migration 27의 singleton `pricing_repair_status`

- [ ] **Step 1: Write the failing migration integration test**

새 PostgreSQL 16 container에 migration 27, 28, 32를 적용한 뒤 다음 시나리오를 검증한다.

```ts
await applyUpMigration(client, "1700000041_late_unpriced_ingest_repair.sql");

const upgraded = await client.query(`
  SELECT state, generation::text, target_to, queued_target_to
  FROM pricing_repair_status WHERE singleton
`);
assert.equal(upgraded.rows[0].state, "pending");
assert.ok(upgraded.rows[0].generation);
assert.ok(upgraded.rows[0].target_to);
assert.equal(upgraded.rows[0].queued_target_to, null);

await client.query(`
  UPDATE pricing_repair_status
  SET generation = '2026-07-19 09:00:00+00',
      state = 'running', target_to = '2026-07-19 09:01:00+00',
      next_attempt_at = '2026-07-19 10:00:00+00'
  WHERE singleton
`);
await client.query("SELECT enqueue_pricing_repair($1)", [new Date("2026-07-19T09:02:00Z")]);
await client.query("SELECT enqueue_pricing_repair($1)", [new Date("2026-07-19T09:01:30Z")]);

const running = await client.query(`
  SELECT state, generation::text, target_to, queued_target_to, next_attempt_at
  FROM pricing_repair_status WHERE singleton
`);
assert.equal(running.rows[0].state, "running");
assert.match(running.rows[0].generation, /^2026-07-19 09:00:00/);
assert.equal(running.rows[0].target_to.toISOString(), "2026-07-19T09:01:00.000Z");
assert.equal(running.rows[0].queued_target_to.toISOString(), "2026-07-19T09:02:00.000Z");
assert.equal(running.rows[0].next_attempt_at.toISOString(), "2026-07-19T10:00:00.000Z");
```

`idle` 상태에서는 호출 시 새 generation과 target을 만들고 수치와 오류를 초기화하는 케이스도 포함한다. `waiting_for_catalog`와 `failed`에서는 상태와 `next_attempt_at`을 보존하고 queue만 확장하는 케이스를 포함한다.

- [ ] **Step 2: Run the new test and verify RED**

Run:

```bash
TSX_TSCONFIG_PATH=apps/web/tsconfig.json node --import tsx --test --test-concurrency=1 scripts/pricing-late-ingest-repair-migration.integration.test.ts
```

Expected: FAIL because `migrations/1700000041_late_unpriced_ingest_repair.sql` does not exist.

- [ ] **Step 3: Implement migration 41**

Up migration의 핵심은 다음과 같다.

```sql
ALTER TABLE pricing_repair_status
  ADD COLUMN queued_target_to TIMESTAMPTZ;

CREATE FUNCTION enqueue_pricing_repair(requested_to TIMESTAMPTZ)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE pricing_repair_status
  SET generation = CASE
        WHEN state = 'idle' OR generation IS NULL OR target_to IS NULL THEN requested_to
        ELSE generation
      END,
      state = CASE
        WHEN state = 'idle' OR generation IS NULL OR target_to IS NULL THEN 'pending'
        ELSE state
      END,
      target_to = CASE
        WHEN state = 'idle' OR generation IS NULL OR target_to IS NULL THEN requested_to
        ELSE target_to
      END,
      queued_target_to = CASE
        WHEN state = 'idle' OR generation IS NULL OR target_to IS NULL THEN NULL
        ELSE GREATEST(COALESCE(queued_target_to, requested_to), requested_to)
      END,
      processed_events = CASE WHEN state = 'idle' OR generation IS NULL OR target_to IS NULL THEN 0 ELSE processed_events END,
      recovered_events = CASE WHEN state = 'idle' OR generation IS NULL OR target_to IS NULL THEN 0 ELSE recovered_events END,
      reconciled_events = CASE WHEN state = 'idle' OR generation IS NULL OR target_to IS NULL THEN 0 ELSE reconciled_events END,
      repriced_legacy_events = CASE WHEN state = 'idle' OR generation IS NULL OR target_to IS NULL THEN 0 ELSE repriced_legacy_events END,
      remaining_unpriced_events = CASE WHEN state = 'idle' OR generation IS NULL OR target_to IS NULL THEN 0 ELSE remaining_unpriced_events END,
      remaining_legacy_events = CASE WHEN state = 'idle' OR generation IS NULL OR target_to IS NULL THEN 0 ELSE remaining_legacy_events END,
      unresolved_models = CASE WHEN state = 'idle' OR generation IS NULL OR target_to IS NULL THEN '[]'::jsonb ELSE unresolved_models END,
      eligible_since = CASE WHEN state = 'idle' OR generation IS NULL OR target_to IS NULL THEN requested_to ELSE eligible_since END,
      next_attempt_at = CASE WHEN state = 'idle' OR generation IS NULL OR target_to IS NULL THEN requested_to ELSE next_attempt_at END,
      consecutive_failures = CASE WHEN state = 'idle' OR generation IS NULL OR target_to IS NULL THEN 0 ELSE consecutive_failures END,
      last_error = CASE WHEN state = 'idle' OR generation IS NULL OR target_to IS NULL THEN NULL ELSE last_error END,
      updated_at = GREATEST(updated_at, requested_to)
  WHERE singleton;
END;
$$;

SELECT enqueue_pricing_repair(clock_timestamp());
```

Down migration은 `DROP FUNCTION enqueue_pricing_repair(TIMESTAMPTZ)` 후 컬럼을 제거한다. `package.json`의 `test:migrations` 명령에 새 test file을 추가한다.

- [ ] **Step 4: Run migration test and verify GREEN**

Run the Step 2 command.

Expected: one test passes, zero failures.

- [ ] **Step 5: Commit schema task**

```bash
git add migrations/1700000041_late_unpriced_ingest_repair.sql scripts/pricing-late-ingest-repair-migration.integration.test.ts package.json
git commit -m "feat(pricing): queue late unpriced repair requests"
```

---

### Task 2: Merge queued requests in the pricing worker

**Files:**
- Modify: `apps/web/lib/pricing-repair.test.ts`
- Modify: `apps/web/lib/pricing-repair.ts`

**Interfaces:**
- Consumes: `pricing_repair_status.queued_target_to`
- Produces: `claim()` returns the merged `targetTo`
- Produces: `markProgress()` preserves a concurrent request by leaving the status `pending`

- [ ] **Step 1: Write failing repository tests**

실제 PostgreSQL integration은 Task 1 script에 다음 repository 시나리오를 추가하거나, query-client fixture를 사용하는 기존 pricing repair test에 SQL shape 검증을 추가한다.

```ts
await client.query(`
  UPDATE pricing_repair_status
  SET state = 'pending', generation = $1, target_to = $2,
      queued_target_to = $3, eligible_since = $1, next_attempt_at = $1
  WHERE singleton
`, [generation, firstTarget, queuedTarget]);

const claimed = await repository.claim(claimAt);
assert.equal(claimed?.targetTo?.toISOString(), queuedTarget.toISOString());

await client.query("SELECT enqueue_pricing_repair($1)", [concurrentTarget]);
assert.equal(await repository.markProgress({
  generation: claimed!.generation!, state: "idle", processed: 0,
  recovered: 0, reconciled: 0, repricedLegacy: 0,
  remaining: 0, remainingLegacy: 0, unresolvedModels: [],
  adaptiveLimit: 100, loadState: "normal", nextAttemptAt: null, at: progressAt,
}), true);

const status = await client.query(`
  SELECT state, target_to, queued_target_to, next_attempt_at
  FROM pricing_repair_status WHERE singleton
`);
assert.equal(status.rows[0].state, "pending");
assert.equal(status.rows[0].target_to.toISOString(), concurrentTarget.toISOString());
assert.equal(status.rows[0].queued_target_to, null);
assert.equal(status.rows[0].next_attempt_at.toISOString(), progressAt.toISOString());
```

- [ ] **Step 2: Run focused tests and verify RED**

```bash
corepack pnpm --filter @toard/web test -- --test-name-pattern="pricing repair|가격 복구"
TSX_TSCONFIG_PATH=apps/web/tsconfig.json node --import tsx --test --test-concurrency=1 scripts/pricing-late-ingest-repair-migration.integration.test.ts
```

Expected: queue merge assertion fails because `claim` and `markProgress` ignore `queued_target_to`.

- [ ] **Step 3: Implement queue merge SQL**

`claim` update에 다음 assignment를 추가한다.

```sql
target_to = GREATEST(target_to, queued_target_to),
queued_target_to = NULL
```

PostgreSQL `GREATEST`는 nullable argument를 무시하므로 queue가 없으면 기존 target이 유지된다.

`markProgress`는 old row의 queue 존재 여부를 사용해 동시에 다음 값을 정한다.

```sql
state = CASE WHEN queued_target_to IS NOT NULL THEN 'pending' ELSE $2 END,
target_to = GREATEST(target_to, queued_target_to),
eligible_since = CASE
  WHEN queued_target_to IS NOT NULL OR $2 = 'pending' THEN COALESCE(eligible_since, $10)
  ELSE NULL
END,
next_attempt_at = CASE WHEN queued_target_to IS NOT NULL THEN $10 ELSE $13 END,
queued_target_to = NULL
```

generation exact-match 조건과 누적 진행 수치는 유지한다. `markFailed`는 queue column을 수정하지 않는다.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run both Step 2 commands.

Expected: all focused tests pass.

- [ ] **Step 5: Commit worker task**

```bash
git add apps/web/lib/pricing-repair.ts apps/web/lib/pricing-repair.test.ts scripts/pricing-late-ingest-repair-migration.integration.test.ts
git commit -m "fix(pricing): merge repair requests during active work"
```

---

### Task 3: Enqueue new PostgreSQL unpriced events atomically

**Files:**
- Modify: `packages/storage-postgres/src/storage.test.ts`
- Modify: `packages/storage-postgres/src/storage.ts`

**Interfaces:**
- Consumes: `enqueue_pricing_repair(clock_timestamp())`
- Preserves: `StorageBackend.saveUsageEvents(events): Promise<SaveResult>`

- [ ] **Step 1: Write failing storage tests**

query fixture에서 usage insert별 `rowCount`를 제어하고 호출 SQL을 기록한다.

```ts
await storage.saveUsageEvents([
  finalizedEvent({ dedupKey: "priced", costStatus: "priced" }),
  finalizedEvent({ dedupKey: "late", costStatus: "unpriced", pricingRevisionId: null }),
  finalizedEvent({ dedupKey: "duplicate", costStatus: "unpriced", pricingRevisionId: null }),
]);

assert.equal(
  calls.filter(({ sql }) => sql.includes("enqueue_pricing_repair")).length,
  1,
);
assert.ok(calls.find(({ sql }) => sql === "COMMIT"));
```

`duplicate` insert fixture는 `rowCount: 0`을 반환한다. 별도 test에서 priced/legacy/deduped-unpriced만 전달하면 enqueue 호출이 0인지 확인한다. enqueue query가 throw하면 `ROLLBACK`이 실행되고 `saveUsageEvents`가 reject되는지 확인한다.

- [ ] **Step 2: Run PostgreSQL storage tests and verify RED**

```bash
corepack pnpm --filter @toard/storage-postgres test
```

Expected: new enqueue count assertion fails with 0.

- [ ] **Step 3: Implement one enqueue per inserted batch**

`saveUsageEvents` loop에서 실제 insert만 추적한다.

```ts
let inserted = 0;
let insertedUnpriced = false;
for (const e of events) {
  const r = await client.query(
    `INSERT INTO usage_events
       (dedup_key, provider_key, user_id, team_id, session_id, model, ts,
        input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd,
        log_adapter, host, pricing_revision_id, cost_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (dedup_key) DO NOTHING`,
    [
      e.dedupKey, e.providerKey, e.userId,
      e.userId ? (deptMap.get(e.userId) ?? null) : null,
      e.sessionId, e.model, e.ts,
      e.inputTokens, e.outputTokens, e.cacheReadTokens, e.cacheCreationTokens, e.costUsd,
      e.logAdapter ?? null, e.host ?? null, e.pricingRevisionId, e.costStatus,
    ],
  );
  if (r.rowCount === 1) {
    inserted++;
    insertedUnpriced ||= e.costStatus === "unpriced";
    if (e.userId) await this.bumpDailyUser(client, e);
  }
}
if (insertedUnpriced) {
  await client.query("SELECT enqueue_pricing_repair(clock_timestamp())");
}
await client.query("COMMIT");
```

- [ ] **Step 4: Run PostgreSQL storage tests and verify GREEN**

Run the Step 2 command.

Expected: all package tests pass.

- [ ] **Step 5: Commit PostgreSQL task**

```bash
git add packages/storage-postgres/src/storage.ts packages/storage-postgres/src/storage.test.ts
git commit -m "fix(storage): enqueue repair for late postgres usage"
```

---

### Task 4: Enqueue delivered ClickHouse unpriced events

**Files:**
- Modify: `packages/storage-clickhouse/src/storage.test.ts`
- Modify: `packages/storage-clickhouse/src/storage.ts`

**Interfaces:**
- Consumes: outbox rows selected by `flushUsageOutbox`
- Consumes: `enqueue_pricing_repair(clock_timestamp())`
- Preserves: deterministic ClickHouse batch insert token and outbox retry behavior

- [ ] **Step 1: Write failing ClickHouse delivery tests**

기존 `storageWithInsertedRows` fixture의 query log를 사용한다.

```ts
await storage.saveUsageEvents([
  finalizedEvent({ dedupKey: "late", costStatus: "unpriced", pricingRevisionId: null }),
]);

const enqueueCalls = pgQueries.filter(({ sql }) => sql.includes("enqueue_pricing_repair"));
assert.equal(enqueueCalls.length, 1);
const enqueueIndex = pgQueries.findIndex(({ sql }) => sql.includes("enqueue_pricing_repair"));
const deliveryIndex = pgQueries.findIndex(({ sql }) => sql.includes("SET delivered_at = now()"));
assert.ok(enqueueIndex > deliveryIndex);
```

priced/legacy batch는 enqueue하지 않는 test를 추가한다. enqueue query가 throw하면 batch status를 `pending`으로 되돌리는 update가 실행되고 method가 reject되는 test를 추가한다. ClickHouse insert가 throw한 경우 enqueue 호출이 0인지 확인한다.

- [ ] **Step 2: Run ClickHouse storage tests and verify RED**

```bash
corepack pnpm --filter @toard/storage-clickhouse test
```

Expected: new enqueue count assertion fails with 0.

- [ ] **Step 3: Implement enqueue in delivery transaction**

`insertOutboxRows` 성공 후 시작하는 PostgreSQL transaction에서 delivery updates와 함께 다음 조건을 추가한다.

```ts
await client.query("BEGIN");
await this.mark15mRollupDirty(client, batchRows.rows);
await client.query(
  `UPDATE clickhouse_usage_outbox
   SET delivered_at = now()
   WHERE batch_id = $1`,
  [batch.id],
);
await client.query(
  `UPDATE clickhouse_usage_batches
   SET status = 'delivered', delivered_at = now(), locked_at = NULL,
       last_error = NULL, updated_at = now()
   WHERE id = $1`,
  [batch.id],
);
if (batchRows.rows.some((row) => row.cost_status === "unpriced")) {
  await client.query("SELECT enqueue_pricing_repair(clock_timestamp())");
}
await client.query("COMMIT");
```

enqueue는 ClickHouse insert보다 뒤이고 commit보다 앞이어야 한다. catch의 rollback 및 batch pending 복귀는 그대로 유지한다.

- [ ] **Step 4: Run ClickHouse storage tests and verify GREEN**

Run the Step 2 command.

Expected: all package tests pass.

- [ ] **Step 5: Commit ClickHouse task**

```bash
git add packages/storage-clickhouse/src/storage.ts packages/storage-clickhouse/src/storage.test.ts
git commit -m "fix(storage): enqueue repair after clickhouse delivery"
```

---

### Task 5: Full regression verification

**Files:**
- Modify only if a verification failure exposes a bug in Tasks 1-4.

**Interfaces:**
- Consumes all previous task outputs.
- Produces release-ready evidence; no new behavior.

- [ ] **Step 1: Run focused suites together**

```bash
corepack pnpm --filter @toard/storage-postgres test
corepack pnpm --filter @toard/storage-clickhouse test
corepack pnpm --filter @toard/web test
TSX_TSCONFIG_PATH=apps/web/tsconfig.json node --import tsx --test --test-concurrency=1 scripts/pricing-late-ingest-repair-migration.integration.test.ts
```

Expected: zero failed tests.

- [ ] **Step 2: Run project verification**

```bash
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
git diff --check origin/main...HEAD
```

Expected: every command exits 0.

- [ ] **Step 3: Review the final diff against the design**

```bash
git status --short
git diff --stat origin/main...HEAD
git diff origin/main...HEAD -- \
  migrations/1700000041_late_unpriced_ingest_repair.sql \
  apps/web/lib/pricing-repair.ts \
  packages/storage-postgres/src/storage.ts \
  packages/storage-clickhouse/src/storage.ts
```

Confirm: no API route duplication, no pricing source changes, no timezone changes, no reset of running generation.

- [ ] **Step 4: Commit any verification-only correction**

If and only if Step 1 or 2 required a correction, stage only that correction and commit with a scoped `fix:` message. Otherwise do not create an empty commit.
