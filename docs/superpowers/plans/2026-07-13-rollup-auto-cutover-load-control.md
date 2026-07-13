# Rollup Auto Cutover and Load Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 백필 완료 후 검증된 rollup 읽기를 자동 전환하고, worker 부하를 자동 조절하며, 관리자 화면의 상태와 용어를 통일한다.

**Architecture:** PostgreSQL에 runtime cutover 상태와 adaptive batch 상태를 영속화한다. scheduler는 고정 T0 상태 머신과 shared advisory load slot을 실행하고, ClickHouseStorage는 명시적 환경변수가 없을 때 runtime active 상태를 10초 캐시해 guarded rollup source를 허용한다.

**Tech Stack:** TypeScript, Next.js 15, PostgreSQL, ClickHouse, node:test, next-intl, pnpm 9

## Global Constraints

- 외부 용어는 `세밀한 원본`, `15분 기준 rollup`, `시간대별 1시간 rollup`, `시간대별 1일 rollup`, `대체 조회`, `재계산 필요`로 통일한다.
- DB 테이블 이름과 worker ID는 변경하지 않는다.
- `usage_15m_v2`와 `timezone`은 각각 3,600초의 누적 정상 관찰 후 자동 전환한다.
- 데이터 mismatch는 즉시 fallback하고 일시 오류는 3회 연속일 때 fallback한다.
- 원본 TTL은 자동 활성화하지 않는다.
- 환경변수 명시 ON/OFF는 runtime 자동 상태보다 우선한다.
- 모든 production behavior는 실패 테스트를 먼저 확인한 뒤 구현한다.

---

### Task 1: Runtime 상태 스키마와 repository

**Files:**
- Create: `migrations/1700000025_clickhouse_rollup_automation.sql`
- Create: `apps/web/lib/rollup-cutover-state.ts`
- Create: `apps/web/lib/rollup-cutover-state.test.ts`
- Modify: `apps/web/lib/rollup-worker-state.ts`
- Modify: `apps/web/lib/rollup-worker-state.test.ts`

**Interfaces:**
- Produces: `RollupCutoverLayer`, `RollupCutoverState`, `RollupCutoverRecord`, `PgRollupCutoverRepository`
- Produces: `RollupWorkerRecord.adaptiveLimit`, `RollupWorkerRecord.loadState`, `RollupWorkerRepository.withLoadSlot()`

- [ ] **Step 1: Write failing migration and repository tests**

```ts
test("cutover migration stores frozen target and accumulated healthy seconds", () => {
  assert.match(sql, /target_watermark TIMESTAMPTZ/);
  assert.match(sql, /healthy_seconds INTEGER NOT NULL DEFAULT 0/);
});

test("worker repository exposes adaptive load state", async () => {
  const record = await repository.get("usage_15m_v2");
  assert.equal(record.adaptiveLimit, 16);
  assert.equal(record.loadState, "normal");
});
```

- [ ] **Step 2: Run tests and confirm RED**

Run: `pnpm --filter @toard/web test -- rollup-cutover-state.test.ts rollup-worker-state.test.ts`

Expected: FAIL because the migration, repository, and adaptive fields do not exist.

- [ ] **Step 3: Add migration and repositories**

Create the cutover table with the two seeded layers and alter worker status with adaptive defaults. Implement typed row mapping, sanitized transition failure storage, `setState`, `recordHealthySeconds`, and a session advisory lock wrapper using `pg_try_advisory_lock(hashtext('toard:rollup-load-slot'))`.

