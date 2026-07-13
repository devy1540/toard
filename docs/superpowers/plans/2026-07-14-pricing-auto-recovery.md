# Pricing Auto Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 가격표 동기화 뒤 기존 `unpriced` 사용량을 관리자 조작 없이 자동 복구하고 PostgreSQL·ClickHouse rollup 정합성을 유지한다.

**Architecture:** 가격 revision을 조직 날짜 경계에 저장하고 최초 모델에는 보존 범위 bootstrap revision을 추가한다. durable `pricing_repair_status`를 기존 coordinator의 공정한 heavy task 후보로 연결하며, 저장소별 adapter가 `unpriced`만 batch 복구한다. ClickHouse는 mutation 대신 같은 `dedup_key`의 새 버전을 INSERT하고 15분 bucket을 먼저 dirty 처리한다.

**Tech Stack:** TypeScript, Node test runner, Next.js 15, PostgreSQL 16, ClickHouse `ReplacingMergeTree`, pnpm workspace.

## Global Constraints

- 관리자 입력·승인·수동 동기화 없이 앱 기동과 일 1회 sync만으로 완료한다.
- `priced`와 `legacy` 이벤트 및 기존 revision은 수정하지 않는다.
- 가격 변경은 조직 날짜별 revision으로 보존한다.
- logical retention 90일 밖의 이벤트는 처리하지 않는다.
- PostgreSQL과 ClickHouse가 같은 `resolveCostAt` 결과를 저장한다.
- ClickHouse는 dirty-before-replacement 순서를 지키고 준비되지 않은 rollup을 읽지 않는다.
- heavy task는 기존 `toard:rollup-load-slot`에서 한 번에 하나만 실행한다.
- 원본 TTL을 자동 활성화하거나 데이터를 삭제하지 않는다.

---

### Task 1: 가격 revision 날짜 경계와 durable 상태 migration

**Files:**
- Create: `migrations/1700000027_pricing_auto_recovery.sql`
- Create: `scripts/pricing-auto-recovery-migration.integration.test.ts`
- Modify: `apps/web/lib/pricing-sync.ts`
- Modify: `apps/web/lib/pricing.test.ts`
- Modify: `apps/web/lib/org-time.ts`

**Interfaces:**
- Produces: `ensureBootstrapPricingRevisions(client, bootstrapAt): Promise<number>`
- Produces: `markPricingRepairPending(client, generation, targetTo): Promise<void>`
- Produces: `pricingRevisionEffectiveAt(day, timezone): Date`

- [ ] **Step 1: migration 실패 테스트 작성**

PostgreSQL 16 임시 컨테이너에서 migration을 적용하고 다음 schema를 검증한다.

```ts
assert.equal(status.state, "idle");
assert.equal(Number(status.adaptive_limit), 100);
assert.match(schedulerConstraint, /pricing_repair/);
```

`pricing_repair_status`는 singleton 행 하나를 갖고 다음 CHECK를 사용한다.

```sql
state TEXT NOT NULL CHECK (state IN
  ('idle','pending','running','waiting_for_catalog','failed'))
```

- [ ] **Step 2: migration 테스트가 테이블 부재로 실패하는지 확인**

Run: `node --import tsx --test scripts/pricing-auto-recovery-migration.integration.test.ts`

Expected: `pricing_repair_status`가 없거나 scheduler task CHECK가 `pricing_repair`를 거부해 FAIL.

- [ ] **Step 3: additive migration 구현**

```sql
CREATE TABLE pricing_repair_status (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  generation TIMESTAMPTZ,
  state TEXT NOT NULL DEFAULT 'idle'
    CHECK (state IN ('idle','pending','running','waiting_for_catalog','failed')),
  target_to TIMESTAMPTZ,
  processed_events BIGINT NOT NULL DEFAULT 0,
  recovered_events BIGINT NOT NULL DEFAULT 0,
  remaining_unpriced_events BIGINT NOT NULL DEFAULT 0,
  last_started_at TIMESTAMPTZ,
  last_succeeded_at TIMESTAMPTZ,
  last_error TEXT,
  adaptive_limit INTEGER NOT NULL DEFAULT 100,
  load_state TEXT NOT NULL DEFAULT 'normal'
    CHECK (load_state IN ('normal','throttled')),
  eligible_since TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO pricing_repair_status (singleton) VALUES (TRUE)
ON CONFLICT (singleton) DO NOTHING;
```

