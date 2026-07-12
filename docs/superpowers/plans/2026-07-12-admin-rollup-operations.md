# Admin Rollup Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** VPN 없이 관리자 시스템 화면에서 ClickHouse 백필 진행률·ETA·오류·데이터 규모를 확인하고, 두 shadow worker를 재시작 후에도 유지되는 방식으로 일시중지·재개하며 보조 데이터를 유한하게 보존한다.

**Architecture:** Next.js 앱 안의 1분 scheduler가 Postgres의 영구 worker 제어 행을 확인한 뒤 ClickHouse 15분 v2 또는 시간대 cache batch를 처리한다. Postgres는 control plane과 진행 메타데이터를, ClickHouse는 raw와 rollup data plane을 담당하며 관리자 API는 두 저장소의 상태를 안전한 DTO로 합성한다. read 전환과 정규화 raw TTL은 계속 운영 플래그로만 제어한다.

**Tech Stack:** TypeScript 5.7, Node.js 20+, Next.js 15 App Router, React 19, PostgreSQL/node-postgres, ClickHouse JS client, node:test, pnpm 9.15, Docker Compose

## Global Constraints

- `usage_15m_v2`, `timezone` shadow worker만 환경변수 미설정·빈 값·`1/true/on`에서 기본 ON이며 `0/false/off`는 hard disable이다.
- `CLICKHOUSE_READ_15M_V2_ROLLUP`, `CLICKHOUSE_READ_TIMEZONE_ROLLUP`, `CLICKHOUSE_ENFORCE_RETENTION_TTL`은 기본 OFF를 유지한다.
- 관리자 pause는 Postgres에 저장하고 현재 batch 완료 뒤 다음 tick부터 적용하며 재시작·업데이트 후에도 유지한다.
- resume은 HTTP 요청 안에서 ClickHouse 작업을 실행하지 않고 최대 60초 안의 다음 scheduler tick부터 적용한다.
- 초기 15분 v2 watermark와 dirty 처리는 최근 400일보다 오래된 raw를 백필하지 않는다.
- ClickHouse·Postgres `raw_events`는 7일, 구 `usage_hourly_rollup`은 전환 기간 400일, coverage는 hour 32 local days·day 400 local days로 제한한다.
- 구 hourly writer는 구 버전 롤백 관찰이 끝날 때까지 유지하며 이번 계획에서 제거하지 않는다.
- 상태·제어 API는 admin만 허용하고 비밀값, SQL, stack trace, 사용자별 원본 데이터를 반환하지 않는다.
- 상태 조회 일부 실패가 수집 API, 일반 대시보드, 다른 retention cleanup을 중단하지 않는다.
- 한국어·영어 메시지 shape를 동일하게 유지한다.
- 프로덕션 DB에 직접 쓰지 않는다. 검증은 로컬·격리 데이터에서만 수행한다.

---

## File Structure

### 새 파일

- `migrations/1700000024_clickhouse_rollup_worker_status.sql` — 두 worker의 영구 pause와 최근 실행 통계를 저장하는 Postgres schema.
- `apps/web/lib/rollup-worker-state.ts` — worker gate, 오류 정제, 이동평균, Postgres 상태 repository.
- `apps/web/lib/rollup-worker-state.test.ts` — 상태 우선순위, pause, EMA, 오류 정제, repository SQL 계약.
- `apps/web/lib/retention-cleanup.ts` — Postgres raw payload, ClickHouse outbox metadata, 시간대 coverage의 일일 cleanup orchestration.
- `apps/web/lib/retention-cleanup.test.ts` — cutoff, 외래키 분리, DST local boundary, 실패 격리 테스트.
- `apps/web/lib/rollup-status.ts` — 진행률·ETA·파생 상태와 30초 ClickHouse snapshot cache.
- `apps/web/lib/rollup-status.test.ts` — 상태/진행률/ETA/부분 실패 DTO 테스트.
- `apps/web/app/api/admin/rollups/status/route.ts` — admin 전용 상태 GET.
- `apps/web/app/api/admin/rollups/control/route.ts` — admin 전용 pause/resume POST.
- `apps/web/lib/rollup-admin-api.test.ts` — API 인증, 검증, 멱등성, hard-disable 테스트.
- `apps/web/app/(dashboard)/admin/rollup-status-panel.tsx` — 10초 polling과 두 worker 제어 UI.

### 수정 파일

- `apps/web/app/(dashboard)/insights/page.tsx` — 최신 main toolbar/KPI 변경과 가격 provenance 변경 충돌 통합.
- `apps/web/lib/ui-commonization.test.ts` — 최신 main 공통 UI와 가격 provenance assertion 병합.
- `apps/web/lib/clickhouse-outbox.ts` — observed worker tick과 영구 pause gate 연결, 기존 retention scheduler 분리.
- `apps/web/lib/clickhouse-outbox.test.ts` — worker 기본 ON·hard disable·readiness 회귀.
- `apps/web/instrumentation.ts` — backend 공통 retention scheduler 기동.
- `apps/web/lib/timezone-rollup.ts` — status용 prewarm target/cutoff helper 공개.
- `apps/web/lib/timezone-rollup.test.ts` — local cutoff와 paused claim 방지 회귀.
- `apps/web/app/(dashboard)/admin/page.tsx` — rollup panel 초기 상태 로드 및 시스템 탭 배치.
- `apps/web/messages/ko/admin.json`, `apps/web/messages/en/admin.json` — 상태·진행률·제어·retention 번역.
- `packages/storage-clickhouse/src/storage.ts` — 400일 v2 시작 clamp, ClickHouse 보조 TTL, 저장 규모 snapshot.
- `packages/storage-clickhouse/src/storage.test.ts` — schema, clamp, snapshot query 테스트.
- `clickhouse/init/001-schema.sql`, `clickhouse/init/004-rollup.sql` — 신규 설치의 raw payload 7일·legacy hourly 400일 TTL.
- `docs/clickhouse-exact-rollup-runbook.md`, `README.md` — 관리자 운영과 기본 ON shadow writer, retention 계약.

