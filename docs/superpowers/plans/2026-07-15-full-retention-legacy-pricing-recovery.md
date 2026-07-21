# Full-Retention Legacy Pricing Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reprice every retained `legacy` usage event that has authoritative historical LiteLLM evidence, rebuild affected rollups, and expose accurate completion and remaining counts.

**Architecture:** Generalize the unpriced-only storage contract so `unpriced`, `legacy`, and non-authoritative revision rows share identical read/write guards. Remove the 90-day history clamp, preserve unresolved legacy costs, and reuse the fair coordinator plus ClickHouse dirty fallback. Extend repair status and the admin card with separate legacy progress, then invalidate tagged insight caches once a generation settles.

**Tech Stack:** TypeScript 5.7, Node.js 20 test runner, Next.js 15, PostgreSQL 16, ClickHouse ReplacingMergeTree, pnpm 9.15, node-pg-migrate

## Global Constraints

- Reprice canonical events physically retained by each backend; do not impose the 90-day lower bound.
- Only an authoritative revision applicable at the event timestamp may replace a legacy cost.
- Preserve cost and `legacy` status when evidence or required metadata is missing.
- Never mutate authoritative `priced` rows.
- PostgreSQL batches are transactional; ClickHouse uses replacement inserts and dirty fallback.
- Do not update usage costs in migration SQL or touch production data manually.
- Preserve tokens, identity dimensions, timestamp, and event count.
- Do not log credentials or prompt/response bodies.

---

## File Map

- `migrations/1700000032_full_retention_legacy_pricing_recovery.sql`: durable legacy progress and automatic pending generation.
- `scripts/full-retention-legacy-pricing-migration.integration.test.ts`: PostgreSQL migration contract.
- `packages/core/src/storage.ts`: generalized recovery DTOs and methods.
- `packages/storage-postgres/src/storage.ts`: transactional legacy repricing.
- `packages/storage-clickhouse/src/storage.ts`: `FINAL` selection, replacement insert, dirty buckets.
- `apps/web/lib/pricing-history.ts`: history range without retention clamp.
- `apps/web/lib/pricing-repair.ts`: full-range orchestration and cache invalidation.
- `apps/web/lib/pricing-admin-status.ts`: admin DTO counters.
- `apps/web/app/(dashboard)/admin/pricing-panel.tsx`: progress rows.
- Corresponding `*.test.ts`, locale JSON, and root migration test script list.

---

### Task 1: Durable Legacy Progress

**Files:**
- Create: `migrations/1700000032_full_retention_legacy_pricing_recovery.sql`
- Create: `scripts/full-retention-legacy-pricing-migration.integration.test.ts`
- Modify: `package.json`
- Modify: `apps/web/lib/pricing-repair.ts`
- Test: `apps/web/lib/pricing-repair.test.ts`

**Interfaces:**
- Consumes: `pricing_repair_status` singleton and exact-text generation matching.
- Produces: DB columns `repriced_legacy_events`, `remaining_legacy_events`; status fields `repricedLegacyEvents`, `remainingLegacyEvents`; progress fields `repricedLegacy`, `remainingLegacy`.

- [ ] **Step 1: Write the failing migration test**

Apply migrations 27 through 29, then migration 32, and assert:

```ts
assert.equal(row.state, 'pending');
assert.equal(row.repriced_legacy_events, '0');
assert.equal(row.remaining_legacy_events, '0');
assert.notEqual(row.generation, null);
assert.notEqual(row.target_to, null);
```

Apply the down section and verify both columns disappear from `information_schema.columns`.

- [ ] **Step 2: Verify RED**

Run:

```bash
TSX_TSCONFIG_PATH=apps/web/tsconfig.json node --import tsx --test scripts/full-retention-legacy-pricing-migration.integration.test.ts
```

Expected: FAIL because migration 32 does not exist.

- [ ] **Step 3: Implement the additive migration**

```sql
ALTER TABLE pricing_repair_status
  ADD COLUMN repriced_legacy_events BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN remaining_legacy_events BIGINT NOT NULL DEFAULT 0;

UPDATE pricing_repair_status
SET generation = now(), state = 'pending', target_to = now(),
    processed_events = 0, recovered_events = 0, reconciled_events = 0,
    repriced_legacy_events = 0, remaining_unpriced_events = 0,
    remaining_legacy_events = 0, unresolved_models = '[]'::jsonb,
    eligible_since = now(), next_attempt_at = now(),
    consecutive_failures = 0, last_error = NULL, updated_at = now()
WHERE singleton;
```