`clickhouse_rollup_scheduler_status.last_selected_task` CHECK를
`usage_15m_v2 | timezone | validation | pricing_repair | idle`로 교체한다.

- [ ] **Step 4: revision 경계와 bootstrap 실패 테스트 작성**

`apps/web/lib/pricing.test.ts`에 다음 동작을 추가한다.

```ts
assert.equal(
  pricingRevisionEffectiveAt("2026-03-08", "America/Los_Angeles").toISOString(),
  firstInstantOfLocalDate("2026-03-08", "America/Los_Angeles").toISOString(),
);
assert.equal(await ensureBootstrapPricingRevisions(client, retentionStart), 1);
assert.equal(await ensureBootstrapPricingRevisions(client, retentionStart), 0);
assert.match(pendingQuery.sql, /UPDATE pricing_repair_status/);
```

- [ ] **Step 5: 가격 테스트가 현재 시각 revision과 bootstrap 부재로 실패하는지 확인**

Run: `node --import tsx --test apps/web/lib/pricing.test.ts`

Expected: 새 export 부재 또는 `effective_at`이 sync 요청 시각이라 FAIL.

- [ ] **Step 6: 날짜 경계 sync와 bootstrap 구현**

`pricingRevisionEffectiveAt`은 `firstInstantOfLocalDate`를 사용한다. sync transaction은 advisory lock을 얻은 뒤 아래 순서로 실행한다.

```ts
const observedAt = now();
const effectiveAt = pricingRevisionEffectiveAt(day, timezone);
const changed = await syncPricingRevisions(client, pricing, effectiveAt);
await ensureBootstrapPricingRevisions(client, retentionStart);
await markPricingRepairPending(client, observedAt, observedAt);
```

bootstrap은 모델별 earliest revision 가격을 `source='litellm-bootstrap'`, `effective_at=retentionStart`로 INSERT하고 `ON CONFLICT DO NOTHING`을 사용한다. 기존 revision 행은 UPDATE하지 않는다.

- [ ] **Step 7: Task 1 테스트 통과 확인**

Run:

```bash
node --import tsx --test apps/web/lib/pricing.test.ts
node --import tsx --test scripts/pricing-auto-recovery-migration.integration.test.ts
```

Expected: PASS.

- [ ] **Step 8: Task 1 커밋**

```bash
git add migrations/1700000027_pricing_auto_recovery.sql scripts/pricing-auto-recovery-migration.integration.test.ts apps/web/lib/pricing-sync.ts apps/web/lib/pricing.test.ts apps/web/lib/org-time.ts
git commit -m "feat(pricing): 자동 복구 상태와 날짜 revision을 추가"
```

---

### Task 2: 저장소 공통 가격 복구 계약과 PostgreSQL adapter

**Files:**
- Modify: `packages/core/src/storage.ts`
- Modify: `packages/storage-postgres/src/storage.ts`
- Modify: `packages/storage-postgres/src/storage.test.ts`

**Interfaces:**
- Produces: `UnpricedUsageModelDiagnostic`
- Produces: `PricingRepairRequest`
- Produces: `PricingRepairBatchResult`
- Produces: `StorageBackend.getUnpricedUsageModels(from, to): Promise<UnpricedUsageModelDiagnostic[]>`
- Produces: `StorageBackend.repairUnpricedUsage(request, resolver): Promise<PricingRepairBatchResult>`

- [ ] **Step 1: PostgreSQL 복구 실패 테스트 작성**

공통 계약은 다음 형태로 고정한다.

```ts
export type PricingRepairResolver = (
  event: UsageEvent,
) => { costUsd: number; pricingRevisionId: string } | null;

export type PricingRepairRequest = {
  from: Date;
  to: Date;
  models: string[];
  limit: number;
  generation: string;
};

export type PricingRepairBatchResult = {
  scanned: number;
  recovered: number;
  affectedBuckets: Date[];
  hasMore: boolean;
};
```