---

### Task 1: 최신 `origin/main` 통합과 기준선 복구

**Files:**
- Modify: `apps/web/app/(dashboard)/insights/page.tsx`
- Modify: `apps/web/lib/ui-commonization.test.ts`

**Interfaces:**
- Consumes: 현재 rollup 브랜치의 `PricingNotice`, `formatCostForCoverage`, `comparisonCoverage`와 `origin/main`의 `DashboardToolbar`, `DeltaBadge`, `pctDelta`.
- Produces: 가격 미확정 상태를 보존하면서 최신 toolbar/KPI UI를 사용하는 충돌 해소 기준선.

- [ ] **Step 1: 병합 전 기준선과 충돌 파일을 재확인한다**

Run:

```bash
git fetch origin main
git status --short --branch
git merge-tree --write-tree HEAD origin/main
```

Expected: worktree는 clean이고 충돌 파일은 `insights/page.tsx`, `ui-commonization.test.ts` 두 개다.

- [ ] **Step 2: 최신 main을 merge하되 자동 commit 전에 멈춘다**

Run:

```bash
git merge --no-commit --no-ff origin/main
```

Expected: 위 두 파일만 content conflict이고 README, team page, filters는 자동 병합된다.

- [ ] **Step 3: Insights 충돌에서 두 기능을 모두 보존한다**

`insights/page.tsx`의 합쳐진 핵심은 다음 계약을 만족해야 한다.

```ts
import { DashboardToolbar } from "@/components/dashboard/dashboard-toolbar";
import { PricingNotice } from "@/components/dashboard/pricing-notice";
import { DeltaBadge, type StatDelta } from "@/components/dashboard/stat-card";
import { formatCostForCoverage } from "@/lib/pricing";
import { pctDelta } from "@/lib/stat-delta";

const [t, navT, dashboardT, format, locale] = await Promise.all([
  getTranslations("insights"),
  getTranslations("nav"),
  getTranslations("dashboard"),
  getFormatter(),
  getLocale(),
]);

const comparisonCoverage = {
  pricedEvents: comparison.current.costCoverage.pricedEvents + comparison.previous.costCoverage.pricedEvents,
  unpricedEvents: comparison.current.costCoverage.unpricedEvents + comparison.previous.costCoverage.unpricedEvents,
  legacyEvents: comparison.current.costCoverage.legacyEvents + comparison.previous.costCoverage.legacyEvents,
};
const costComplete = comparisonCoverage.unpricedEvents === 0;
const tokenDelta = pctDelta(comparison.current.totalTokens, comparison.previous.totalTokens);
const sessionsDelta = pctDelta(comparison.current.sessions, comparison.previous.sessions);
const costDelta = costComplete
  ? pctDelta(comparison.current.costUsd, comparison.previous.costUsd)
  : null;
```

`DashboardToolbar`, `PricingNotice`, `DeltaBadge`를 모두 렌더하고 비용 값은 `formatCostForCoverage`로 표시한다. 비용 coverage가 불완전하면 비용 delta를 렌더하지 않고 `partial` 또는 `unpriced` 문구를 사용한다.

- [ ] **Step 4: UI 공통화 테스트 충돌에서 양쪽 assertion을 모두 보존한다**

`ui-commonization.test.ts`에 다음 두 테스트군이 동시에 남아야 한다.

```ts
test("insight KPI deltas use the shared dashboard badge and calculation", () => {
  const page = source("app/(dashboard)/insights/page.tsx");
  assert.match(page, /DashboardToolbar/);
  assert.match(page, /DeltaBadge/);
  assert.match(page, /pctDelta/);
});

test("insights와 history 비용 UI는 같은 query coverage formatter를 재사용한다", () => {
  const insights = source("app/(dashboard)/insights/page.tsx");
  assert.match(insights, /<PricingNotice coverage=\{comparisonCoverage\}/);
  assert.match(insights, /formatCostForCoverage/);
  assert.match(insights, /costComplete[\s\S]*costDelta/);
});
```

- [ ] **Step 5: 병합 기준선을 검증한다**

Run:

```bash
pnpm --filter @toard/web test
pnpm --filter @toard/web typecheck
pnpm --filter @toard/web build
git diff --check
```

Expected: web test/typecheck/build와 whitespace 검사가 모두 통과한다.

- [ ] **Step 6: 병합을 commit한다**

```bash
git add README.md apps/web
git commit -m "chore(merge): origin/main 최신 변경 통합"
```

Expected: merge state가 종료되고 worktree가 clean이다.

---

### Task 2: 영구 Worker 제어·관측 상태 모델

**Files:**
- Create: `migrations/1700000024_clickhouse_rollup_worker_status.sql`
- Create: `apps/web/lib/rollup-worker-state.ts`
- Create: `apps/web/lib/rollup-worker-state.test.ts`

**Interfaces:**
- Produces: `RollupWorkerName`, `RollupWorkerRecord`, `shadowWorkerEnabled`, `sanitizeRollupError`, `deriveWorkerState`, `PgRollupWorkerRepository`.
- Consumes: `pg.Pool`, UTC `Date`, worker 실행 결과 `{ units, rows }`.

- [ ] **Step 1: migration과 순수 상태 함수의 실패 테스트를 작성한다**

