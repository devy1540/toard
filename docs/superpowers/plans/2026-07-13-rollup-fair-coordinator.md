# Rollup Fair Coordinator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 15분 기준 rollup, 확정 구간의 시간대별 rollup, 자동 전환 검증을 하나의 공정 coordinator가 직렬 실행해 starvation 없이 정합성과 p95 2초 목표를 지킨다.

**Architecture:** 기존 `toard:rollup-load-slot`을 coordinator 전체 잠금으로 유지하고, 완료 후 10초 뒤 다시 실행되는 self-scheduling loop가 durable 상태에서 heavy task 하나를 선택한다. 시간대별 job은 `source_to`까지 15분 watermark가 진행되고 dirty가 없을 때만 claim하며, generation compare-and-set으로 처리 중 늦은 데이터의 결과 승인을 막는다.

**Tech Stack:** TypeScript, Node.js timers, PostgreSQL 16 advisory locks·CTE, ClickHouse rollup storage, Next.js 15 instrumentation/admin UI, `node:test`, pnpm 9.

## Global Constraints

- 전체 app replica에서 heavy ClickHouse rollup·검증 작업 동시 실행 수는 1 이하다.
- 처리 가능한 worker는 `eligible_since`로 측정해 120초 안에 선택한다.
- coordinator wake-up은 10초, worker 최소 실행 간격은 60초다.
- 15분 adaptive 범위는 1~64 bucket, 시간대별 adaptive 범위는 1~32 job이다.
- batch가 2초 이하로 한도를 모두 사용하면 25% 증가하고, 10초 이상이거나 실패하면 절반으로 감소한다.
- 시간대별 job은 `source_to <= usage_15m_v2 watermark`이고 job 범위에 dirty bucket이 없을 때만 처리한다.
- day 경계는 IANA 시간대의 다음 로컬 날짜 시작이며 24시간 고정 계산을 금지한다.
- 신규 수집 outbox는 coordinator 잠금을 사용하지 않는다.
- 기존 pause/resume, read override, worker ID, raw TTL 기본 OFF 정책을 유지한다.
- migration은 additive이며 기존 watermark·pending·coverage·adaptive 상태를 초기화하지 않는다.
- 자동 읽기 전환 완료와 성능 보장은 전체 정합성·100만 건 benchmark 통과 후에만 선언한다.

---

## 파일 구조

- `migrations/1700000026_clickhouse_rollup_coordinator.sql`: job generation/source 범위, worker scheduling, scheduler heartbeat schema.
- `apps/web/lib/rollup-worker-state.ts`: durable eligibility/backoff와 기존 worker 관측 상태.
- `apps/web/lib/rollup-coordinator-state.ts`: scheduler 단일 행 매핑과 task 결과 저장.
- `apps/web/lib/timezone-rollup.ts`: DST-safe job window, 확정 구간 claim, generation CAS 완료.
- `packages/storage-clickhouse/src/storage.ts`: 15분 변경이 만든 timezone job의 source 범위와 generation invalidation.
- `apps/web/lib/rollup-coordinator.ts`: 후보 계획, 공정 선택, 전역 잠금, self-scheduling loop.
- `apps/web/lib/clickhouse-outbox.ts`: coordinator-held task adapter와 outbox-only 독립 timer.
- `apps/web/lib/rollup-cutover.ts`: 가벼운 heartbeat와 선택 가능한 validation 작업 분리.
- `apps/web/instrumentation.ts`: 세 rollup interval 대신 coordinator 하나만 시작.
- `apps/web/lib/rollup-status.ts`, 관리자 panel/messages: waiting-for-base와 scheduler 상태 표시.
- `scripts/rollup-coordinator-migration.integration.test.ts`: 실제 PostgreSQL 16 migration/경쟁 조건 검증.

### Task 1: Add durable coordinator and worker scheduling schema

**Files:**
- Create: `migrations/1700000026_clickhouse_rollup_coordinator.sql`
- Create: `apps/web/lib/rollup-coordinator-state.ts`
- Create: `apps/web/lib/rollup-coordinator-state.test.ts`
- Modify: `apps/web/lib/rollup-worker-state.ts`
- Modify: `apps/web/lib/rollup-worker-state.test.ts`