The down section drops the two columns. Add the new script to root `test:migrations`.

- [ ] **Step 4: Write failing repository assertions**

Add both fields to fixture rows and assert `claim()` maps them. Assert `markProgress()` increments `repriced_legacy_events`, replaces `remaining_legacy_events`, and keeps `$1::timestamptz` generation matching.

- [ ] **Step 5: Verify repository RED**

```bash
pnpm --filter @toard/web exec node --import tsx --test lib/pricing-repair.test.ts
```

Expected: FAIL because the repository omits legacy progress.

- [ ] **Step 6: Implement repository mapping**

Add this pair to status and row types, `SELECT_FIELDS`, and mapping:

```ts
repricedLegacyEvents: number;
remainingLegacyEvents: number;
```

Add the batch-shaped pair to `PricingRepairProgress` and use it in progress SQL:

```ts
repricedLegacy: number;
remainingLegacy: number;
```

- [ ] **Step 7: Verify GREEN and commit**

Run Steps 2 and 5; both must pass. Then:

```bash
git add migrations/1700000032_full_retention_legacy_pricing_recovery.sql scripts/full-retention-legacy-pricing-migration.integration.test.ts package.json apps/web/lib/pricing-repair.ts apps/web/lib/pricing-repair.test.ts
git commit -m 'feat(pricing): 레거시 가격 복구 진행률 추가'
```

---

### Task 2: Generalized Contract and PostgreSQL Recovery

**Files:**
- Modify: `packages/core/src/storage.ts`
- Modify: `packages/storage-postgres/src/storage.ts`
- Modify: `packages/storage-postgres/src/storage.test.ts`
- Modify: `apps/web/lib/pricing-repair.ts`
- Modify: `apps/web/lib/pricing-repair.test.ts`

**Interfaces:**
- Produces:

```ts
export interface PricingRecoveryModelDiagnostic {
  model: string | null;
  events: number;
  unpricedEvents: number;
  legacyEvents: number;
  firstAt: Date;
  lastAt: Date;
}

export interface PricingRecoveryBatchResult {
  scanned: number;
  recovered: number;
  repricedLegacy: number;
  affectedBuckets: Date[];
  hasMore: boolean;
}
```

- [ ] **Step 1: Write failing PostgreSQL diagnostics test**

Return `unpriced_events = 2` and `legacy_events = 3`. Assert split mapping and SQL containing:

```sql
cost_status IN ('unpriced', 'legacy')
OR pricing_revision_id = ANY($3::uuid[])
```

- [ ] **Step 2: Write failing PostgreSQL repair test**

Return one unpriced and one legacy locked row, resolve both, and assert:

```ts
assert.deepEqual(result, {
  scanned: 2,
  recovered: 1,
  repricedLegacy: 1,
  affectedBuckets: [new Date('2026-07-01T00:00:00.000Z')],
  hasMore: false,
});
```

The select and update guard must use the same target condition. The legacy update replaces cost, revision, and status together.

- [ ] **Step 3: Verify RED**

```bash
pnpm --filter @toard/storage-postgres test
```

Expected: FAIL because legacy is not a recovery candidate.

- [ ] **Step 4: Generalize the core API**

Replace old method names with:

```ts
getPricingRecoveryModels(
  from: Date,
  to: Date,
  replaceRevisionIds?: string[],
): Promise<PricingRecoveryModelDiagnostic[]>;

repairPricingUsage(
  request: PricingRepairRequest,
  resolver: PricingRepairResolver,
): Promise<PricingRecoveryBatchResult>;
```

- [ ] **Step 5: Implement PostgreSQL recovery**

Select `cost_status` with each event, keep `FOR UPDATE SKIP LOCKED`, increment `repricedLegacy` only for a pre-update legacy row, otherwise increment `recovered`, and recompute only affected local days in the same transaction. Resolver failure leaves the row untouched.

- [ ] **Step 6: Update web worker test doubles**