```ts
test("shadow worker는 미설정이면 켜지고 명시적 false면 hard disable된다", () => {
  assert.equal(shadowWorkerEnabled({}, "CLICKHOUSE_15M_V2_COMPACTOR"), true);
  assert.equal(shadowWorkerEnabled({ CLICKHOUSE_15M_V2_COMPACTOR: "" }, "CLICKHOUSE_15M_V2_COMPACTOR"), true);
  for (const value of ["0", "false", "off", "FALSE"]) {
    assert.equal(shadowWorkerEnabled({ CLICKHOUSE_15M_V2_COMPACTOR: value }, "CLICKHOUSE_15M_V2_COMPACTOR"), false);
  }
});

test("pause와 최근 진행 시각으로 운영 상태를 파생한다", () => {
  const now = new Date("2026-07-12T12:00:00.000Z");
  assert.equal(deriveWorkerState({ hardDisabled: false, paused: true, remaining: 4, now }), "paused");
  assert.equal(deriveWorkerState({ hardDisabled: false, paused: false, remaining: 0, now }), "ready");
  assert.equal(deriveWorkerState({
    hardDisabled: false,
    paused: false,
    remaining: 4,
    lastProgressAt: new Date("2026-07-12T11:55:00.000Z"),
    now,
  }), "stalled");
});
```

- [ ] **Step 2: 테스트가 정의되지 않은 symbol로 실패하는지 확인한다**

Run:

```bash
pnpm --filter @toard/web exec node --import tsx --test lib/rollup-worker-state.test.ts
```

Expected: `rollup-worker-state` module 또는 export가 없어 FAIL.

- [ ] **Step 3: worker status migration을 작성한다**

```sql
-- Up Migration
CREATE TABLE clickhouse_rollup_worker_status (
  worker TEXT PRIMARY KEY CHECK (worker IN ('usage_15m_v2', 'timezone')),
  paused BOOLEAN NOT NULL DEFAULT false,
  last_started_at TIMESTAMPTZ,
  last_finished_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_progress_at TIMESTAMPTZ,
  last_error_at TIMESTAMPTZ,
  last_error TEXT,
  last_duration_ms BIGINT,
  last_processed_units INTEGER NOT NULL DEFAULT 0,
  last_processed_rows BIGINT NOT NULL DEFAULT 0,
  processed_units_total BIGINT NOT NULL DEFAULT 0,
  processed_rows_total BIGINT NOT NULL DEFAULT 0,
  throughput_units_per_minute DOUBLE PRECISION,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO clickhouse_rollup_worker_status (worker)
VALUES ('usage_15m_v2'), ('timezone')
ON CONFLICT (worker) DO NOTHING;

-- Down Migration
DROP TABLE clickhouse_rollup_worker_status;
```

- [ ] **Step 4: 상태 domain과 repository를 구현한다**

```ts
export type RollupWorkerName = "usage_15m_v2" | "timezone";
export type RollupWorkerState =
  | "not_applicable" | "disabled" | "paused" | "starting"
  | "catching_up" | "ready" | "stalled" | "error";

export type RollupWorkerRecord = {
  worker: RollupWorkerName;
  paused: boolean;
  lastStartedAt: Date | null;
  lastFinishedAt: Date | null;
  lastSuccessAt: Date | null;
  lastProgressAt: Date | null;
  lastErrorAt: Date | null;
  lastError: string | null;
  lastDurationMs: number | null;
  lastProcessedUnits: number;
  lastProcessedRows: number;
  processedUnitsTotal: number;
  processedRowsTotal: number;
  throughputUnitsPerMinute: number | null;
};

export interface RollupWorkerRepository {
  get(worker: RollupWorkerName): Promise<RollupWorkerRecord>;
  setPaused(worker: RollupWorkerName, paused: boolean): Promise<RollupWorkerRecord>;
  markStarted(worker: RollupWorkerName, at: Date): Promise<void>;
  markSucceeded(
    worker: RollupWorkerName,
    startedAt: Date,
    finishedAt: Date,
    result: { units: number; rows: number },
  ): Promise<void>;
  markFailed(worker: RollupWorkerName, startedAt: Date, finishedAt: Date, error: string): Promise<void>;
}

export function shadowWorkerEnabled(
  env: Record<string, string | undefined>,
  key: "CLICKHOUSE_15M_V2_COMPACTOR" | "CLICKHOUSE_TIMEZONE_ROLLUP_COMPACTOR",
): boolean {
  const value = env[key]?.trim().toLowerCase();
  return value !== "0" && value !== "false" && value !== "off";
}

export function sanitizeRollupError(error: unknown): string {
  return String(error)
    .replace(/:\/\/[^\s/@]+:[^\s/@]+@/g, "://[redacted]@")
    .replace(/(password|token|secret)=([^\s&]+)/gi, "$1=[redacted]")
    .slice(0, 500);
}
```

`PgRollupWorkerRepository`는 `get(worker)`, `setPaused(worker, paused)`, `markStarted`, `markSucceeded`, `markFailed`를 제공한다. 성공 갱신은 누적값을 `processed_units_total + $n`으로 원자 증가시키고, 처리 속도 sample은 최소 1분 window로 계산한 뒤 기존 EMA 70%와 새 sample 30%를 합친다.

- [ ] **Step 5: migration·repository·순수 함수 테스트를 통과시킨다**

Run:

```bash
pnpm --filter @toard/web exec node --import tsx --test lib/rollup-worker-state.test.ts
pnpm --filter @toard/web typecheck
```

Expected: 새 테스트와 typecheck PASS.

- [ ] **Step 6: commit한다**

```bash
git add migrations/1700000024_clickhouse_rollup_worker_status.sql apps/web/lib/rollup-worker-state.ts apps/web/lib/rollup-worker-state.test.ts
git commit -m "feat(rollup): 영구 worker 운영 상태 추가"
```

---

### Task 3: Worker 기본 ON·Pause Gate·400일 Clamp

**Files:**
- Modify: `apps/web/lib/clickhouse-outbox.ts`
- Modify: `apps/web/lib/clickhouse-outbox.test.ts`
- Modify: `packages/storage-clickhouse/src/storage.ts`
- Modify: `packages/storage-clickhouse/src/storage.test.ts`

**Interfaces:**
- Consumes: Task 2의 `PgRollupWorkerRepository`, `shadowWorkerEnabled`, `sanitizeRollupError`.
- Produces: `runObservedWorkerTick`, 기본 ON인 두 scheduler, `usage_15m_v2` 400일 시작 clamp.