```sql
CREATE TABLE clickhouse_rollup_cutover_status (
  layer TEXT PRIMARY KEY CHECK (layer IN ('usage_15m_v2', 'timezone')),
  state TEXT NOT NULL DEFAULT 'backfilling'
    CHECK (state IN ('backfilling', 'observing', 'active', 'fallback')),
  target_watermark TIMESTAMPTZ,
  healthy_seconds INTEGER NOT NULL DEFAULT 0,
  last_checked_at TIMESTAMPTZ,
  last_validation_at TIMESTAMPTZ,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_failure_kind TEXT CHECK (last_failure_kind IN ('mismatch', 'lag', 'unavailable')),
  last_failure TEXT,
  activated_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE clickhouse_rollup_worker_status
  ADD COLUMN adaptive_limit INTEGER NOT NULL DEFAULT 16,
  ADD COLUMN load_state TEXT NOT NULL DEFAULT 'normal'
    CHECK (load_state IN ('normal', 'throttled'));
UPDATE clickhouse_rollup_worker_status SET adaptive_limit = 8 WHERE worker = 'timezone';
```

```ts
export type RollupCutoverLayer = "usage_15m_v2" | "timezone";
export type RollupCutoverState = "backfilling" | "observing" | "active" | "fallback";
export type RollupFailureKind = "mismatch" | "lag" | "unavailable";

export interface RollupCutoverRepository {
  get(layer: RollupCutoverLayer): Promise<RollupCutoverRecord>;
  save(layer: RollupCutoverLayer, update: RollupCutoverUpdate): Promise<RollupCutoverRecord>;
}
```

- [ ] **Step 4: Run targeted tests and confirm GREEN**

Run: `pnpm --filter @toard/web test -- rollup-cutover-state.test.ts rollup-worker-state.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add migrations/1700000025_clickhouse_rollup_automation.sql apps/web/lib/rollup-cutover-state.ts apps/web/lib/rollup-cutover-state.test.ts apps/web/lib/rollup-worker-state.ts apps/web/lib/rollup-worker-state.test.ts
git commit -m "feat(rollup): 자동 전환 상태 저장소 추가"
```

### Task 2: Adaptive worker와 shared load slot

**Files:**
- Modify: `apps/web/lib/clickhouse-outbox.ts`
- Modify: `apps/web/lib/clickhouse-outbox.test.ts`
- Modify: `apps/web/lib/timezone-rollup.ts`
- Modify: `apps/web/lib/timezone-rollup.test.ts`
- Modify: `apps/web/lib/rollup-worker-state.ts`

**Interfaces:**
- Produces: `nextAdaptiveLimit({ limit, processed, durationMs, failed, minimum, maximum })`
- Produces: `runObservedWorkerTick()` outcome including `busy`
- Consumes: `RollupWorkerRepository.withLoadSlot()` and `adaptiveLimit`

- [ ] **Step 1: Write failing adaptive policy tests**

```ts
assert.equal(nextAdaptiveLimit({ limit: 16, processed: 16, durationMs: 1_000, failed: false, minimum: 1, maximum: 64 }), 20);
assert.equal(nextAdaptiveLimit({ limit: 20, processed: 20, durationMs: 12_000, failed: false, minimum: 1, maximum: 64 }), 10);
assert.equal(nextAdaptiveLimit({ limit: 8, processed: 0, durationMs: 100, failed: false, minimum: 1, maximum: 32 }), 8);
```

Add a test where an unavailable load slot returns `busy` and never calls the compactor.

- [ ] **Step 2: Run tests and confirm RED**

Run: `pnpm --filter @toard/web test -- clickhouse-outbox.test.ts timezone-rollup.test.ts`

Expected: FAIL because adaptive policy and limit injection are missing.

- [ ] **Step 3: Implement adaptive execution**

Pass the stored limit into `compactUsage15mV2(limit)` and `runTimezoneRollupWorker(limit)`. Increase only when a full batch finishes within 2 seconds, halve at 10 seconds or errors, cap at 64/32, and persist the new limit/load state. Wrap compaction in the shared advisory load slot. Keep pause/resume checks before acquiring the slot.

```ts
export function nextAdaptiveLimit(input: {
  limit: number;
  processed: number;
  durationMs: number;
  failed: boolean;
  minimum: number;
  maximum: number;
}): number {
  if (input.failed || input.durationMs >= 10_000) {
    return Math.max(input.minimum, Math.floor(input.limit / 2));
  }
  if (input.processed >= input.limit && input.durationMs <= 2_000) {
    return Math.min(input.maximum, Math.ceil(input.limit * 1.25));
  }
  return Math.min(input.maximum, Math.max(input.minimum, input.limit));
}
```