**Interfaces:**
- Produces: `RollupSchedulerTask`, `RollupSchedulerOutcome`, `RollupSchedulerRecord`.
- Produces: `PgRollupCoordinatorRepository.get()`, `.recordHeartbeat()`, `.recordStarted()`, `.recordFinished()`.
- Extends: `RollupWorkerRecord.eligibleSince`, `.nextAttemptAt`, `.consecutiveFailures`.
- Produces: `RollupWorkerRepository.setEligibility(worker, eligible, now)`.
- Consumes later: coordinator candidate planning and admin status.

- [x] **Step 1: Write failing migration and mapping tests**

```ts
test("coordinator migration은 job generation과 durable scheduler 상태를 추가한다", () => {
  assert.match(migration, /ADD COLUMN source_to TIMESTAMPTZ/);
  assert.match(migration, /ADD COLUMN generation BIGINT NOT NULL DEFAULT 0/);
  assert.match(migration, /ADD COLUMN eligible_since TIMESTAMPTZ/);
  assert.match(migration, /CREATE TABLE clickhouse_rollup_scheduler_status/);
});

test("worker eligibility는 최초 시각을 유지하고 backlog가 없으면 초기화한다", async () => {
  await repository.setEligibility("timezone", true, first);
  await repository.setEligibility("timezone", true, later);
  assert.equal((await repository.get("timezone")).eligibleSince?.toISOString(), first.toISOString());
  await repository.setEligibility("timezone", false, later);
  assert.equal((await repository.get("timezone")).eligibleSince, null);
});
```

- [x] **Step 2: Run focused tests and confirm failure**

Run: `pnpm --filter @toard/web test -- rollup-coordinator-state.test.ts rollup-worker-state.test.ts`

Expected: FAIL because migration 26, coordinator repository, and scheduling fields do not exist.

- [x] **Step 3: Add the additive migration**

```sql
ALTER TABLE clickhouse_timezone_rollup_jobs
  ADD COLUMN source_to TIMESTAMPTZ,
  ADD COLUMN generation BIGINT NOT NULL DEFAULT 0;

ALTER TABLE clickhouse_rollup_worker_status
  ADD COLUMN eligible_since TIMESTAMPTZ,
  ADD COLUMN next_attempt_at TIMESTAMPTZ,
  ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;

CREATE TABLE clickhouse_rollup_scheduler_status (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  last_heartbeat_at TIMESTAMPTZ,
  last_selected_task TEXT CHECK (last_selected_task IN ('usage_15m_v2','timezone','validation','idle')),
  last_task_started_at TIMESTAMPTZ,
  last_task_finished_at TIMESTAMPTZ,
  last_task_outcome TEXT CHECK (last_task_outcome IN ('success','failed','superseded','idle')),
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Backfill hour `source_to` with `bucket + interval '1 hour'`; backfill day with the next local date converted by the row's `timezone`; then make `source_to NOT NULL`. Insert the singleton scheduler row with `ON CONFLICT DO NOTHING`.

- [x] **Step 4: Implement repositories and worker scheduling fields**

```ts
export type RollupSchedulerTask = RollupWorkerName | "validation" | "idle";
export type RollupSchedulerOutcome = "success" | "failed" | "superseded" | "idle";

export class PgRollupCoordinatorRepository {
  constructor(private readonly pool: Pool) {}
  get(): Promise<RollupSchedulerRecord>;
  recordHeartbeat(at: Date): Promise<void>;
  recordStarted(task: RollupSchedulerTask, at: Date): Promise<void>;
  recordFinished(task: RollupSchedulerTask, outcome: RollupSchedulerOutcome, at: Date, error?: string): Promise<void>;
}
```

`markSucceeded` resets `next_attempt_at` and `consecutive_failures`; `markFailed` increments failures and stores exponential 60~300 second backoff; `setPaused(true)` clears `eligible_since`.

- [x] **Step 5: Run tests and typecheck**

Run: `pnpm --filter @toard/web test -- rollup-coordinator-state.test.ts rollup-worker-state.test.ts && pnpm --filter @toard/web typecheck`

Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add migrations/1700000026_clickhouse_rollup_coordinator.sql apps/web/lib/rollup-coordinator-state.ts apps/web/lib/rollup-coordinator-state.test.ts apps/web/lib/rollup-worker-state.ts apps/web/lib/rollup-worker-state.test.ts
git commit -m "feat(rollup): coordinator 상태를 영속화"
```

### Task 2: Process only finalized timezone windows with generation CAS