- [ ] **Step 1: pause와 clamp 실패 테스트를 추가한다**

```ts
function fakeWorkerRepository(seed: { paused: boolean }): RollupWorkerRepository {
  const record = (worker: RollupWorkerName, paused = seed.paused): RollupWorkerRecord => ({
    worker,
    paused,
    lastStartedAt: null,
    lastFinishedAt: null,
    lastSuccessAt: null,
    lastProgressAt: null,
    lastErrorAt: null,
    lastError: null,
    lastDurationMs: null,
    lastProcessedUnits: 0,
    lastProcessedRows: 0,
    processedUnitsTotal: 0,
    processedRowsTotal: 0,
    throughputUnitsPerMinute: null,
  });
  return {
    get: async (worker) => record(worker),
    setPaused: async (worker, paused) => record(worker, paused),
    markStarted: async () => undefined,
    markSucceeded: async () => undefined,
    markFailed: async () => undefined,
  };
}

test("paused 15분 worker는 compactor를 호출하지 않는다", async () => {
  let calls = 0;
  const result = await runObservedWorkerTick({
    worker: "usage_15m_v2",
    hardEnabled: true,
    repository: fakeWorkerRepository({ paused: true }),
    run: async () => { calls++; return { units: 1, rows: 10 }; },
    now: () => new Date("2026-07-12T12:00:00.000Z"),
  });
  assert.equal(result, "paused");
  assert.equal(calls, 0);
});

test("v2 최초 watermark는 최근 400일보다 오래 시작하지 않는다", () => {
  const eligible = new Date("2026-07-12T12:00:00.000Z");
  assert.equal(
    clampV2RollupStart(new Date("2024-01-01T00:00:00.000Z"), eligible).toISOString(),
    "2025-06-07T12:00:00.000Z",
  );
});
```

- [ ] **Step 2: 새 테스트의 실패를 확인한다**

Run:

```bash
pnpm --filter @toard/web exec node --import tsx --test lib/clickhouse-outbox.test.ts
pnpm --filter @toard/storage-clickhouse test
```

Expected: observed tick과 clamp export가 없어 FAIL.

- [ ] **Step 3: observed tick wrapper를 구현한다**

```ts
export async function runObservedWorkerTick(options: {
  worker: RollupWorkerName;
  hardEnabled: boolean;
  repository: RollupWorkerRepository;
  run(): Promise<{ units: number; rows: number }>;
  now(): Date;
}): Promise<"disabled" | "paused" | "completed" | "failed"> {
  if (!options.hardEnabled) return "disabled";
  const record = await options.repository.get(options.worker);
  if (record.paused) return "paused";
  const startedAt = options.now();
  await options.repository.markStarted(options.worker, startedAt).catch(console.warn);
  try {
    const result = await options.run();
    await options.repository.markSucceeded(options.worker, startedAt, options.now(), result).catch(console.warn);
    return "completed";
  } catch (error) {
    await options.repository.markFailed(options.worker, startedAt, options.now(), sanitizeRollupError(error)).catch(console.warn);
    return "failed";
  }
}
```

pause 조회 실패는 wrapper 밖으로 전파해 해당 tick을 실행하지 않는다. 관측 write 실패만 경고 후 실제 compactor 결과를 유지한다.

- [ ] **Step 4: 두 scheduler를 기본 ON gate에 연결한다**

`startClickHouse15mV2Compaction`과 `startClickHouseTimezoneRollupCompaction`은 시작 시 기존 positive-only `enabled()` 검사를 제거하고 `shadowWorkerEnabled(process.env, key)`를 사용한다. 각 1분 tick은 `runObservedWorkerTick`을 호출하며 v2 결과는 `{ units: buckets, rows }`, timezone 결과는 `{ units: jobs, rows }`로 변환한다. 환경변수 명시적 false면 interval 자체를 만들지 않는다.

- [ ] **Step 5: v2 시작점과 stale dirty bucket을 400일로 clamp한다**

```ts
export function clampV2RollupStart(firstBucket: Date, eligibleTo: Date): Date {
  const minimum = new Date(eligibleTo.getTime() - 400 * 24 * 60 * 60 * 1_000);
  return firstBucket > minimum ? firstBucket : minimum;
}
```

`readOrInitWatermark`에서 `spec.name === "usage_15m_v2"`일 때만 clamp하고, v2 dirty query에도 `bucket >= minimum` 조건을 적용한다. v1 호환 compactor의 watermark 계약은 바꾸지 않는다.

- [ ] **Step 6: 관련 테스트와 typecheck를 통과시킨다**

Run:

```bash
pnpm --filter @toard/web exec node --import tsx --test lib/clickhouse-outbox.test.ts
pnpm --filter @toard/storage-clickhouse test
pnpm --filter @toard/web typecheck
pnpm --filter @toard/storage-clickhouse typecheck
```

Expected: pause/default ON/clamp/기존 compactor tests PASS.

- [ ] **Step 7: commit한다**

```bash
git add apps/web/lib/clickhouse-outbox.ts apps/web/lib/clickhouse-outbox.test.ts packages/storage-clickhouse/src/storage.ts packages/storage-clickhouse/src/storage.test.ts
git commit -m "feat(rollup): 백필 worker 운영 제어 연결"
```

---

### Task 4: 보조 데이터 Retention Lifecycle

**Files:**
- Create: `apps/web/lib/retention-cleanup.ts`
- Create: `apps/web/lib/retention-cleanup.test.ts`
- Modify: `apps/web/instrumentation.ts`
- Modify: `apps/web/lib/clickhouse-outbox.ts`
- Modify: `apps/web/lib/timezone-rollup.ts`
- Modify: `apps/web/lib/timezone-rollup.test.ts`
- Modify: `packages/storage-clickhouse/src/storage.ts`
- Modify: `packages/storage-clickhouse/src/storage.test.ts`
- Modify: `clickhouse/init/001-schema.sql`
- Modify: `clickhouse/init/004-rollup.sql`