테스트는 SQL과 결과를 검증한다.

```ts
assert.match(selectSql, /cost_status = 'unpriced'/);
assert.match(selectSql, /FOR UPDATE SKIP LOCKED/);
assert.match(updateSql, /pricing_revision_id/);
assert.equal(result.recovered, 1);
assert.equal(pricedRow.cost_status, "priced");
```

resolver가 null인 모델, `priced`, `legacy`, 범위 밖 이벤트는 변경되지 않아야 한다.

- [ ] **Step 2: PostgreSQL 테스트가 계약·메서드 부재로 실패하는지 확인**

Run: `node --import tsx --test packages/storage-postgres/src/storage.test.ts`

Expected: `repairUnpricedUsage` 부재로 FAIL.

- [ ] **Step 3: 공통 타입과 PostgreSQL transaction 구현**

`getUnpricedUsageModels`는 model별 count·min(ts)·max(ts)를 반환한다. `repairUnpricedUsage`는 `models = ANY($n)`과 `FOR UPDATE SKIP LOCKED`로 최대 limit을 claim하고 resolver가 값을 반환한 행만 UPDATE한다.

```sql
UPDATE usage_events
SET cost_usd = $2,
    pricing_revision_id = $3,
    cost_status = 'priced'
WHERE dedup_key = $1 AND cost_status = 'unpriced'
```

영향받은 조직 날짜는 같은 transaction에서 `usage_daily_user`와 `usage_daily_team`을 해당 날짜의 `usage_events`로 다시 계산한다. 날짜별 `pg_advisory_xact_lock(hashtext('recompute:' || day))`을 먼저 얻는다.

- [ ] **Step 4: PostgreSQL 테스트 통과 확인**

Run: `node --import tsx --test packages/storage-postgres/src/storage.test.ts`

Expected: PASS.

- [ ] **Step 5: Task 2 커밋**

```bash
git add packages/core/src/storage.ts packages/storage-postgres/src/storage.ts packages/storage-postgres/src/storage.test.ts
git commit -m "feat(pricing): PostgreSQL 미확정 비용을 복구"
```

---

### Task 3: ClickHouse replacement와 rollup invalidation

**Files:**
- Modify: `packages/storage-clickhouse/src/storage.ts`
- Modify: `packages/storage-clickhouse/src/storage.test.ts`

**Interfaces:**
- Consumes: Task 2의 `PricingRepairRequest`, `PricingRepairResolver`, `PricingRepairBatchResult`
- Produces: ClickHouse `StorageBackend`의 동일 메서드 구현

- [ ] **Step 1: ClickHouse replacement 실패 테스트 작성**

테스트 client로 실행 순서를 기록하고 다음을 검증한다.

```ts
assert.deepEqual(actions.slice(0, 2), ["mark-dirty", "insert-replacement"]);
assert.match(selectSql, /FROM usage_events FINAL/);
assert.match(selectSql, /cost_status = 'unpriced'/);
assert.equal(insert.values[0].dedup_key, "event-1");
assert.equal(insert.values[0].cost_status, "priced");
assert.equal(insert.values[0].pricing_revision_id, "revision-1");
assert.match(insert.settings.insert_deduplication_token, /^pricing-repair:/);
```

같은 batch 재시도는 같은 token을 만들고 `hasMore`는 limit+1 조회로 결정한다.

- [ ] **Step 2: ClickHouse 테스트가 메서드 부재로 실패하는지 확인**

Run: `node --import tsx --test packages/storage-clickhouse/src/storage.test.ts`

Expected: `repairUnpricedUsage` 부재로 FAIL.

- [ ] **Step 3: 모델 진단과 replacement 구현**

`getUnpricedUsageModels`는 `usage_events FINAL`에서 집계한다. repair는 `limit + 1`행을 읽고 resolver가 성공한 행만 새 버전으로 만든다. 모든 원래 차원과 토큰을 보존하고 `cost_usd`, `pricing_revision_id`, `cost_status`만 변경한다.