```ts
const slot = await repository.withLoadSlot(() => options.run(record.adaptiveLimit));
if (!slot.acquired) return "busy";
```

- [ ] **Step 4: Run tests and confirm GREEN**

Run: `pnpm --filter @toard/web test -- clickhouse-outbox.test.ts timezone-rollup.test.ts rollup-worker-state.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/clickhouse-outbox.ts apps/web/lib/clickhouse-outbox.test.ts apps/web/lib/timezone-rollup.ts apps/web/lib/timezone-rollup.test.ts apps/web/lib/rollup-worker-state.ts
git commit -m "perf(rollup): 백필 부하를 자동 조절"
```

### Task 3: 데이터 검증과 자동 전환 상태 머신

**Files:**
- Create: `apps/web/lib/rollup-cutover.ts`
- Create: `apps/web/lib/rollup-cutover.test.ts`
- Modify: `packages/storage-clickhouse/src/storage.ts`
- Modify: `packages/storage-clickhouse/src/storage.test.ts`
- Modify: `packages/storage-clickhouse/src/index.ts`
- Modify: `apps/web/lib/clickhouse-outbox.ts`

**Interfaces:**
- Produces: `ClickHouseStorage.validateUsage15mV2(targetTo)`
- Produces: `ClickHouseStorage.validateTimezoneRollups(timezones, now)`
- Produces: `advanceRollupCutoverWith(dependencies, now)`

- [ ] **Step 1: Write failing validator and transition tests**

Cover these behaviors with real state records and injected validators:

```ts
test("newer eligible watermark does not move an observing target", async () => {
  await advance({ state: "observing", targetWatermark: t0, healthySeconds: 600 }, nowPlusMinute);
  assert.equal(saved.targetWatermark?.toISOString(), t0.toISOString());
  assert.equal(saved.healthySeconds, 660);
});

test("a mismatch immediately moves an active layer to fallback", async () => {
  validatorResult = { ok: false, kind: "mismatch", detail: "fingerprint mismatch" };
  await advance(activeRecord, now);
  assert.equal(saved.state, "fallback");
});
```

Storage tests must assert that the v2 validation query includes pricing revision, cost status, all token columns, event count, cost, and `usage_events FINAL`.

- [ ] **Step 2: Run tests and confirm RED**

Run: `pnpm --filter @toard/storage-clickhouse test -- storage.test.ts && pnpm --filter @toard/web test -- rollup-cutover.test.ts`

Expected: FAIL because validators and transition controller are missing.

- [ ] **Step 3: Implement validators and controller**

Implement full-dimensional v2 summary/fingerprint comparison through T0. Implement active-timezone representative hour/day comparison. Advance backfilling, observing, active, and fallback states using accumulated healthy seconds. Schedule the controller every 60 seconds after compaction ticks and perform active validation at most every 6 hours.

```ts
export type RollupValidationResult = {
  ok: boolean;
  kind: "mismatch" | "lag" | "unavailable" | null;
  detail: string | null;
};

export async function advanceRollupCutoverWith(
  dependencies: RollupCutoverDependencies,
  now: Date,
): Promise<void> {
  await advanceLayer("usage_15m_v2", dependencies, now);
  const base = await dependencies.repository.get("usage_15m_v2");
  if (base.state === "active") await advanceLayer("timezone", dependencies, now);
  else await dependencies.repository.save("timezone", { state: "backfilling", healthySeconds: 0 });
}
```

The validator computes raw and rollup summaries with the same key columns and compares all numeric totals plus a deterministic row fingerprint:

```sql
SELECT count() AS rows,
       sum(event_count) AS events,
       sum(input_tokens) AS input_tokens,
       sum(output_tokens) AS output_tokens,
       sum(cache_read_tokens) AS cache_read_tokens,
       sum(cache_creation_tokens) AS cache_creation_tokens,
       sum(cost_usd) AS cost_usd,
       groupBitXor(cityHash64(
         bucket_15m, provider_key, user_id, team_id, session_id, model, host,
         pricing_revision_id, cost_status, event_count, input_tokens, output_tokens,
         cache_read_tokens, cache_creation_tokens, cost_usd
       )) AS fingerprint
FROM (...same-dimensional aggregate...)
```

- [ ] **Step 4: Run targeted tests and confirm GREEN**

Run: `pnpm --filter @toard/storage-clickhouse test -- storage.test.ts && pnpm --filter @toard/web test -- rollup-cutover.test.ts clickhouse-outbox.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/rollup-cutover.ts apps/web/lib/rollup-cutover.test.ts apps/web/lib/clickhouse-outbox.ts packages/storage-clickhouse/src/storage.ts packages/storage-clickhouse/src/storage.test.ts packages/storage-clickhouse/src/index.ts
git commit -m "feat(rollup): 검증 후 읽기를 자동 전환"
```

### Task 4: Runtime read policy와 안전한 대체 조회

**Files:**
- Modify: `packages/storage-clickhouse/src/storage.ts`
- Modify: `packages/storage-clickhouse/src/storage.test.ts`
- Modify: `packages/storage-clickhouse/src/index.ts`
- Modify: `apps/web/lib/rollup-status.ts`
- Modify: `apps/web/lib/rollup-status.test.ts`

**Interfaces:**
- Produces: `RollupReadMode = boolean | "auto"`
- Produces: `ClickHouseStorage` runtime state cache with a 10-second TTL
- Consumes: `clickhouse_rollup_cutover_status.state`

- [ ] **Step 1: Write failing read policy tests**

```ts
test("unset env reads an active runtime layer", async () => {
  const storage = createStorage({ read15mV2Rollup: "auto", runtimeState: "active" });
  await storage.getDailyTimeseries(query);
  assert.match(ch.lastQuery, /usage_15m_rollup_v2/);
});

test("runtime lookup failure fails closed to exact source", async () => {
  const storage = createStorage({ read15mV2Rollup: "auto", runtimeError: true });
  await storage.getDailyTimeseries(query);
  assert.match(ch.lastQuery, /usage_events/);
});
```

Also cover explicit ON and OFF overriding runtime state.

- [ ] **Step 2: Run tests and confirm RED**

Run: `pnpm --filter @toard/storage-clickhouse test -- storage.test.ts`

Expected: FAIL because read options only accept fixed booleans.

- [ ] **Step 3: Implement runtime read mode**

Use `auto` only when the relevant environment variable is absent. Cache both layer states for 10 seconds with in-flight deduplication. Keep existing watermark, coverage, and dirty checks unchanged. Update status calculation to report effective source and override mode.

```ts
export type RollupReadMode = boolean | "auto";

function envReadMode(value: string | undefined): RollupReadMode {
  if (value == null || value.trim() === "") return "auto";
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "on";
}
```