**Interfaces:**
- Produces: `prunePostgresRawEventsAt`, `pruneTimezoneCoverageAt`, `runUsageRetentionAt`, `startUsageRetentionCleanup`, `timezoneCoverageCutoffs`.
- Consumes: `firstInstantOfLocalDate`, `addLocalCalendarDays`, Postgres pool, 기존 ClickHouse outbox cleanup.

- [ ] **Step 1: retention 실패 테스트를 작성한다**

```ts
function retentionFixture() {
  const sql: string[] = [];
  const transactions: string[] = [];
  const client = {
    async query(statement: string) {
      sql.push(statement);
      if (statement === "BEGIN" || statement === "COMMIT" || statement === "ROLLBACK") {
        transactions.push(statement);
      }
      if (statement.includes("DELETE FROM raw_events")) return { rowCount: 2, rows: [] };
      return { rowCount: 0, rows: [] };
    },
    release() {},
  };
  return {
    sql,
    transactions,
    pool: { connect: async () => client },
  };
}

test("Postgres raw payload cleanup은 참조를 분리한 뒤 같은 transaction에서 삭제한다", async () => {
  const fixture = retentionFixture();
  const result = await prunePostgresRawEventsAt(fixture.pool, new Date("2026-07-12T00:00:00.000Z"), 1000);
  assert.equal(result.rawEvents, 2);
  assert.match(fixture.sql.join("\n"), /UPDATE usage_events[\s\S]*SET raw_event_id = NULL/);
  assert.match(fixture.sql.join("\n"), /DELETE FROM raw_events/);
  assert.deepEqual(fixture.transactions, ["BEGIN", "COMMIT"]);
});

test("coverage cutoff은 DST local day 경계를 사용한다", () => {
  const cutoffs = timezoneCoverageCutoffs("America/Los_Angeles", new Date("2026-11-02T12:00:00.000Z"));
  assert.equal(cutoffs.day.toISOString(), firstInstantOfLocalDate(addLocalCalendarDays("2026-11-02", -399), "America/Los_Angeles").toISOString());
});
```

- [ ] **Step 2: 테스트가 새 module 부재로 실패하는지 확인한다**

Run:

```bash
pnpm --filter @toard/web exec node --import tsx --test lib/retention-cleanup.test.ts
```

Expected: module 또는 exports 부재로 FAIL.

- [ ] **Step 3: Postgres raw payload를 bounded transaction으로 정리한다**

핵심 SQL은 다음과 같다.

```sql
WITH expired AS (
  SELECT id
  FROM raw_events
  WHERE received_at < $1
  ORDER BY id
  LIMIT $2
  FOR UPDATE SKIP LOCKED
), detached AS (
  UPDATE usage_events
  SET raw_event_id = NULL
  WHERE raw_event_id IN (SELECT id FROM expired)
)
DELETE FROM raw_events
WHERE id IN (SELECT id FROM expired);
```

cutoff는 `now - 7일`이며 한 tick의 기본 limit는 1,000이다.

- [ ] **Step 4: 시간대 coverage를 local window 밖에서만 정리한다**

`timezoneCoverageCutoffs(timezone, now)`는 day cutoff를 최근 400 local day의 첫 날짜 instant, hour cutoff를 최근 32 local day의 첫 날짜 instant로 반환한다. registry의 최대 64개 timezone을 읽고 `(resolution, timezone, cutoff)` 배열을 `unnest`해 coverage를 삭제한다. pending/inflight job table은 이 함수에서 변경하지 않는다.

- [ ] **Step 5: backend 공통 일일 scheduler로 분리한다**

```ts
export function startUsageRetentionCleanup(): void {
  const globalState = globalThis as { __toardUsageRetentionStarted?: true };
  if (globalState.__toardUsageRetentionStarted) return;
  globalState.__toardUsageRetentionStarted = true;
  setTimeout(() => void runUsageRetentionAt(new Date()), 45_000).unref();
  setInterval(() => void runUsageRetentionAt(new Date()), 24 * 60 * 60 * 1_000).unref();
}
```

`retentionSchedulerEligible(env)`는 `VERCEL`이면 false, 그 외에는 `NODE_ENV=production`일 때 true를 반환한다. `instrumentation.register()`는 이 조건에서 backend와 관계없이 scheduler를 시작한다. 기존 `startClickHouseOutboxFlush()` 안의 retention interval은 제거해 중복 실행을 막는다. 각 cleanup은 독립 try/catch로 격리하고 실패한 항목만 다음 일일 tick에 재시도한다.

- [ ] **Step 6: ClickHouse 보조 테이블 TTL을 runtime과 init schema에 추가한다**

```sql
ALTER TABLE raw_events
  MODIFY TTL toDateTime(received_at) + INTERVAL 7 DAY DELETE;

ALTER TABLE usage_hourly_rollup
  MODIFY TTL toDateTime(bucket_hour) + INTERVAL 400 DAY DELETE;
```

정규화 `usage_events` 97일 TTL은 기존 opt-in 조건을 유지한다. 구 hourly writer도 유지한다.

- [ ] **Step 7: retention 관련 테스트를 통과시킨다**

Run:

```bash
pnpm --filter @toard/web exec node --import tsx --test lib/retention-cleanup.test.ts
pnpm --filter @toard/web exec node --import tsx --test lib/timezone-rollup.test.ts
pnpm --filter @toard/storage-clickhouse test
pnpm --filter @toard/web typecheck
```

Expected: raw 7일, legacy 400일, DST coverage, 실패 격리 tests PASS.

- [ ] **Step 8: commit한다**