PG transaction에서 `usage_15m`과 `usage_15m_v2` dirty bucket을 먼저 upsert한 뒤 ClickHouse INSERT를 실행한다. token은 SHA-256으로 다음 입력을 hash한다.

```ts
`${request.generation}:${recovered.map((row) => row.dedup_key).sort().join("\n")}`
```

- [ ] **Step 4: ClickHouse 테스트 통과 확인**

Run: `node --import tsx --test packages/storage-clickhouse/src/storage.test.ts`

Expected: PASS.

- [ ] **Step 5: Task 3 커밋**

```bash
git add packages/storage-clickhouse/src/storage.ts packages/storage-clickhouse/src/storage.test.ts
git commit -m "feat(pricing): ClickHouse 미확정 비용을 안전하게 교체"
```

---

### Task 4: 가격 복구 worker와 공정 coordinator 연결

**Files:**
- Create: `apps/web/lib/pricing-repair.ts`
- Create: `apps/web/lib/pricing-repair.test.ts`
- Modify: `apps/web/lib/rollup-coordinator-state.ts`
- Modify: `apps/web/lib/rollup-coordinator.ts`
- Modify: `apps/web/lib/rollup-coordinator.test.ts`
- Modify: `apps/web/instrumentation.ts`

**Interfaces:**
- Produces: `PgPricingRepairRepository`
- Produces: `runPricingRepairTask(now?: Date): Promise<RollupSchedulerOutcome>`
- Produces: `pricingRepairCandidate(now): Promise<RollupCoordinatorCandidate | null>`

- [ ] **Step 1: worker 상태 전이 실패 테스트 작성**

```ts
assert.equal(await repository.candidate(now), "pending");
assert.equal(await runPricingRepairTask(now), "success");
assert.equal(status.state, "idle");
assert.equal(status.recoveredEvents, 3);
```

적용 가능한 모델이 없으면 `waiting_for_catalog`, 저장소 오류면 `failed`와 `next_attempt_at`, 새 generation이면 다시 `pending`이어야 한다.

- [ ] **Step 2: coordinator 공정성 실패 테스트 작성**

기존 30분 soak 후보에 `pricing_repair`를 추가하고 세 worker가 모두 120초 이내 선택되는지 검증한다. validation은 계속 최우선이고 한 tick의 heavy 동시 실행은 1이어야 한다.

- [ ] **Step 3: worker·coordinator 테스트가 새 task 부재로 실패하는지 확인**

Run:

```bash
node --import tsx --test apps/web/lib/pricing-repair.test.ts
node --import tsx --test apps/web/lib/rollup-coordinator.test.ts
```

Expected: `pricing_repair` task와 worker 부재로 FAIL.

- [ ] **Step 4: 가격 복구 worker 구현**

worker는 status target과 `getPricingSchedule()`을 읽고 모델 진단을 resolver로 분류한다.

```ts
const resolver: PricingRepairResolver = (event) => {
  const result = resolveCostAt({ ...event, occurredAt: event.ts, schedule, mode: "calculate" });
  return result.status === "priced" && result.pricingRevisionId
    ? { costUsd: result.costUsd, pricingRevisionId: result.pricingRevisionId }
    : null;
};
```

적용 가능한 모델만 storage repair에 넘긴다. 성공 batch 시간으로 adaptive limit을 25~500 범위에서 조절하고, 다음 eligible row가 없으면 미지원 모델 유무에 따라 `idle` 또는 `waiting_for_catalog`로 끝낸다.

- [ ] **Step 5: coordinator task 추가**

`RollupSchedulerTask`와 안정 순서를 다음처럼 확장한다.

```ts
const STABLE_TASK_ORDER = {
  validation: 0,
  pricing_repair: 1,
  usage_15m_v2: 2,
  timezone: 3,
};
```

PostgreSQL 모드에서도 coordinator를 시작하되 ClickHouse 후보는 `due=false`로 만든다. `instrumentation.ts`는 pricing scheduler가 eligible하거나 ClickHouse backend이면 coordinator를 시작한다.