**Files:**
- Modify: `apps/web/lib/timezone-rollup.ts`
- Modify: `apps/web/lib/timezone-rollup.test.ts`
- Modify: `apps/web/lib/timezone-rollup-lifecycle.test.ts`
- Modify: `packages/storage-clickhouse/src/storage.ts`
- Modify: `packages/storage-clickhouse/src/storage.test.ts`

**Interfaces:**
- Produces: `TimezoneRollupWindow { bucket: Date; sourceTo: Date }`.
- Extends: `TimezoneRollupJob.sourceTo`, `.generation`.
- Changes: `prewarmMissingJobs(resolution, timezone, windows)`.
- Changes: `markDone(id, generation): Promise<boolean>` and `markPending(id, generation): Promise<void>`.
- Produces: `countTimezoneRollupBacklog(): { eligible: number; waitingForBase: number }`.
- Consumes: `usage_15m_v2` watermark and dirty bucket table.

- [x] **Step 1: Write failing finalized-window and race tests**

```ts
test("day sourceTo는 DST 다음 로컬 날짜 경계다", () => {
  const spring = timezonePrewarmWindows("day", "America/Los_Angeles", springNow);
  assert.equal(hoursBetween(spring[0]!.bucket, spring[0]!.sourceTo), 23);
  const fall = timezonePrewarmWindows("day", "America/Los_Angeles", fallNow);
  assert.equal(hoursBetween(fall[0]!.bucket, fall[0]!.sourceTo), 25);
});

test("watermark 이전이고 dirty가 없는 job만 claim한다", async () => {
  const claimed = await repository.claimJobs(32);
  assert.deepEqual(claimed.map((job) => job.id), ["finalized-hour"]);
});

test("claim 뒤 generation이 바뀌면 coverage를 승인하지 않는다", async () => {
  const accepted = await repository.markDone("job", 4);
  assert.equal(accepted, false);
});
```

- [x] **Step 2: Run focused tests and confirm failure**

Run: `pnpm --filter @toard/web test -- timezone-rollup.test.ts timezone-rollup-lifecycle.test.ts && pnpm --filter @toard/storage-clickhouse test -- storage.test.ts`

Expected: FAIL on missing source window, eligibility query, and generation CAS.

- [x] **Step 3: Implement DST-safe windows and finalized claim**

```ts
export type TimezoneRollupWindow = { bucket: Date; sourceTo: Date };

export type TimezoneRollupJob = {
  id: string;
  resolution: TimezoneRollupResolution;
  timezone: string;
  bucket: Date;
  sourceTo: Date;
  generation: number;
  status: TimezoneRollupJobStatus;
};
```

Daily windows use `firstInstantOfLocalDate(nextDate, timezone)`; hourly windows use the next absolute hour boundary already represented by the current bucket plan. Claim SQL joins the `usage_15m_v2` watermark and excludes any dirty bucket in `[bucket, source_to)`.

- [x] **Step 4: Implement invalidation generation and compare-and-set completion**

```sql
ON CONFLICT (resolution, timezone, bucket) DO UPDATE
SET status = 'pending',
    source_to = EXCLUDED.source_to,
    generation = clickhouse_timezone_rollup_jobs.generation + 1,
    updated_at = now()
```

`markDone` only inserts coverage when status, generation, watermark, and dirty recheck still match. If zero rows complete, return `false`; the worker records `superseded` and does not count the job as progress.

- [x] **Step 5: Run focused suites and typecheck**

Run: `pnpm --filter @toard/web test -- timezone-rollup.test.ts timezone-rollup-lifecycle.test.ts && pnpm --filter @toard/storage-clickhouse test -- storage.test.ts && pnpm --filter @toard/web typecheck && pnpm --filter @toard/storage-clickhouse typecheck`

Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add apps/web/lib/timezone-rollup.ts apps/web/lib/timezone-rollup.test.ts apps/web/lib/timezone-rollup-lifecycle.test.ts packages/storage-clickhouse/src/storage.ts packages/storage-clickhouse/src/storage.test.ts
git commit -m "fix(rollup): 확정된 시간대 구간만 처리"
```

### Task 3: Add deterministic fair coordinator and remove starving intervals

**Files:**
- Create: `apps/web/lib/rollup-coordinator.ts`
- Create: `apps/web/lib/rollup-coordinator.test.ts`
- Modify: `apps/web/lib/clickhouse-outbox.ts`
- Modify: `apps/web/lib/clickhouse-outbox.test.ts`
- Modify: `apps/web/instrumentation.ts`

**Interfaces:**
- Produces: `selectRollupTask(input): RollupCoordinatorTask | null`.
- Produces: `runRollupCoordinatorTickWith(dependencies, now): Promise<CoordinatorTickOutcome>`.
- Produces: `startRollupCoordinator()` using recursive `setTimeout`.
- Produces: coordinator-held adapters `runClickHouse15mV2Task()` and `runClickHouseTimezoneTask()`.
- Consumes: worker/scheduler repositories and timezone eligible backlog.

- [x] **Step 1: Write starvation regression and non-overlap tests**

```ts
test("동시에 due인 worker는 120초 안에 모두 선택된다", async () => {
  const selected = await simulateCoordinator({ minutes: 30, usageBacklog: true, timezoneEligible: 40 });
  assertMaxSelectionGap(selected, "usage_15m_v2", 120_000);
  assertMaxSelectionGap(selected, "timezone", 120_000);
});