```bash
git add apps/web/lib/retention-cleanup.ts apps/web/lib/retention-cleanup.test.ts apps/web/instrumentation.ts apps/web/lib/clickhouse-outbox.ts apps/web/lib/timezone-rollup.ts apps/web/lib/timezone-rollup.test.ts packages/storage-clickhouse/src/storage.ts packages/storage-clickhouse/src/storage.test.ts clickhouse/init/001-schema.sql clickhouse/init/004-rollup.sql
git commit -m "feat(retention): 보조 rollup 데이터 수명 제한"
```

---

### Task 5: Rollup 상태·진행률·Storage Snapshot Service

**Files:**
- Create: `apps/web/lib/rollup-status.ts`
- Create: `apps/web/lib/rollup-status.test.ts`
- Modify: `packages/storage-clickhouse/src/storage.ts`
- Modify: `packages/storage-clickhouse/src/storage.test.ts`

**Interfaces:**
- Produces: `RollupAdminStatus`, `RollupWorkerStatusView`, `getRollupAdminStatus`, `deriveRollupProgress`, `ClickHouseStorage.getRollupStorageStats()`.
- Consumes: Task 2 worker record, watermark/dirty/job/coverage SQL, Task 4 retention windows.

- [ ] **Step 1: 진행률·ETA·부분 실패 테스트를 작성한다**

```ts
test("15분 진행률과 ETA는 watermark·dirty·최근 속도로 계산한다", () => {
  const view = deriveRollupProgress({
    targetFrom: new Date("2026-07-01T00:00:00.000Z"),
    targetTo: new Date("2026-07-02T00:00:00.000Z"),
    watermark: new Date("2026-07-01T12:00:00.000Z"),
    dirty: 4,
    throughputPerMinute: 16,
    bucketMs: 15 * 60 * 1000,
  });
  assert.equal(view.progressPercent, 50);
  assert.equal(view.remainingUnits, 52);
  assert.equal(view.etaMinutes, 4);
});

test("ClickHouse 규모 조회 실패는 worker 제어 상태를 유지한 degraded 응답이 된다", async () => {
  const workerRecord = (worker: RollupWorkerName): RollupWorkerRecord => ({
    worker,
    paused: false,
    lastStartedAt: null,
    lastFinishedAt: null,
    lastSuccessAt: null,
    lastProgressAt: null,
    lastErrorAt: null,
    lastError: null,
    lastDurationMs: null,
    lastProcessedUnits: 0,
    lastProcessedRows: 0,
    processedUnitsTotal: 0,
    processedRowsTotal: 0,
    throughputUnitsPerMinute: null,
  });
  const status = await getRollupAdminStatusWith({
    env: { STORAGE_BACKEND: "clickhouse" },
    now: () => new Date("2026-07-12T12:00:00.000Z"),
    loadWorkerRecords: async () => [workerRecord("usage_15m_v2"), workerRecord("timezone")],
    loadPostgresProgress: async () => ({
      watermark: new Date("2026-07-12T11:30:00.000Z"),
      dirty: 0,
      pending: 0,
      inflight: 0,
      activeTimezones: [],
      coverage: { hour: 0, day: 0 },
      postgresRawEvents: 0,
    }),
    loadStorageStats: async () => { throw new Error("timeout"); },
  });
  assert.equal(status.degraded, true);
  assert.equal(status.workers.usage15mV2.paused, false);
  assert.equal(status.storage, null);
});
```

- [ ] **Step 2: 새 테스트의 실패를 확인한다**

Run:

```bash
pnpm --filter @toard/web exec node --import tsx --test lib/rollup-status.test.ts
```

Expected: status module 부재로 FAIL.

- [ ] **Step 3: ClickHouse storage snapshot을 구현한다**

```ts
export type RollupStorageStats = {
  collectedAt: string;
  rawRange: { from: string | null; to: string | null };
  tables: Record<
    "raw_events" | "usage_events" | "usage_hourly_rollup" |
    "usage_15m_rollup_v2" | "usage_hourly_timezone_rollup" |
    "usage_daily_timezone_rollup",
    { rows: number; bytes: number }
  >;
};
```

`system.parts`의 active part만 합산하고 raw range는 `min(ts), max(ts)`로 조회한다. query에는 `max_execution_time=2`를 적용한다. web service는 성공 snapshot을 30초 동안 process-local cache하고 실패 결과는 cache하지 않는다.

- [ ] **Step 4: 상태 DTO와 파생 규칙을 구현한다**

`RollupAdminStatus`는 backend, collectedAt, degraded, read source flags, normalized raw TTL, workers, activeTimezones, coverage, jobs, storage, Postgres raw/coverage counts를 포함한다. 상태 우선순위는 `not_applicable → disabled → paused → error → ready → starting/catching_up/stalled`로 고정한다. ETA 표본이 없으면 v2 16 units/min, timezone 8 units/min을 사용하고 `etaBasis: "configured"`를 반환한다.

의존성 경계는 다음처럼 고정해 unit test가 실제 DB 없이 상태 합성을 검증하게 한다.

```ts
export type RollupStatusDependencies = {
  env: Record<string, string | undefined>;
  now(): Date;
  loadWorkerRecords(): Promise<RollupWorkerRecord[]>;
  loadPostgresProgress(): Promise<{
    watermark: Date | null;
    dirty: number;
    pending: number;
    inflight: number;
    activeTimezones: string[];
    coverage: { hour: number; day: number };
    postgresRawEvents: number;
  }>;
  loadStorageStats(): Promise<RollupStorageStats>;
};

export function getRollupAdminStatusWith(
  dependencies: RollupStatusDependencies,
): Promise<RollupAdminStatus>;
```

- [ ] **Step 5: status·storage tests를 통과시킨다**

Run:

```bash
pnpm --filter @toard/web exec node --import tsx --test lib/rollup-status.test.ts
pnpm --filter @toard/storage-clickhouse test
pnpm --filter @toard/web typecheck
pnpm --filter @toard/storage-clickhouse typecheck
```

Expected: progress, state, cache, timeout, storage aggregation tests PASS.

- [ ] **Step 6: commit한다**