- [ ] **Step 6: Task 4 테스트 통과 확인**

Run:

```bash
node --import tsx --test apps/web/lib/pricing-repair.test.ts
node --import tsx --test apps/web/lib/rollup-coordinator.test.ts
```

Expected: PASS.

- [ ] **Step 7: Task 4 커밋**

```bash
git add apps/web/lib/pricing-repair.ts apps/web/lib/pricing-repair.test.ts apps/web/lib/rollup-coordinator-state.ts apps/web/lib/rollup-coordinator.ts apps/web/lib/rollup-coordinator.test.ts apps/web/instrumentation.ts
git commit -m "feat(pricing): 자동 복구 worker를 coordinator에 연결"
```

---

### Task 5: 무조작 관리자 상태와 사용자 안내

**Files:**
- Create: `apps/web/app/api/admin/pricing/status/route.ts`
- Create: `apps/web/lib/pricing-admin-api.test.ts`
- Modify: `apps/web/app/(dashboard)/admin/pricing-panel.tsx`
- Modify: `apps/web/app/(dashboard)/admin/page.tsx`
- Delete: `apps/web/app/(dashboard)/admin/pricing-actions.ts`
- Modify: `apps/web/lib/pricing-auto-sync.ts`
- Modify: `apps/web/components/dashboard/pricing-notice.tsx`
- Modify: `apps/web/messages/ko/admin.json`
- Modify: `apps/web/messages/en/admin.json`
- Modify: `apps/web/messages/ko/dashboard.json`
- Modify: `apps/web/messages/en/dashboard.json`
- Modify: `apps/web/lib/pricing.test.ts`
- Modify: `README.md`

**Interfaces:**
- Produces: `GET /api/admin/pricing/status`
- Produces: read-only `PricingSyncPanel` polling DTO every 30 seconds

- [ ] **Step 1: API와 UI 실패 테스트 작성**

API는 비로그인 401, 일반 사용자 403, 관리자 200과 `cache-control: no-store`를 검증한다. DTO는 다음 필드를 갖는다.

```ts
{
  models: number;
  lastDay: string | null;
  repair: {
    state: "idle" | "pending" | "running" | "waiting_for_catalog" | "failed";
    recoveredEvents: number;
    remainingUnpricedEvents: number;
    lastSucceededAt: string | null;
  };
  unresolvedModels: Array<{ model: string | null; events: number; firstAt: string; lastAt: string }>;
}
```

source assertion은 `syncPricingAction`, `setPricingAutoSyncAction`, `지금 동기화` 버튼과 Switch가 제거됐는지 확인한다. dashboard 문구는 관리자 페이지 이동 대신 자동 반영을 설명해야 한다.

- [ ] **Step 2: UI/API 테스트가 현재 조작 UI 때문에 실패하는지 확인**

Run:

```bash
node --import tsx --test apps/web/lib/pricing-admin-api.test.ts
node --import tsx --test apps/web/lib/pricing.test.ts
```

Expected: status route 부재와 기존 action/toggle 문구 때문에 FAIL.

- [ ] **Step 3: 자동 sync kill switch 단순화**

DB `pricing_auto_sync` 토글을 읽지 않고 `schedulerEligible(process.env)`만 인프라 kill switch로 사용한다. tick은 `dueToday()`이면 자동 실행하고 실패 시 1시간 뒤 재시도한다. 기존 app setting 행은 호환성을 위해 삭제하지 않는다.

- [ ] **Step 4: read-only 상태 API와 panel 구현**

panel은 initial DTO를 받고 30초마다 status API를 no-store fetch한다. 버튼·Switch·입력은 렌더링하지 않는다. 상태 문자열은 다음 의미로 통일한다.

- `pending|running`: 가격 확인 중 · 자동으로 반영됩니다
- `waiting_for_catalog`: 가격표 지원 대기 · 다음 동기화에서 자동 재확인합니다
- `failed`: 일시 오류 · 자동 재시도 중
- `idle`과 remaining 0: 정상