test("15분 worker가 먼저 등록돼도 timezone을 굶기지 않는다", () => {
  const tasks = simulatePureSelection(20);
  assert.ok(tasks.includes("usage_15m_v2"));
  assert.ok(tasks.includes("timezone"));
});

test("두 replica 중 잠금을 얻은 하나만 heavy task를 실행한다", async () => {
  await Promise.all([tickA(), tickB()]);
  assert.equal(heavyCalls, 1);
});
```

- [x] **Step 2: Run tests and confirm failure**

Run: `pnpm --filter @toard/web test -- rollup-coordinator.test.ts clickhouse-outbox.test.ts`

Expected: FAIL because coordinator and task adapters do not exist.

- [x] **Step 3: Implement pure candidate selection**

```ts
export type RollupCoordinatorCandidate = {
  task: "usage_15m_v2" | "timezone" | "validation";
  due: boolean;
  eligibleSince: Date | null;
  lastStartedAt: Date | null;
  nextAttemptAt: Date | null;
};

export function selectRollupTask(candidates: readonly RollupCoordinatorCandidate[], now: Date) {
  const runnable = candidates.filter(isRunnable);
  return runnable.sort(compareValidationThenStarvationThenOldest)[0]?.task ?? null;
}
```

Validation ranks first, then candidates waiting 120 seconds, then oldest last start. Null last start is oldest and the final tie-break is 15m.

- [x] **Step 4: Implement one-lock tick and self-scheduling loop**

```ts
export function startRollupCoordinator(): void {
  const schedule = () => {
    const timer = setTimeout(() => {
      void runRollupCoordinatorTick().finally(schedule);
    }, 10_000);
    timer.unref();
  };
  schedule();
}
```

The tick acquires existing `toard:rollup-load-slot`, updates eligibility, selects one task, records scheduler start/finish, executes one adapter, then releases. Normal lock loss returns `busy` without setting worker error.

- [x] **Step 5: Replace instrumentation startup**

```ts
startClickHouseOutboxFlush();
startRollupCoordinator();
```

Remove calls that start independent 15m v2, timezone, and cutover intervals. Retain the existing scheduler exports as deprecated compatibility wrappers for current tests and external imports, but instrumentation must not call them.

- [x] **Step 6: Run focused tests and typecheck**

Run: `pnpm --filter @toard/web test -- rollup-coordinator.test.ts clickhouse-outbox.test.ts ui-commonization.test.ts && pnpm --filter @toard/web typecheck`

Expected: PASS and instrumentation contains exactly one rollup scheduler start.

- [x] **Step 7: Commit**

```bash
git add apps/web/lib/rollup-coordinator.ts apps/web/lib/rollup-coordinator.test.ts apps/web/lib/clickhouse-outbox.ts apps/web/lib/clickhouse-outbox.test.ts apps/web/instrumentation.ts
git commit -m "fix(rollup): 공정 coordinator로 작업을 직렬화"
```

### Task 4: Split cutover heartbeat from heavy validation

**Files:**
- Modify: `apps/web/lib/rollup-cutover.ts`
- Modify: `apps/web/lib/rollup-cutover.test.ts`
- Modify: `apps/web/lib/rollup-coordinator.ts`
- Modify: `apps/web/lib/rollup-coordinator.test.ts`

**Interfaces:**
- Produces: `reconcileRollupCutoverWith(...): Promise<{ validation: RollupValidationTask | null }>`.
- Produces: `executeRollupValidationWith(task, dependencies, now)`.
- Consumes: coordinator validation candidate priority.
- Preserves: default `advanceRollupCutover()` behavior for compatibility and direct tests.

- [ ] **Step 1: Write failing heartbeat/validation split tests**

```ts
test("backfill 준비 전 heartbeat는 validation을 호출하지 않는다", async () => {
  const result = await reconcileRollupCutoverWith(deps, now);
  assert.equal(validationCalls, 0);
  assert.equal(result.validation, null);
});