Replace the old method names in web tests and return `unpricedEvents` and `legacyEvents` from every diagnostic fixture.

- [ ] **Step 7: Verify GREEN and commit**

```bash
pnpm --filter @toard/storage-postgres test
pnpm --filter @toard/core typecheck
pnpm --filter @toard/web exec node --import tsx --test lib/pricing-repair.test.ts
git add packages/core/src/storage.ts packages/storage-postgres/src/storage.ts packages/storage-postgres/src/storage.test.ts apps/web/lib/pricing-repair.ts apps/web/lib/pricing-repair.test.ts
git commit -m 'feat(pricing): PostgreSQL 레거시 비용을 복구 대상으로 확장'
```

---

### Task 3: ClickHouse Legacy Replacement

**Files:**
- Modify: `packages/storage-clickhouse/src/storage.ts`
- Modify: `packages/storage-clickhouse/src/storage.test.ts`

**Interfaces:**
- Consumes: Task 2 recovery DTOs.
- Produces: authoritative replacement rows and dirty 15-minute buckets.

- [ ] **Step 1: Write failing diagnostics test**

Assert `FINAL` query includes both states and maps split counts for a model whose first event is in 2025.

- [ ] **Step 2: Write failing replacement test**

Resolve one legacy and one unpriced row. Assert `recovered === 1`, `repricedLegacy === 1`, replacement status values are both `priced`, and only their 15-minute bucket is dirty. Assert dedup key, tokens, identities, timestamp, adapter, and host remain unchanged.

- [ ] **Step 3: Verify RED**

```bash
pnpm --filter @toard/storage-clickhouse test
```

Expected: FAIL because ClickHouse selection is unpriced-only.

- [ ] **Step 4: Implement ClickHouse recovery**

Use this target condition in diagnostic, select, and replacement guard paths:

```sql
cost_status IN ('unpriced', 'legacy')
OR pricing_revision_id IN {replace_revision_ids:Array(String)}
```

Count by original status, preserve the deterministic generation/version path, mark dirty before inserting replacements, and insert only resolver successes.

- [ ] **Step 5: Verify GREEN and commit**

```bash
pnpm --filter @toard/storage-clickhouse test
pnpm --filter @toard/storage-clickhouse typecheck
git add packages/storage-clickhouse/src/storage.ts packages/storage-clickhouse/src/storage.test.ts
git commit -m 'feat(pricing): ClickHouse 레거시 비용을 권위 가격으로 교체'
```

---

### Task 4: Unclamped Historical Price Range

**Files:**
- Modify: `apps/web/lib/pricing-history.ts`
- Modify: `apps/web/lib/pricing-history.test.ts`

**Interfaces:**
- Consumes: diagnostics whose `firstAt` can predate 90 days.
- Produces: jobs spanning actual retained event dates.

- [ ] **Step 1: Write the failing pre-90-day test**

With `now = 2026-07-15`, `firstAt = 2025-09-10`, `lastAt = 2026-07-11`, and timezone `Asia/Seoul`, assert:

```ts
assert.equal(job.rangeFrom.toISOString(), '2025-09-09T15:00:00.000Z');
assert.equal(job.rangeTo.toISOString(), '2026-07-11T15:00:00.000Z');
```

- [ ] **Step 2: Verify RED**

```bash
pnpm --filter @toard/web exec node --import tsx --test lib/pricing-history.test.ts
```

Expected: FAIL because `jobInput` clamps the lower bound to 90 days.

- [ ] **Step 3: Remove only the retention clamp**

```ts
const rangeFrom = dayStartUtc(localDate(firstAt, timezone), timezone);
const rangeTo = dayStartUtc(nextDate(localDate(lastAt, timezone)), timezone);
```

Remove the unused retention import. Preserve baseline lookup, pagination, staging, promotion, retry, and rate-limit behavior.

- [ ] **Step 4: Verify GREEN and commit**

```bash
pnpm --filter @toard/web exec node --import tsx --test lib/pricing-history.test.ts
git add apps/web/lib/pricing-history.ts apps/web/lib/pricing-history.test.ts
git commit -m 'fix(pricing): 전체 보존 기간의 가격 이력을 조회'
```

---

### Task 5: Full-Retention Worker and Cache Invalidation