```bash
git add apps/web/lib/rollup-status.ts apps/web/lib/rollup-status.test.ts packages/storage-clickhouse/src/storage.ts packages/storage-clickhouse/src/storage.test.ts
git commit -m "feat(rollup): 관리자 상태 집계 서비스 추가"
```

---

### Task 6: Admin 상태·제어 API

**Files:**
- Create: `apps/web/app/api/admin/rollups/status/route.ts`
- Create: `apps/web/app/api/admin/rollups/control/route.ts`
- Create: `apps/web/lib/rollup-admin-api.test.ts`

**Interfaces:**
- Consumes: `getSessionUser`, `getRollupAdminStatus`, `PgRollupWorkerRepository.setPaused`, `shadowWorkerEnabled`.
- Produces: `GET /api/admin/rollups/status`, `POST /api/admin/rollups/control`.

- [ ] **Step 1: 인증·검증·멱등성 실패 테스트를 작성한다**

```ts
test("rollup status는 비로그인과 비관리자를 차단한다", async () => {
  assert.equal((await statusGet.withDependencies({ getSessionUser: async () => null })()).status, 401);
  assert.equal((await statusGet.withDependencies({ getSessionUser: async () => ({ role: "member" }) as never })()).status, 403);
});

test("hard disabled worker는 관리자 resume을 거부한다", async () => {
  const post = controlPost.withDependencies({
    getSessionUser: async () => ({ role: "admin" }) as never,
    hardEnabled: () => false,
    setPaused: async (worker, paused) => ({ worker, paused }),
  });
  const response = await post(new Request("http://toard/api/admin/rollups/control", {
    method: "POST",
    body: JSON.stringify({ worker: "usage_15m_v2", action: "resume" }),
  }));
  assert.equal(response.status, 409);
});
```

- [ ] **Step 2: 테스트가 route 부재로 실패하는지 확인한다**

Run:

```bash
pnpm --filter @toard/web exec node --import tsx --test lib/rollup-admin-api.test.ts
```

Expected: route import 실패.

- [ ] **Step 3: dependency-injectable GET을 구현한다**

```ts
function createGet(deps = defaultDeps) {
  return async function GET(): Promise<Response> {
    const user = await deps.getSessionUser();
    if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (user.role !== "admin") return Response.json({ error: "forbidden" }, { status: 403 });
    return Response.json(await deps.getRollupAdminStatus(), {
      headers: { "cache-control": "no-store" },
    });
  };
}
export const GET = Object.assign(createGet(), { withDependencies: createGet });
```

- [ ] **Step 4: 입력을 좁게 검증하는 POST를 구현한다**

```ts
const workers = new Set(["usage_15m_v2", "timezone"]);
const actions = new Set(["pause", "resume"]);

if (!workers.has(body.worker) || !actions.has(body.action)) {
  return Response.json({ error: "invalid request" }, { status: 400 });
}
if (body.action === "resume" && !deps.hardEnabled(body.worker)) {
  return Response.json({ error: "disabled by server configuration" }, { status: 409 });
}
const record = await deps.setPaused(body.worker, body.action === "pause");
return Response.json({ worker: record.worker, paused: record.paused });
```

JSON parse 실패도 400으로 처리하고 stack/SQL을 응답하지 않는다.

- [ ] **Step 5: API 테스트와 typecheck를 통과시킨다**

Run:

```bash
pnpm --filter @toard/web exec node --import tsx --test lib/rollup-admin-api.test.ts
pnpm --filter @toard/web typecheck
```

Expected: auth 401/403, validation 400, hard-disable 409, pause/resume 200 PASS.

- [ ] **Step 6: commit한다**

```bash
git add apps/web/app/api/admin/rollups apps/web/lib/rollup-admin-api.test.ts
git commit -m "feat(admin): rollup 상태와 제어 API 추가"
```

---

### Task 7: 관리자 시스템 탭 Rollup Panel

**Files:**
- Create: `apps/web/app/(dashboard)/admin/rollup-status-panel.tsx`
- Modify: `apps/web/app/(dashboard)/admin/page.tsx`
- Modify: `apps/web/messages/ko/admin.json`
- Modify: `apps/web/messages/en/admin.json`
- Modify: `apps/web/lib/ui-commonization.test.ts`

**Interfaces:**
- Consumes: Task 5 `RollupAdminStatus`, Task 6 API.
- Produces: 시스템 탭의 초기 server-rendered 상태, 10초 polling, pause/resume controls.

- [ ] **Step 1: UI 계약 실패 테스트를 추가한다**

```ts
test("관리자 시스템 탭은 rollup 상태를 표시하되 read와 TTL을 제어하지 않는다", () => {
  const page = source("app/(dashboard)/admin/page.tsx");
  const panel = source("app/(dashboard)/admin/rollup-status-panel.tsx");
  assert.match(page, /<RollupStatusPanel initialStatus=\{rollupStatus\}/);
  assert.match(panel, /10_000/);
  assert.match(panel, /document\.visibilityState === "visible"/);
  assert.match(panel, /\/api\/admin\/rollups\/control/);
  assert.doesNotMatch(panel, /CLICKHOUSE_READ_|CLICKHOUSE_ENFORCE_RETENTION_TTL/);
});
```

- [ ] **Step 2: UI 테스트가 panel 부재로 실패하는지 확인한다**

Run:

```bash
pnpm --filter @toard/web exec node --import tsx --test lib/ui-commonization.test.ts
```

Expected: panel file 또는 assertions 부재로 FAIL.

- [ ] **Step 3: client panel polling과 제어를 구현한다**

```ts
const POLL_MS = 10_000;

useEffect(() => {
  const id = window.setInterval(() => {
    if (document.visibilityState === "visible") void refresh();
  }, POLL_MS);
  return () => window.clearInterval(id);
}, []);

async function control(worker: RollupWorkerName, action: "pause" | "resume") {
  const response = await fetch("/api/admin/rollups/control", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ worker, action }),
  });
  if (!response.ok) throw new Error((await response.json()).error ?? `HTTP ${response.status}`);
  await refresh();
}
```