test("준비된 계층은 validation 후보만 반환하고 coordinator가 선택할 때 한 번 실행한다", async () => {
  const result = await reconcileRollupCutoverWith(readyDeps, now);
  assert.equal(result.validation?.layer, "usage_15m_v2");
  await executeRollupValidationWith(result.validation!, readyDeps, now);
  assert.equal(validationCalls, 1);
});
```

- [ ] **Step 2: Run tests and confirm failure**

Run: `pnpm --filter @toard/web test -- rollup-cutover.test.ts rollup-coordinator.test.ts`

Expected: FAIL because reconciliation still performs validation inline.

- [ ] **Step 3: Refactor cutover state transitions**

```ts
export type RollupValidationTask = {
  layer: RollupCutoverLayer;
  target: Date;
  scope: "initial" | "recurring";
  activeTimezones: string[];
};
```

Reconciliation performs PostgreSQL readiness and healthy-second updates only. When validation is required it persists the non-heavy state update and returns one task. Execution rechecks readiness before validation, applies the existing mismatch/transient failure rules, and transitions to observing/active or updates recurring validation time.

- [ ] **Step 4: Integrate validation into coordinator priority**

Coordinator runs reconciliation while holding the global slot, adds returned validation as the highest candidate, and executes at most one validation or worker task. A validation task must not cascade into a second layer validation in the same tick.

- [ ] **Step 5: Run tests and typecheck**

Run: `pnpm --filter @toard/web test -- rollup-cutover.test.ts rollup-coordinator.test.ts clickhouse-outbox.test.ts && pnpm --filter @toard/web typecheck`

Expected: PASS, including existing T0, 3600-second observation, mismatch, transient fallback, and new-timezone validation tests.

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/rollup-cutover.ts apps/web/lib/rollup-cutover.test.ts apps/web/lib/rollup-coordinator.ts apps/web/lib/rollup-coordinator.test.ts
git commit -m "refactor(rollup): 전환 heartbeat와 검증을 분리"
```

### Task 5: Expose honest scheduler and waiting-for-base status

**Files:**
- Modify: `apps/web/lib/rollup-status.ts`
- Modify: `apps/web/lib/rollup-status.test.ts`
- Modify: `apps/web/app/(dashboard)/admin/rollup-status-panel.tsx`
- Modify: `apps/web/messages/ko/admin.json`
- Modify: `apps/web/messages/en/admin.json`
- Modify: `apps/web/lib/ui-commonization.test.ts`
- Modify: `docs/clickhouse-exact-rollup-runbook.md`
- Modify: `README.md`

**Interfaces:**
- Extends: `RollupWorkerState` with `waiting_for_base`.
- Extends: timezone worker view with `eligiblePendingJobs`, `waitingForBaseJobs`, `eligibleSince`.
- Adds: `RollupAdminStatus.scheduler` heartbeat/task/outcome.
- Consumes: scheduler repository and finalized backlog counts.

- [ ] **Step 1: Write failing status and UI contract tests**

```ts
test("pending이 있지만 eligible이 없으면 waiting_for_base다", async () => {
  const status = await getRollupStatusWith(deps({ pending: 10, eligible: 0 }));
  assert.equal(status.workers.timezone.state, "waiting_for_base");
  assert.equal(status.workers.timezone.waitingForBaseJobs, 10);
});

test("eligible backlog와 오래된 eligibleSince가 있을 때만 stalled다", async () => {
  const status = await getRollupStatusWith(deps({ eligible: 3, eligibleSince: old }));
  assert.equal(status.workers.timezone.state, "stalled");
});
```

- [ ] **Step 2: Run tests and confirm failure**

Run: `pnpm --filter @toard/web test -- rollup-status.test.ts ui-commonization.test.ts`

Expected: FAIL on missing state, backlog fields, scheduler block, and translations.

- [ ] **Step 3: Implement status derivation and ETA rules**

`waiting_for_base` is used only when total remaining is positive and eligible remaining is zero. `stalled` requires eligible work and `eligible_since` older than 120 seconds. Timezone eligible ETA uses only eligible jobs; total ETA is null until the 15-minute basis is complete enough to calculate it honestly.