**Files:**
- Modify: `apps/web/lib/pricing-repair.ts`
- Modify: `apps/web/lib/pricing-repair.test.ts`
- Modify: `apps/web/lib/user-insights.ts`
- Modify: `apps/web/lib/user-insights.test.ts`

**Interfaces:**
- Consumes: Tasks 1-4 repository fields, generalized storage methods, and unclamped history jobs.
- Produces: epoch lower bound, split progress, settled-state invalidation, and tag `user-insights`.

- [ ] **Step 1: Write failing full-range worker test**

Capture both storage calls and assert:

```ts
assert.equal(captured.from.toISOString(), '1970-01-01T00:00:00.000Z');
assert.equal(captured.to.toISOString(), targetTo.toISOString());
```

Use a diagnostic with `unpricedEvents: 0`, `legacyEvents: 28_256`, and a 2025 first timestamp.

- [ ] **Step 2: Write failing split-progress test**

Return `{ scanned: 100, recovered: 20, repricedLegacy: 80, hasMore: true }` and assert:

```ts
assert.equal(progress.recovered, 20);
assert.equal(progress.repricedLegacy, 80);
assert.equal(progress.remainingUnpriced, 0);
assert.equal(progress.remainingLegacy, 28_176);
assert.equal(progress.state, 'pending');
```

- [ ] **Step 3: Write failing cache-invalidation test**

Inject `invalidateInsightsCache` and assert it is called once after a successful progress write that settles into `idle` or `waiting_for_catalog`, and never for a continuing `pending` batch.

- [ ] **Step 4: Verify RED**

```bash
pnpm --filter @toard/web exec node --import tsx --test lib/pricing-repair.test.ts lib/user-insights.test.ts
```

Expected: FAIL because the worker uses a 90-day lower bound and has no legacy progress or cache hook.

- [ ] **Step 5: Implement full-range orchestration**

```ts
const FULL_RETENTION_FROM = new Date(0);

const totalUnpriced = diagnostics.reduce((sum, item) => sum + item.unpricedEvents, 0);
const totalLegacy = diagnostics.reduce((sum, item) => sum + item.legacyEvents, 0);
const remainingUnpriced = Math.max(0, totalUnpriced - result.recovered);
const remainingLegacy = Math.max(0, totalLegacy - result.repricedLegacy);
```

Remain `pending` while more recoverable rows may exist. Become `idle` only when both remaining counts are zero and no unresolved replacement candidate exists; otherwise continue existing history-source handling and use `waiting_for_catalog` when only unresolved rows remain.

Extend `PricingUnresolvedModel` with `unpricedEvents` and `legacyEvents`; populate both from diagnostics so the admin surface can explain which status remains for each model.

- [ ] **Step 6: Tag and invalidate insights cache**

Add `tags: ['user-insights']` to `unstable_cache`. Extend worker dependencies with:

```ts
invalidateInsightsCache?(): void;
```

Production calls `revalidateTag('user-insights')`. Invoke it once after a settled progress update succeeds, not once per batch.

- [ ] **Step 7: Verify GREEN and commit**

```bash
pnpm --filter @toard/web exec node --import tsx --test lib/pricing-repair.test.ts lib/user-insights.test.ts
pnpm --filter @toard/web typecheck
git add apps/web/lib/pricing-repair.ts apps/web/lib/pricing-repair.test.ts apps/web/lib/user-insights.ts apps/web/lib/user-insights.test.ts
git commit -m 'feat(pricing): 전체 레거시 가격 복구를 자동 실행'
```

---

### Task 6: Admin Legacy Progress

**Files:**
- Modify: `apps/web/lib/pricing-admin-status.ts`
- Modify: `apps/web/app/(dashboard)/admin/pricing-panel.tsx`
- Modify: `apps/web/messages/ko/admin.json`
- Modify: `apps/web/messages/en/admin.json`
- Modify: `apps/web/lib/pricing-admin-api.test.ts`

**Interfaces:**
- Consumes: `repricedLegacyEvents`, `remainingLegacyEvents`.
- Produces: same camel-case fields in the admin DTO and localized rows.

- [ ] **Step 1: Write failing API/source tests**

Assert the DTO contains:

```ts
repricedLegacyEvents: 3_397,
remainingLegacyEvents: 28_256,
```