```ts
private async readLayerEnabled(layer: RollupCutoverLayer, mode: RollupReadMode): Promise<boolean> {
  if (mode !== "auto") return mode;
  try {
    const states = await this.runtimeReadStates();
    return states.get(layer) === "active";
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run tests and confirm GREEN**

Run: `pnpm --filter @toard/storage-clickhouse test -- storage.test.ts && pnpm --filter @toard/web test -- rollup-status.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/storage-clickhouse/src/storage.ts packages/storage-clickhouse/src/storage.test.ts packages/storage-clickhouse/src/index.ts apps/web/lib/rollup-status.ts apps/web/lib/rollup-status.test.ts
git commit -m "feat(rollup): runtime 읽기 정책을 적용"
```

### Task 5: 관리자 상태·진행률·용어 통일

**Files:**
- Modify: `apps/web/app/(dashboard)/admin/rollup-status-panel.tsx`
- Modify: `apps/web/messages/ko/admin.json`
- Modify: `apps/web/messages/en/admin.json`
- Modify: `apps/web/lib/rollup-status.ts`
- Modify: `apps/web/lib/rollup-status.test.ts`
- Modify: `apps/web/lib/ui-commonization.test.ts`

**Interfaces:**
- Consumes: status API `cutover`, `adaptiveLimit`, `loadState`, effective read source
- Produces: localized admin presentation without changing internal IDs

- [ ] **Step 1: Write failing UI contract tests**

Assert that Korean and English dictionaries contain the four standardized rollup names and that the panel renders cutover state, frozen target, healthy observation minutes, adaptive limit, and load state. Assert that no admin read/TTL mutation action is introduced.

- [ ] **Step 2: Run tests and confirm RED**

Run: `pnpm --filter @toard/web test -- rollup-status.test.ts ui-commonization.test.ts`

Expected: FAIL because the new status fields and terminology are absent.

- [ ] **Step 3: Update status API, panel, and translations**

Add an automatic cutover summary above worker cards. Rename visible labels while retaining worker IDs and physical table labels in the storage details. Show `adaptiveLimit` and `normal/throttled` on each worker card.

```ts
export type RollupAdminStatus = {
  // existing fields remain
  cutover: {
    mode: "auto" | "forced_on" | "forced_off";
    usage15mV2: RollupCutoverStatusView;
    timezone: RollupCutoverStatusView;
  };
};

export type RollupWorkerStatusView = RollupProgress & {
  // existing fields remain
  adaptiveLimit: number | null;
  loadState: "normal" | "throttled" | null;
};
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm --filter @toard/web test -- rollup-status.test.ts ui-commonization.test.ts && pnpm --filter @toard/web typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add 'apps/web/app/(dashboard)/admin/rollup-status-panel.tsx' apps/web/messages/ko/admin.json apps/web/messages/en/admin.json apps/web/lib/rollup-status.ts apps/web/lib/rollup-status.test.ts apps/web/lib/ui-commonization.test.ts
git commit -m "feat(admin): rollup 자동 전환 상태 표시"
```

### Task 6: 운영 문서와 전체 검증

**Files:**
- Modify: `docs/clickhouse-exact-rollup-runbook.md`
- Modify: `README.md`
- Modify: `docker-compose.yml`
- Modify: `apps/web/lib/ui-commonization.test.ts`

**Interfaces:**
- Documents: automatic default, emergency env override, TTL separation, terminology

- [ ] **Step 1: Write failing documentation contract assertions**

Require the runbook to describe schema migration, automatic worker/backfill, fixed T0, one-hour accumulated observation, automatic read state, fallback, and separate TTL approval. Require compose comments to describe read flags as emergency overrides.

- [ ] **Step 2: Run contract tests and confirm RED**

Run: `pnpm --filter @toard/web test -- ui-commonization.test.ts`

Expected: FAIL because the current runbook still requires manual read flag activation.

- [ ] **Step 3: Update documentation and compose comments**

Document the lifecycle and operational recovery commands without exposing secrets. Keep legacy flag deprecation notes and describe explicit OFF as the emergency rollback path.

- [ ] **Step 4: Run full fresh verification**

Run:

```bash
pnpm test
pnpm typecheck
pnpm build
git diff --check
```

Expected: every command exits 0 with zero test failures and zero type/build errors.

- [ ] **Step 5: Review against the design**

Check every requirement in `docs/superpowers/specs/2026-07-13-rollup-auto-cutover-load-control-design.md`, inspect `git diff origin/main...HEAD`, and resolve every Critical or Important review finding before publishing.

- [ ] **Step 6: Commit**

```bash
git add README.md docker-compose.yml docs/clickhouse-exact-rollup-runbook.md apps/web/lib/ui-commonization.test.ts
git commit -m "docs(rollup): 자동 전환 운영 절차 정리"
```