- [ ] **Step 5: 사용자 경고와 README 수정**

경고 문구를 `가격 미확정 사용량 {count}건을 자동으로 확인하고 있습니다. 가격표가 갱신되면 별도 조작 없이 반영됩니다.`로 바꾸고 역할별 관리자 이동 안내를 제거한다. README는 self-host 내장 sync와 자동 repair를 하나의 lifecycle로 설명한다.

- [ ] **Step 6: Task 5 테스트 통과 확인**

Run:

```bash
node --import tsx --test apps/web/lib/pricing-admin-api.test.ts
node --import tsx --test apps/web/lib/pricing.test.ts
```

Expected: PASS.

- [ ] **Step 7: Task 5 커밋**

```bash
git add apps/web/app/api/admin/pricing/status/route.ts apps/web/lib/pricing-admin-api.test.ts apps/web/app/'(dashboard)'/admin/pricing-panel.tsx apps/web/app/'(dashboard)'/admin/page.tsx apps/web/app/'(dashboard)'/admin/pricing-actions.ts apps/web/lib/pricing-auto-sync.ts apps/web/components/dashboard/pricing-notice.tsx apps/web/messages/ko/admin.json apps/web/messages/en/admin.json apps/web/messages/ko/dashboard.json apps/web/messages/en/dashboard.json apps/web/lib/pricing.test.ts README.md
git commit -m "feat(pricing): 가격 복구 상태를 무조작 UI로 전환"
```

---

### Task 6: 실제 DB 정합성·부하·전체 회귀 검증

**Files:**
- Create: `scripts/verify-pricing-auto-recovery.ts`
- Modify: `package.json`
- Modify: `docs/superpowers/specs/2026-07-13-pricing-auto-recovery-design.md` only if implementation evidence reveals a contradiction

**Interfaces:**
- Produces: `pnpm verify:pricing-auto-recovery`

- [ ] **Step 1: 임시 PostgreSQL·ClickHouse 검증 스크립트 작성**

스크립트는 운영 DB가 아닌 tmpfs 컨테이너에 다음 fixture를 적재한다.

- 같은 모델의 전날/오늘 revision
- 오늘 sync 전 unpriced 이벤트
- 가격표 미지원 모델
- priced와 legacy 보호 행
- ClickHouse 같은 dedup replacement 재시도

검증 값은 다음과 같다.

```ts
assert.equal(before.unpriced, 3);
assert.equal(after.unpriced, 1);
assert.equal(after.priced, 3);
assert.equal(after.legacy, 1);
assert.equal(after.totalTokens, before.totalTokens);
assert.equal(after.events, before.events);
assert.equal(rawFingerprint.matchesRollup, true);
```

- [ ] **Step 2: exact verifier가 구현 결함을 찾으면 해당 Task의 실패 테스트로 돌아가 수정**

Run: `node --import tsx scripts/verify-pricing-auto-recovery.ts`

Expected: `PRICING_AUTO_RECOVERY_PASS`.

- [ ] **Step 3: 전체 정적·단위·통합 검증**

Run:

```bash
pnpm typecheck
pnpm test
pnpm --filter @toard/web build
pnpm exec tsx scripts/verify-clickhouse-exact-rollup.ts
pnpm benchmark:dashboard-http
git diff --check origin/main...HEAD
```

Expected:

- typecheck/test/build PASS
- pricing exact verifier PASS
- 기존 ClickHouse exact rollup verifier PASS
- 1,000,000 event 인증 대시보드 8개 시나리오 모두 p95 2초 이하, 5xx 0
- whitespace error 0

- [ ] **Step 4: Task 6 커밋**

```bash
git add scripts/verify-pricing-auto-recovery.ts package.json
git commit -m "test(pricing): 자동 복구 정합성을 통합 검증"
```

- [ ] **Step 5: 최종 변경 검토**

```bash
git status -sb
git log --oneline origin/main..HEAD
git diff --stat origin/main...HEAD
```

Expected: 의도한 설계·계획·구현·검증 파일만 있고 미추적 생성물이 없다.