Assert panel source reads both fields, unresolved model rows expose `unpricedEvents` and `legacyEvents`, and both locale files contain the new keys.

- [ ] **Step 2: Verify RED**

```bash
pnpm --filter @toard/web exec node --import tsx --test lib/pricing-admin-api.test.ts
```

Expected: FAIL because admin contracts omit legacy progress.

- [ ] **Step 3: Implement DTO, rows, and translations**

Render:

```tsx
<dt>{t('pricingRepairRepricedLegacy')}</dt>
<dd>{format.number(status.repair.repricedLegacyEvents)}</dd>
<dt>{t('pricingRepairRemainingLegacy')}</dt>
<dd>{format.number(status.repair.remainingLegacyEvents)}</dd>
```

Korean labels are `이전 가격 재계산` and `남은 이전 가격 기준`; English labels are `Earlier-price recalculated` and `Earlier-price remaining`.

- [ ] **Step 4: Verify GREEN and commit**

```bash
pnpm --filter @toard/web exec node --import tsx --test lib/pricing-admin-api.test.ts
pnpm --filter @toard/web typecheck
git add apps/web/lib/pricing-admin-status.ts 'apps/web/app/(dashboard)/admin/pricing-panel.tsx' apps/web/messages/ko/admin.json apps/web/messages/en/admin.json apps/web/lib/pricing-admin-api.test.ts
git commit -m 'feat(admin): 레거시 가격 복구 진행률 표시'
```

---

### Task 7: Integration and Regression Verification

**Files:**
- Modify: `scripts/verify-historical-pricing-recovery.ts`
- Test: all files changed in Tasks 1-6

**Interfaces:**
- Consumes: completed feature.
- Produces: fresh verification evidence; no unrelated refactoring.

- [ ] **Step 1: Extend the historical verification fixture**

Insert one legacy event older than 90 days with a model available in the fixture's historical revision. Capture event count and every token sum before repair, run the worker and rollup rebuild, then assert:

```ts
assert.equal(after.legacyEvents, before.legacyEvents - 1);
assert.equal(after.pricedEvents, before.pricedEvents + 1);
assert.equal(after.events, before.events);
assert.equal(after.inputTokens, before.inputTokens);
assert.equal(after.outputTokens, before.outputTokens);
assert.equal(after.cacheReadTokens, before.cacheReadTokens);
assert.equal(after.cacheCreationTokens, before.cacheCreationTokens);
```

- [ ] **Step 2: Run focused suites**

```bash
pnpm --filter @toard/storage-postgres test
pnpm --filter @toard/storage-clickhouse test
pnpm --filter @toard/web exec node --import tsx --test lib/pricing-repair.test.ts lib/pricing-history.test.ts lib/pricing-admin-api.test.ts lib/user-insights.test.ts
```

Expected: all pass with zero failures.

- [ ] **Step 3: Run migration and historical integration**

```bash
TSX_TSCONFIG_PATH=apps/web/tsconfig.json node --import tsx --test scripts/full-retention-legacy-pricing-migration.integration.test.ts
pnpm verify:historical-pricing
```

Expected: PostgreSQL 16 test passes. If Docker is unavailable, report the skip instead of claiming a pass.

- [ ] **Step 4: Run repository-wide verification**

```bash
pnpm -r typecheck
pnpm -r test
pnpm test:migrations
pnpm --filter @toard/web build
git diff --check origin/main...HEAD
git status --short
```

Expected: each command exits 0; diff check prints nothing; status contains no unintended files.

- [ ] **Step 5: Review design invariants**

Confirm from code and test output:

- epoch lower bound is used by repair and actual diagnostic dates are used by history jobs;
- legacy cost changes only on authoritative resolver success;
- authoritative priced rows are excluded by select and write guard;
- PostgreSQL rollback and ClickHouse dirty fallback remain intact;
- admin reports separate completed and remaining legacy counts;
- settled repair invalidates insights exactly once;
- no production DB operation, release, tag, or push occurred.

- [ ] **Step 6: Commit the integration fixture**

```bash
git add scripts/verify-historical-pricing-recovery.ts
git commit -m 'test(pricing): 전체 레거시 가격 복구 통합 검증'
```