요약에는 전체 badge, 갱신 시각, read source, normalized raw TTL을 표시한다. worker별로 accessible progressbar, watermark/coverage, remaining, ETA basis, 최근 batch, 마지막 성공/오류, pause/resume 버튼을 표시한다. hard disabled resume은 비활성화한다.

- [ ] **Step 4: 시스템 탭에 partial-failure-safe 초기 상태를 연결한다**

```ts
const rollupStatus = await getRollupAdminStatus().catch(() => null);

<SettingsRow
  wide
  label={t("system.rollupTitle")}
  description={t("system.rollupDescription")}
>
  <RollupStatusPanel initialStatus={rollupStatus} />
</SettingsRow>
```

`null`은 시스템 탭 전체 throw가 아니라 panel의 상태 확인 실패 UI가 된다.

- [ ] **Step 5: 한국어·영어 메시지를 같은 shape로 추가한다**

키는 `system.rollupTitle`, `rollupDescription`, `rollup.states.*`, `rollup.worker.*`, `rollup.progress`, `rollup.eta`, `rollup.etaConfigured`, `rollup.lastError`, `rollup.pause`, `rollup.resume`, `rollup.disabledByServer`, `rollup.storage.*`, `rollup.readSource`, `rollup.rawTtl`을 양쪽 catalog에 동일하게 둔다.

- [ ] **Step 6: UI test/typecheck/build를 통과시킨다**

Run:

```bash
pnpm --filter @toard/web exec node --import tsx --test lib/ui-commonization.test.ts
pnpm --filter @toard/web typecheck
pnpm --filter @toard/web build
```

Expected: UI source contract, message shape, typecheck, production build PASS.

- [ ] **Step 7: commit한다**

```bash
git add 'apps/web/app/(dashboard)/admin' apps/web/messages/ko/admin.json apps/web/messages/en/admin.json apps/web/lib/ui-commonization.test.ts
git commit -m "feat(admin): rollup 운영 상태 화면 추가"
```

---

### Task 8: 운영 문서·전체 정합성·성능 Gate

**Files:**
- Modify: `docs/clickhouse-exact-rollup-runbook.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: Tasks 1~7의 실제 commands, API paths, environment semantics.
- Produces: 배포자가 그대로 따를 수 있는 rollout/rollback runbook과 최종 release evidence.

- [ ] **Step 1: runbook의 환경변수·관리자 운영 순서를 갱신한다**

다음 계약을 명시한다.

```text
1. shadow worker는 ClickHouse backend에서 기본 ON
2. 0/false/off는 hard disable
3. 관리자 pause는 재시작 뒤에도 유지
4. read flag와 normalized usage_events 97일 TTL은 기본 OFF
5. raw_events 7일·legacy hourly 400일·coverage window cleanup은 자동
6. 백필 완료와 exact 검증 전에는 read/TTL을 켜지 않음
```

- [ ] **Step 2: targeted 전체 테스트를 실행한다**

Run:

```bash
pnpm -r typecheck
pnpm -r test
pnpm --filter @toard/web build
```

Expected: 모든 workspace typecheck/test와 Next production build PASS.

- [ ] **Step 3: 격리된 정합성 verifier를 실행한다**

Run:

```bash
DATABASE_URL=postgres://toard:toard@localhost:5432/toard \
CLICKHOUSE_URL=http://localhost:8123 \
pnpm exec tsx scripts/verify-clickhouse-exact-rollup.ts
```

Expected: `{ "ok": true }`, 5개 IANA timezone과 Santiago midnight gap 검증 PASS. 운영 DB를 사용하지 않는다.

- [ ] **Step 4: 실제 인증 HTTP release benchmark를 실행한다**

Run:

```bash
pnpm benchmark:dashboard-http
```

Expected: 4 vCPU/8 GiB 제한, 100만 event, 8 scenarios × 100 requests가 모두 P50 1초/P95 2초 이내이며 `RELEASE_PASS`; 전용 container/network가 정리된다.

- [ ] **Step 5: migration·Compose·worktree 최종 검사를 실행한다**

Run:

```bash
AUTH_SECRET=verification-only docker compose config >/dev/null
git diff --check origin/main...HEAD
git status --short --branch
```

Expected: Compose config와 diff check PASS, 추적되지 않은 구현 파일 없음.

- [ ] **Step 6: 문서와 최종 수정사항을 commit한다**

```bash
git add README.md docs
git commit -m "docs(rollup): 관리자 백필 운영 절차 추가"
```

- [ ] **Step 7: 독립 최종 리뷰를 요청한다**

리뷰 기준은 Critical/Important finding 0, read·TTL 기본 OFF, pause persistence, 400일 clamp, 보조 retention, API admin guard, P95 gate다. finding이 있으면 관련 task의 테스트부터 RED로 추가하고 수정 후 Task 8 전체 gate를 다시 실행한다.

---

## Completion Checklist

- [ ] 최신 `origin/main`과 충돌이 해결되고 양쪽 Insights 기능이 보존됨
- [ ] 두 worker가 기본 ON이며 hard disable과 영구 pause가 우선순위대로 동작함
- [ ] 15분 v2가 최근 400일 이전부터 백필하지 않음
- [ ] 관리자 시스템 탭에서 10초 이내 상태·진행률·ETA·오류·데이터 규모 확인 가능
- [ ] pause는 현재 batch 뒤 적용되고 재시작 후 유지되며 resume은 다음 60초 tick에 반영됨
- [ ] read flag와 normalized raw TTL은 관리자 화면에서 변경 불가하고 기본 OFF
- [ ] `raw_events` 7일, legacy hourly 400일, coverage hour 32일/day 400일 cleanup 검증됨
- [ ] 전체 typecheck/test/build/exact verifier/HTTP release benchmark 통과
- [ ] 배포 runbook과 실제 구현이 일치함