- [ ] **Step 4: Render scheduler and backlog details**

```text
Coordinator: 정상 · 최근 작업 15분 기준 rollup · 14:32
지금 처리 가능: 24
15분 기준 대기: 306
처리 가능 ETA: 약 4분
```

Keep physical table names in the storage section and existing pause/resume actions. Do not add read-toggle or TTL mutation actions.

- [ ] **Step 5: Update runbook and README**

Document single coordinator ordering, finalized-window semantics, safe rollout, `waiting_for_base`, starvation warning, and rollback that leaves additive schema in place.

- [ ] **Step 6: Run focused tests and typecheck**

Run: `pnpm --filter @toard/web test -- rollup-status.test.ts ui-commonization.test.ts && pnpm --filter @toard/web typecheck && git diff --check`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/lib/rollup-status.ts apps/web/lib/rollup-status.test.ts 'apps/web/app/(dashboard)/admin/rollup-status-panel.tsx' apps/web/messages/ko/admin.json apps/web/messages/en/admin.json apps/web/lib/ui-commonization.test.ts docs/clickhouse-exact-rollup-runbook.md README.md
git commit -m "feat(admin): rollup coordinator 상태를 표시"
```

### Task 6: Verify migration, exactness, load, and release gates

**Files:**
- Create: `scripts/rollup-coordinator-migration.integration.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: real PostgreSQL migration verification for source windows and generation CAS.
- Preserves: `pnpm benchmark:dashboard-http` release contract and eight authenticated scenarios.

- [ ] **Step 1: Write failing PostgreSQL integration test**

```ts
test("migration 26은 기존 DST day job의 source_to와 generation을 보존한다", async () => {
  await migrateThrough(25);
  await insertLegacyTimezoneJobs();
  await migrateThrough(26);
  assert.equal(await dayWindowHours("America/Los_Angeles", springDay), 23);
  assert.equal(await dayWindowHours("America/Los_Angeles", fallDay), 25);
  assert.equal(await generationOf(legacyJob), 0);
});
```

- [ ] **Step 2: Run integration test and confirm failure**

Run: `node --import tsx --test scripts/rollup-coordinator-migration.integration.test.ts`

Expected: FAIL until the Docker-backed PostgreSQL fixture and migration assertions are complete.

- [ ] **Step 3: Complete integration harness and package script**

Add the test to `test:migrations` after the pricing migration test. Use an isolated PostgreSQL 16 container, random host port, and cleanup in `finally`; never connect to production.

- [ ] **Step 4: Run full correctness gates**

Run: `pnpm test && pnpm typecheck && pnpm build && git diff --check`

Expected: all suites, migration integrations, typecheck, and Next production build pass.

- [ ] **Step 5: Run exact rollup verifier**

Run: `pnpm tsx scripts/verify-clickhouse-exact-rollup.ts`

Expected: `{ "ok": true }` with zero event/token/cost/fingerprint mismatches.

- [ ] **Step 6: Run official release benchmark with active coordinator**

Run: `pnpm benchmark:dashboard-http`

Expected: fixed 1,000,000-event, 400-day, five-timezone fixture; eight authenticated scenarios x100; every p95 <= 2,000 ms; no 5xx; `RELEASE_PASS`.

- [ ] **Step 7: Run a 30-minute fairness soak or deterministic accelerated equivalent**

Use an accelerated deterministic fake clock to cover 30 minutes of scheduler time. Capture scheduler status and assert heavy concurrency <=1, both eligible workers' maximum selection gap <=120 seconds, outbox continues to drain, and no worker remains stalled. This deterministic soak is the mandatory release gate.

- [ ] **Step 8: Commit**

```bash
git add scripts/rollup-coordinator-migration.integration.test.ts package.json
git commit -m "test(rollup): coordinator 릴리스 게이트를 추가"
```

## 최종 자체 검토

- 설계의 starvation, 확정 구간, generation CAS, cutover, 관리자 상태, migration, benchmark 요구사항이 각각 Task 1~6에 매핑된다.
- 함수·필드 이름은 전 작업에서 `eligibleSince`, `nextAttemptAt`, `sourceTo`, `generation`, `validation`, `waiting_for_base`로 통일한다.
- 구현 중 범위 변경이 필요하면 코드를 임의 확장하지 않고 설계 문서를 먼저 갱신한다.
