# Historical Pricing Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 늦게 유입된 최근 90일 과거 사용량의 LiteLLM Git 가격 이력을 자동으로 확인하고, 근거 revision으로 비용과 15분·1시간·1일 rollup을 안전하게 복구한다.

**Architecture:** 기존 `pricing_repair` coordinator 후보가 저장된 authoritative revision으로 해결할 수 없는 모델을 발견하면 durable historical job을 실행한다. Git commit 목록과 snapshot을 제한된 batch로 확인해 staging candidate를 만들고 전체 구간 완료 후 transaction으로 canonical revision을 승격한다. 수집과 대시보드 요청은 외부 네트워크를 호출하지 않으며 기존 저장소별 repair와 dirty rollup 경로를 재사용한다.

**Tech Stack:** TypeScript, Node test runner, Next.js 15, PostgreSQL 16, ClickHouse 24 `ReplacingMergeTree`, GitHub REST API, pnpm workspace.

## Global Constraints

- 자동 복구 범위는 `USAGE_EVENT_LOGICAL_RETENTION_DAYS = 90` 이내로 제한한다.
- 관리자 입력·버튼·필수 GitHub token 없이 동작한다.
- 수집과 대시보드 요청 경로에서 GitHub를 호출하지 않는다.
- authoritative `priced`와 `legacy` 이벤트는 변경하지 않는다.
- 기존 `litellm-bootstrap`은 신규 계산에서 제외하고 근거 이력이 확보된 이벤트만 교체한다.
- historical candidate는 전체 구간 확인 전 canonical schedule에 노출하지 않는다.
- 한 coordinator tick에서 commit-list 1회, raw snapshot 4개 이하, HTTP 요청별 timeout 10초를 지킨다.
- GitHub 403·429·`x-ratelimit-reset`·`retry-after`를 durable backoff로 처리한다.
- 원본 이벤트 수와 token·사용자·세션·모델·호스트는 바꾸지 않는다.
- ClickHouse는 mutation 대신 dirty-before-replacement 순서를 사용한다.
- 정합성 검증 전 rollup coverage를 읽지 않는다.
- 프로덕션 DB를 수동으로 수정하지 않고 additive migration과 앱 worker로 반영한다.

---

## File Structure

- `migrations/1700000029_historical_pricing_recovery.sql`: revision 유효 구간·provenance와 durable job/candidate schema.
- `scripts/historical-pricing-migration.integration.test.ts`: PostgreSQL migration, constraint, idempotency 통합 검증.
- `packages/pricing/src/aliases.ts`: 실제 매칭된 LiteLLM source key를 반환하는 resolver.
- `packages/pricing/src/types.ts`: bounded revision 타입.
- `packages/pricing/src/cost.ts`: `[effectiveAt, validUntil)` 선택 규칙.
- `apps/web/lib/pricing-history-source.ts`: GitHub commit 목록·raw snapshot client와 rate-limit 해석.
- `apps/web/lib/pricing-history-intervals.ts`: snapshot 변화에서 모델별 bounded candidate를 만드는 순수 로직.
- `apps/web/lib/pricing-history.ts`: durable repository, 단계 실행, staged promotion.
- `apps/web/lib/pricing-history-source.test.ts`: 외부 source client 계약 테스트.
- `apps/web/lib/pricing-history-intervals.test.ts`: 가격 구간 순수 로직 테스트.
- `apps/web/lib/pricing-history.test.ts`: job resume·promotion transaction 테스트.
- `apps/web/lib/pricing-sync.ts`: 추정 bootstrap 제거.
- `apps/web/lib/pricing.ts`: authoritative·bounded schedule load와 cache version.
- `apps/web/lib/pricing-repair.ts`: unresolved 진단에서 historical 단계 연결.
- `packages/core/src/storage.ts`: non-authoritative 교체 대상 계약.
- `packages/storage-postgres/src/storage.ts`: PG 진단·교체 범위 확장.
- `packages/storage-clickhouse/src/storage.ts`: CH 진단·replacement 범위 확장.
- `apps/web/lib/pricing-admin-status.ts`, `apps/web/app/(dashboard)/admin/pricing-panel.tsx`, `apps/web/messages/{ko,en}/admin.json`: 이력 복구 관측 상태.
- `scripts/verify-historical-pricing-recovery.ts`: PostgreSQL·ClickHouse·rollup end-to-end 검증.

### Task 1: Additive schema와 bounded revision 계약

**Files:**
- Create: `migrations/1700000029_historical_pricing_recovery.sql`
- Create: `scripts/historical-pricing-migration.integration.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `pricing_revisions.authoritative BOOLEAN`, `valid_until TIMESTAMPTZ`, `source_ref TEXT`, `source_model_id TEXT`.
- Produces: `pricing_history_jobs`, `pricing_history_candidates`.

- [ ] **Step 1: migration 통합 실패 테스트 작성**

`scripts/historical-pricing-migration.integration.test.ts`에서 PostgreSQL 16 임시 container를 시작하고 migration 20, 27, 28, 29를 순서대로 적용한다. 다음 assertion을 포함한다.

```ts
const revisionColumns = await client.query<{ column_name: string }>(`
  SELECT column_name FROM information_schema.columns
  WHERE table_name = 'pricing_revisions'
`);
assert.deepEqual(
  new Set(revisionColumns.rows.map((row) => row.column_name)),
  new Set([
    "id", "model_id", "effective_at", "input_price_per_mtok",
    "output_price_per_mtok", "cache_read_price_per_mtok",
    "cache_creation_price_per_mtok", "input_price_above_200k_per_mtok",
    "output_price_above_200k_per_mtok", "fast_multiplier", "source",
    "observed_at", "authoritative", "valid_until", "source_ref", "source_model_id",
  ]),
);
const bootstrap = await client.query<{ authoritative: boolean }>(`
  SELECT authoritative FROM pricing_revisions WHERE source = 'litellm-bootstrap'
`);
assert.equal(bootstrap.rows[0]?.authoritative, false);
```

active job unique index와 candidate FK도 `pg_indexes`, `pg_constraint`로 확인한다.

- [ ] **Step 2: 테스트가 migration 29 부재로 실패하는지 실행**

Run: `node --import tsx --test scripts/historical-pricing-migration.integration.test.ts`

Expected: FAIL with `ENOENT migrations/1700000029_historical_pricing_recovery.sql`.

- [ ] **Step 3: migration 최소 구현**

`migrations/1700000029_historical_pricing_recovery.sql`의 Up migration에 다음 구조를 구현한다.

```sql
ALTER TABLE pricing_revisions
  ADD COLUMN authoritative BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN valid_until TIMESTAMPTZ,
  ADD COLUMN source_ref TEXT,
  ADD COLUMN source_model_id TEXT,
  ADD CONSTRAINT pricing_revisions_valid_window_check
    CHECK (valid_until IS NULL OR valid_until > effective_at);

UPDATE pricing_revisions
SET authoritative = FALSE
WHERE source = 'litellm-bootstrap';

CREATE TABLE pricing_history_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state TEXT NOT NULL CHECK (state IN (
    'pending', 'listing', 'fetching', 'promoting',
    'completed', 'waiting_source', 'failed'
  )),
  range_from TIMESTAMPTZ NOT NULL,
  range_to TIMESTAMPTZ NOT NULL,
  models JSONB NOT NULL,
  commit_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  list_page INTEGER NOT NULL DEFAULT 0,
  next_commit_index INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ,
  rate_limit_reset_at TIMESTAMPTZ,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (range_to > range_from),
  CHECK (jsonb_typeof(models) = 'array'),
  CHECK (jsonb_typeof(commit_refs) = 'array')
);

CREATE UNIQUE INDEX pricing_history_one_active_job
  ON pricing_history_jobs ((TRUE))
  WHERE state <> 'completed';

CREATE TABLE pricing_history_candidates (
  job_id UUID NOT NULL REFERENCES pricing_history_jobs(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  source_model_id TEXT NOT NULL,
  effective_at TIMESTAMPTZ NOT NULL,
  valid_until TIMESTAMPTZ,
  input_price_per_mtok NUMERIC NOT NULL,
  output_price_per_mtok NUMERIC NOT NULL,
  cache_read_price_per_mtok NUMERIC,
  cache_creation_price_per_mtok NUMERIC,
  input_price_above_200k_per_mtok NUMERIC,
  output_price_above_200k_per_mtok NUMERIC,
  fast_multiplier NUMERIC NOT NULL DEFAULT 1,
  source_commit_sha TEXT NOT NULL,
  source_committed_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (job_id, model_id, effective_at),
  CHECK (valid_until IS NULL OR valid_until > effective_at)
);
```

Down migration은 candidate, job, constraint, 새 revision column을 역순으로 제거한다.

- [ ] **Step 4: migration test script 등록 및 통과 확인**

`package.json`의 `test:migrations`에 `scripts/historical-pricing-migration.integration.test.ts`를 추가한다.

Run: `pnpm test:migrations`

Expected: migration test 전부 PASS.

- [ ] **Step 5: Commit**

```bash
git add migrations/1700000029_historical_pricing_recovery.sql scripts/historical-pricing-migration.integration.test.ts package.json
git commit -m "feat(pricing): 과거 가격 복구 상태를 추가"
```

### Task 2: bounded pricing resolver와 source key provenance

**Files:**
- Modify: `packages/pricing/src/types.ts`
- Modify: `packages/pricing/src/aliases.ts`
- Modify: `packages/pricing/src/cost.ts`
- Modify: `packages/pricing/src/cost.test.ts`
- Modify: `packages/pricing/src/index.ts`

**Interfaces:**
- Produces: `PricingRevision.validUntil?: Date`.
- Produces: `resolvePricingEntry(model, pricing): { modelId: string; pricing: ModelPricing } | undefined`.
- Consumes: historical candidate가 제공하는 `[effectiveAt, validUntil)`.

- [ ] **Step 1: source key와 유효 종료 경계 실패 테스트 작성**

`packages/pricing/src/cost.test.ts`에 다음 케이스를 추가한다.

```ts
test("bounded historical revision은 validUntil 밖에 적용되지 않는다", () => {
  const schedule: PricingSchedule = new Map([["claude-opus", [{
    id: "history-1",
    modelId: "claude-opus",
    effectiveAt: new Date("2026-06-01T00:00:00Z"),
    validUntil: new Date("2026-06-11T00:00:00Z"),
    pricing: { inputPerM: 5, outputPerM: 25 },
  }]]]);
  assert.equal(resolveCostAt(eventAt("2026-06-10T23:59:59Z", schedule)).status, "priced");
  assert.equal(resolveCostAt(eventAt("2026-06-11T00:00:00Z", schedule)).status, "unpriced");
});

test("가격 alias resolver는 실제 source key를 반환한다", () => {
  const pricing = new Map([["claude-opus-4-8", { inputPerM: 5, outputPerM: 25 }]]);
  assert.deepEqual(resolvePricingEntry("anthropic.claude-opus-4-8", pricing), {
    modelId: "claude-opus-4-8",
    pricing: { inputPerM: 5, outputPerM: 25 },
  });
});
```

- [ ] **Step 2: pricing package test 실패 확인**

Run: `pnpm --filter @toard/pricing test`

Expected: FAIL because `validUntil` and `resolvePricingEntry` do not exist.

- [ ] **Step 3: entry resolver와 bounded 선택 구현**

`aliases.ts`의 내부 resolver가 key와 value를 함께 반환하도록 바꾸고 공개 API를 추가한다.

```ts
export type ResolvedPricingEntry = { modelId: string; pricing: ModelPricing };

export function resolvePricingEntry(
  model: string | null,
  pricing: PricingMap,
): ResolvedPricingEntry | undefined {
  const resolved = resolveAliasEntry(model, pricing);
  return resolved ? { modelId: resolved.key, pricing: resolved.value } : undefined;
}
```

`PricingRevision`에 `validUntil?: Date`를 추가하고 `resolveCostAt`의 선택 조건을 다음처럼 변경한다.

```ts
const active = revision.effectiveAt <= args.occurredAt &&
  (revision.validUntil == null || args.occurredAt < revision.validUntil);
if (active && (!selected || revision.effectiveAt >= selected.effectiveAt)) {
  selected = revision;
}
```

- [ ] **Step 4: package test와 typecheck 통과 확인**

Run: `pnpm --filter @toard/pricing test && pnpm --filter @toard/pricing typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/pricing/src
git commit -m "feat(pricing): 가격 revision 유효 구간을 지원"
```

### Task 3: GitHub 가격 이력 source client

**Files:**
- Create: `apps/web/lib/pricing-history-source.ts`
- Create: `apps/web/lib/pricing-history-source.test.ts`

**Interfaces:**
- Produces: `PricingHistoryCommitRef = { sha: string; committedAt: string }`.
- Produces: `GitHubPricingHistorySource.listBaseline(until, signal)`.
- Produces: `GitHubPricingHistorySource.listChanges(from, to, page, signal)`.
- Produces: `GitHubPricingHistorySource.fetchSnapshot(sha, signal): Promise<PricingMap>`.
- Produces: `PricingSourceRateLimitError.resetAt`.

- [ ] **Step 1: pagination·timeout·rate-limit 실패 테스트 작성**

dependency-injected `fetch` fixture로 다음을 검증한다.

```ts
test("commit 목록은 path와 기간, page를 고정한다", async () => {
  const requests: URL[] = [];
  const source = new GitHubPricingHistorySource(async (input) => {
    requests.push(new URL(String(input)));
    return jsonResponse([{ sha: "abc", commit: { committer: { date: "2026-07-07T01:25:22Z" } } }]);
  });
  await source.listChanges(
    new Date("2026-07-01T00:00:00Z"),
    new Date("2026-07-08T00:00:00Z"),
    2,
  );
  assert.equal(requests[0]?.searchParams.get("path"), "model_prices_and_context_window.json");
  assert.equal(requests[0]?.searchParams.get("per_page"), "100");
  assert.equal(requests[0]?.searchParams.get("page"), "2");
});

test("429는 retry-after를 durable reset 시각으로 변환한다", async () => {
  const source = new GitHubPricingHistorySource(async () => new Response("limited", {
    status: 429,
    headers: { "retry-after": "120" },
  }), () => new Date("2026-07-14T00:00:00Z"));
  await assert.rejects(source.listBaseline(new Date("2026-07-07T00:00:00Z")), (error) =>
    error instanceof PricingSourceRateLimitError &&
    error.resetAt.toISOString() === "2026-07-14T00:02:00.000Z"
  );
});
```

- [ ] **Step 2: web test 실패 확인**

Run: `pnpm --filter @toard/web test -- pricing-history-source.test.ts`

Expected: FAIL because module is missing.

- [ ] **Step 3: source client 최소 구현**

API base는 `https://api.github.com/repos/BerriAI/litellm/commits`, raw base는 `https://raw.githubusercontent.com/BerriAI/litellm`로 고정한다. optional `GITHUB_TOKEN`은 `Authorization: Bearer` header에만 사용하고 오류 문자열에 포함하지 않는다.

```ts
export class PricingSourceRateLimitError extends Error {
  constructor(public readonly resetAt: Date) {
    super("pricing source rate limited");
  }
}

export class GitHubPricingHistorySource {
  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
    private readonly token = process.env.GITHUB_TOKEN?.trim(),
  ) {}

  async fetchSnapshot(sha: string): Promise<PricingMap> {
    if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error("invalid pricing source sha");
    const response = await this.fetcher(
      `https://raw.githubusercontent.com/BerriAI/litellm/${sha}/model_prices_and_context_window.json`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!response.ok) throw new Error(`pricing snapshot fetch failed: ${response.status}`);
    return fromLiteLLM(await response.json() as Record<string, never>);
  }
}
```

list 응답은 invalid SHA·date를 거부하고 최대 100개만 반환한다. `x-ratelimit-remaining=0`, 403, 429는 reset header를 해석해 `PricingSourceRateLimitError`를 던진다.

- [ ] **Step 4: source client test 통과 확인**

Run: `pnpm --filter @toard/web test -- pricing-history-source.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/pricing-history-source.ts apps/web/lib/pricing-history-source.test.ts
git commit -m "feat(pricing): LiteLLM 가격 이력 source를 추가"
```

### Task 4: snapshot을 bounded candidate로 변환

**Files:**
- Create: `apps/web/lib/pricing-history-intervals.ts`
- Create: `apps/web/lib/pricing-history-intervals.test.ts`

**Interfaces:**
- Consumes: `resolvePricingEntry`, `PricingHistoryCommitRef`, `PricingMap`.
- Produces: `applyPricingSnapshot(state, snapshot): PricingHistoryIntervalState`.
- Produces: `closePricingIntervals(state, rangeTo): PricingHistoryCandidate[]`.

- [ ] **Step 1: 가격 추가·변경·삭제 실패 테스트 작성**

```ts
test("가격 추가·변경·삭제가 반열린 구간을 만든다", () => {
  let state = createPricingIntervalState({
    rangeFrom: new Date("2026-06-01T00:00:00Z"),
    models: ["anthropic.claude-opus"],
  });
  state = applyPricingSnapshot(state, snapshot("a".repeat(40), "2026-05-31T23:00:00Z", {
    "claude-opus": { inputPerM: 5, outputPerM: 25 },
  }));
  state = applyPricingSnapshot(state, snapshot("b".repeat(40), "2026-06-15T00:00:00Z", {
    "claude-opus": { inputPerM: 6, outputPerM: 30 },
  }));
  state = applyPricingSnapshot(state, snapshot("c".repeat(40), "2026-06-20T00:00:00Z", {}));
  assert.deepEqual(closePricingIntervals(state, new Date("2026-07-01T00:00:00Z"))
    .map(({ effectiveAt, validUntil, pricing }) => ({ effectiveAt, validUntil, pricing })), [
      {
        effectiveAt: new Date("2026-06-01T00:00:00Z"),
        validUntil: new Date("2026-06-15T00:00:00Z"),
        pricing: { inputPerM: 5, outputPerM: 25 },
      },
      {
        effectiveAt: new Date("2026-06-15T00:00:00Z"),
        validUntil: new Date("2026-06-20T00:00:00Z"),
        pricing: { inputPerM: 6, outputPerM: 30 },
      },
    ]);
});
```

같은 가격 snapshot 반복, commit 역순 거부, range 밖 commit 무시도 테스트한다.

- [ ] **Step 2: test 실패 확인**

Run: `pnpm --filter @toard/web test -- pricing-history-intervals.test.ts`

Expected: FAIL because interval module is missing.

- [ ] **Step 3: immutable interval state 구현**

state는 모델별 open candidate와 closed candidates를 가진다. baseline commit이 `rangeFrom`보다 과거면 첫 candidate의 `effectiveAt`은 `rangeFrom`이다. 이후 가격 변경은 commit 시각부터 시작한다. 모델이 사라지면 open candidate를 해당 commit 시각에 닫고 새 candidate를 만들지 않는다.

가격 동일성 비교는 다음 필드를 모두 사용한다.

```ts
const pricingKey = (pricing: ModelPricing) => JSON.stringify([
  pricing.inputPerM,
  pricing.outputPerM,
  pricing.cacheReadPerM ?? null,
  pricing.cacheCreatePerM ?? null,
  pricing.inputAbove200kPerM ?? null,
  pricing.outputAbove200kPerM ?? null,
  pricing.fastMultiplier ?? 1,
]);
```

- [ ] **Step 4: interval test와 typecheck 통과 확인**

Run: `pnpm --filter @toard/web test -- pricing-history-intervals.test.ts && pnpm --filter @toard/web typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/pricing-history-intervals.ts apps/web/lib/pricing-history-intervals.test.ts
git commit -m "feat(pricing): 과거 가격 유효 구간을 계산"
```

### Task 5: durable job, staging, 원자적 promotion

**Files:**
- Create: `apps/web/lib/pricing-history.ts`
- Create: `apps/web/lib/pricing-history.test.ts`
- Modify: `apps/web/lib/pricing.ts`
- Modify: `apps/web/lib/pricing.test.ts`

**Interfaces:**
- Produces: `runHistoricalPricingStep(input): Promise<HistoricalPricingStepResult>`.
- Produces: `PgPricingHistoryRepository.getStatus()`.
- Consumes: Task 3 source client와 Task 4 interval builder.

- [ ] **Step 1: partial staging 비노출과 promotion rollback 실패 테스트 작성**

repository fake와 query capture를 사용해 다음을 검증한다.

```ts
test("전체 snapshot 전에는 canonical revision과 repair generation을 변경하지 않는다", async () => {
  const fixture = historyFixture({ commits: [commitA, commitB], nextCommitIndex: 1 });
  const result = await runHistoricalPricingStepWith(fixture.dependencies, diagnostics);
  assert.equal(result.state, "fetching");
  assert.equal(fixture.canonicalInserts.length, 0);
  assert.equal(fixture.repairPendingCalls.length, 0);
});

test("promotion은 revision·cache version·repair pending을 한 transaction으로 확정한다", async () => {
  const fixture = historyFixture({ commits: [commitA], nextCommitIndex: 1, ready: true });
  const result = await runHistoricalPricingStepWith(fixture.dependencies, diagnostics);
  assert.equal(result.state, "promoted");
  assert.deepEqual(fixture.transactionEvents, [
    "begin", "insert-revisions", "update-cache-version", "repair-pending", "complete-job", "commit",
  ]);
});
```

프로세스 중단 뒤 `next_commit_index`부터 재개, 같은 job 재실행 시 중복 insert 0건, rate-limit reset 전 source 호출 0회도 테스트한다.

- [ ] **Step 2: test 실패 확인**

Run: `pnpm --filter @toard/web test -- pricing-history.test.ts`

Expected: FAIL because history worker is missing.

- [ ] **Step 3: job 단계 state machine 구현**

`runHistoricalPricingStepWith`는 한 호출에서 다음 중 하나만 수행한다.

```ts
export type HistoricalPricingStepResult =
  | { state: "listing" | "fetching"; nextAttemptAt: Date }
  | { state: "waiting_source"; nextAttemptAt: Date }
  | { state: "promoted"; insertedRevisions: number }
  | { state: "no_evidence"; nextAttemptAt: Date };
```

- active job 없음: diagnostics의 non-null 모델 최대 20개, min firstAt local-day start, max lastAt next local-day start로 pending job 생성.
- `list_page=0`: baseline 1건 저장 후 page 1로 전환.
- listing: commit page를 append·dedupe하고 100건 미만이면 commit 시각 오름차순으로 fetching 전환.
- fetching: 한 호출에서 최대 4 snapshot 처리하고 candidate/cursor를 같은 transaction으로 저장.
- 마지막 snapshot: open interval을 `range_to`에서 닫고 promoting으로 전환.
- promoting: candidate canonical insert와 cache version, repair pending, completed 상태를 한 transaction으로 저장.

`loadPricingSchedule`은 다음 필드를 읽고 authoritative 행만 사용한다.

```sql
SELECT id, model_id, effective_at, valid_until,
       input_price_per_mtok, output_price_per_mtok,
       cache_read_price_per_mtok, cache_creation_price_per_mtok,
       input_price_above_200k_per_mtok, output_price_above_200k_per_mtok,
       fast_multiplier
FROM pricing_revisions
WHERE authoritative
ORDER BY model_id, effective_at ASC, observed_at ASC, id ASC
```

- [ ] **Step 4: bootstrap 생성 제거 및 cache reload 검증**

`runPricingSyncTransaction`에서 `ensureBootstrapPricingRevisions` 호출을 제거하고 관련 단위 테스트를 historical promotion test로 대체한다. 기존 함수 export와 dead code를 삭제한다.

Run: `pnpm --filter @toard/web test -- pricing.test.ts pricing-history.test.ts`

Expected: PASS and query capture has no `litellm-bootstrap` insert.

promotion worker는 migration 실행 중인 구버전 프로세스에는 존재하지 않으므로 canonical historical revision은 신버전 app이 시작된 뒤에만 생성된다. 첫 historical promotion 이후에는 `valid_until`을 이해하지 못하는 v0.15.14 이하로 자동 rollback하지 않도록 updater release note와 readiness에 최소 reader version `0.15.15`를 기록한다. 로컬 `0.0.0(dev)`는 test·개발 실행을 위해 허용한다.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/pricing-history.ts apps/web/lib/pricing-history.test.ts apps/web/lib/pricing.ts apps/web/lib/pricing.test.ts apps/web/lib/pricing-sync.ts
git commit -m "feat(pricing): 과거 가격을 원자적으로 승격"
```

### Task 6: 기존 repair와 PostgreSQL·ClickHouse 연결

**Files:**
- Modify: `packages/core/src/storage.ts`
- Modify: `packages/storage-postgres/src/storage.ts`
- Modify: `packages/storage-postgres/src/storage.test.ts`
- Modify: `packages/storage-clickhouse/src/storage.ts`
- Modify: `packages/storage-clickhouse/src/storage.test.ts`
- Modify: `apps/web/lib/pricing-repair.ts`
- Modify: `apps/web/lib/pricing-repair.test.ts`

**Interfaces:**
- Consumes: `runHistoricalPricingStep`.
- Produces: `PricingRepairRequest.replaceRevisionIds: string[]`.
- Produces: `getUnpricedUsageModels(from, to, replaceRevisionIds?)`가 unpriced와 non-authoritative 대상을 함께 진단.

- [ ] **Step 1: storage 대상 범위 실패 테스트 작성**

PG와 CH test에 각각 다음 조건을 assertion한다.

```ts
const request: PricingRepairRequest = {
  from,
  to,
  models: ["claude-opus"],
  replaceRevisionIds: ["bootstrap-revision"],
  limit: 100,
  generation: "2026-07-14 00:00:00+00",
};
```

선택 조건은 `cost_status = 'unpriced' OR pricing_revision_id IN replaceRevisionIds`이고 update/replacement도 같은 조건이어야 한다. authoritative priced와 legacy fixture는 resolver 호출 및 변경 0건이어야 한다.

- [ ] **Step 2: storage test 실패 확인**

Run: `pnpm --filter @toard/storage-postgres test && pnpm --filter @toard/storage-clickhouse test`

Expected: FAIL because request와 SQL 조건이 기존 unpriced 전용이다.

- [ ] **Step 3: storage 계약과 구현 확장**

`PricingRepairRequest`에 필수 `replaceRevisionIds: string[]`를 추가한다. 빈 배열에서도 타입 안전하게 동작하도록 PG는 UUID array, CH는 String array parameter를 사용한다.

PG update guard:

```sql
WHERE dedup_key = $1
  AND (
    cost_status = 'unpriced'
    OR pricing_revision_id = ANY($4::uuid[])
  )
```

CH replacement는 선택된 canonical `FINAL` 행의 dedup key를 유지하고 새 `inserted_at`과 authoritative revision ID만 기록한다. 기존 dirty-before-insert와 generation insert token을 유지한다.

- [ ] **Step 4: pricing repair history 단계 실패 테스트 작성**

```ts
test("저장 revision으로 처리할 수 없는 과거 모델은 history step을 진행한다", async () => {
  const historyCalls: PricingUnresolvedModel[][] = [];
  const outcome = await runPricingRepairTaskWith({
    repository,
    storage,
    getSchedule: async () => new Map(),
    now: () => new Date("2026-07-14T00:00:00Z"),
    runHistoricalPricingStep: async (diagnostics) => {
      historyCalls.push(diagnostics);
      return { state: "fetching", nextAttemptAt: new Date("2026-07-14T00:01:00Z") };
    },
    getNonAuthoritativeRevisionIds: async () => [],
  });
  assert.equal(outcome, "success");
  assert.equal(historyCalls.length, 1);
  assert.equal(repository.status.state, "pending");
  assert.equal(repository.status.nextAttemptAt?.toISOString(), "2026-07-14T00:01:00.000Z");
});
```

- [ ] **Step 5: repair state machine 연결**

repair 순서는 다음으로 고정한다.

```text
Codex duplicate reconciliation
-> authoritative schedule로 처리 가능한 batch
-> 남은 unresolved 진단
-> 종료된 과거 날짜면 historical step 1회
-> promoted면 즉시 pending
-> fetching/listing이면 nextAttemptAt을 저장한 pending
-> source에 근거가 없으면 waiting_for_catalog
```

non-authoritative revision ID는 PostgreSQL에서 한 번 조회해 storage 진단과 repair request에 전달한다. history network 오류는 sanitized error와 backoff만 저장하며 rollup 작업을 실패 상태로 고정하지 않는다.

- [ ] **Step 6: storage와 repair test 통과 확인**

Run: `pnpm --filter @toard/core typecheck && pnpm --filter @toard/storage-postgres test && pnpm --filter @toard/storage-clickhouse test && pnpm --filter @toard/web test -- pricing-repair.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/storage.ts packages/storage-postgres/src packages/storage-clickhouse/src apps/web/lib/pricing-repair.ts apps/web/lib/pricing-repair.test.ts
git commit -m "feat(pricing): 과거 가격 복구를 저장소와 연결"
```

### Task 7: 관리자 관측 상태와 정확한 문구

**Files:**
- Modify: `apps/web/lib/pricing-admin-status.ts`
- Modify: `apps/web/lib/pricing-admin-api.test.ts`
- Modify: `apps/web/app/(dashboard)/admin/pricing-panel.tsx`
- Modify: `apps/web/messages/ko/admin.json`
- Modify: `apps/web/messages/en/admin.json`

**Interfaces:**
- Consumes: `PgPricingHistoryRepository.getStatus()`.
- Produces: `PricingAdminStatus.history`.

- [ ] **Step 1: API 상태 실패 테스트 작성**

```ts
assert.deepEqual(status.history, {
  state: "fetching",
  rangeFrom: "2026-07-07T00:00:00.000Z",
  rangeTo: "2026-07-08T00:00:00.000Z",
  models: 1,
  processedSnapshots: 2,
  totalSnapshots: 5,
  nextAttemptAt: null,
  lastError: null,
});
```

UI 문자열 test는 한국어 `해당 사용 날짜의 가격 이력이 확인되지 않은 모델`, 영어 `Models without confirmed pricing history for the usage date`를 검사한다.

- [ ] **Step 2: web test 실패 확인**

Run: `pnpm --filter @toard/web test -- pricing-admin-api.test.ts pricing.test.ts`

Expected: FAIL because `history` and new translations are missing.

- [ ] **Step 3: 읽기 전용 history card 구현**

`PricingSyncPanel`의 기존 자동 복구 card 안에 history state가 idle/completed가 아닐 때만 다음 항목을 표시한다.

```tsx
<div className="mt-3 rounded-md border p-2 text-xs">
  <div className="flex items-center justify-between gap-2">
    <span>{t("system.historyTitle")}</span>
    <Badge variant={status.history.state === "failed" ? "destructive" : "outline"}>
      {t(`system.historyStates.${status.history.state}`)}
    </Badge>
  </div>
  <p className="mt-1 text-muted-foreground">
    {t("system.historyProgress", {
      processed: status.history.processedSnapshots,
      total: status.history.totalSnapshots,
    })}
  </p>
</div>
```

관리자 조작 버튼은 추가하지 않는다. error는 source URL·token·응답 본문 없이 sanitize된 한 줄만 API에 제공한다.

- [ ] **Step 4: UI/API test와 typecheck 통과 확인**

Run: `pnpm --filter @toard/web test -- pricing-admin-api.test.ts pricing.test.ts && pnpm --filter @toard/web typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/pricing-admin-status.ts apps/web/lib/pricing-admin-api.test.ts apps/web/app/'(dashboard)'/admin/pricing-panel.tsx apps/web/messages/ko/admin.json apps/web/messages/en/admin.json
git commit -m "feat(admin): 과거 가격 복구 상태를 표시"
```

### Task 8: 6월 가격 변경 end-to-end와 전체 검증

**Files:**
- Create: `scripts/verify-historical-pricing-recovery.ts`
- Modify: `package.json`
- Modify: `README.md`

**Interfaces:**
- Consumes: migration 29, history source fixture, pricing repair, PG/CH storage, rollup coordinator.
- Produces: 재현 가능한 전체 복구 검증 command.

- [ ] **Step 1: end-to-end 검증 fixture 작성**

fixture는 6월 1~30일 사이 동일 모델 가격이 6월 15일에 `input 5/output 25`에서 `input 6/output 30`으로 바뀌는 두 snapshot을 제공한다. 변경 전후 unpriced event를 넣고 다음 값을 capture한다.

```ts
const invariantBefore = {
  events: 4,
  inputTokens: 400_000,
  outputTokens: 40_000,
  cacheReadTokens: 2_000_000,
  cacheCreationTokens: 200_000,
};
```

history promotion과 repair, rollup을 완료한 뒤 invariant가 같고 revision ID가 변경 전후 두 개이며 raw/15m/hour/day cost 합계가 같은지 검사한다. source 429 후 재개와 promotion 직전 프로세스 재시작도 같은 script에서 별도 scenario로 검증한다.

- [ ] **Step 2: verifier가 구현 미완성 지점을 실패로 잡는지 실행**

Run: `node --import tsx scripts/verify-historical-pricing-recovery.ts`

Expected: FAIL until all adapters expose the completed workflow.

- [ ] **Step 3: verifier script와 README 운영 설명 완성**

`package.json`에 다음 script를 추가한다.

```json
"verify:historical-pricing": "tsx scripts/verify-historical-pricing-recovery.ts"
```

README 가격 자동화 설명은 다음 내용을 포함한다.

```text
최근 90일 안의 과거 로그가 늦게 들어오고 당시 가격 revision이 없으면,
toard가 LiteLLM 공개 Git 이력을 백그라운드에서 확인합니다. 확인된 가격만
비용에 적용하고 15분·1시간·1일 rollup을 자동 재집계합니다. GitHub 장애나
요청 제한은 수집과 조회를 막지 않으며 자동으로 이어서 처리합니다.
```

- [ ] **Step 4: focused verification 실행**

Run: `pnpm verify:historical-pricing`

Expected: PASS with scenarios `postgres`, `clickhouse`, `rate-limit-resume`, `promotion-restart`.

- [ ] **Step 5: 전체 검증 실행**

Run: `pnpm typecheck`

Expected: PASS.

Run: `pnpm test`

Expected: PASS including migration 29.

Run: `pnpm --filter @toard/web build`

Expected: PASS.

Run: `git diff --check`

Expected: no output.

- [ ] **Step 6: 운영 읽기 전용 검증 계획 확인**

배포 전에는 production DB를 변경하지 않는다. 배포 후 관리자 API와 read-only query로 다음만 확인한다.

```text
history job: completed
claude-opus-4-8 7월 7일 unpriced: 0
event/token fingerprint: 배포 전과 동일
cost 합계: authoritative revision 계산값과 동일
15분 dirty: 0으로 수렴
시간대별 pending: 0으로 수렴
rollup validation: success
```

- [ ] **Step 7: Commit**

```bash
git add scripts/verify-historical-pricing-recovery.ts package.json README.md
git commit -m "test(pricing): 과거 가격 자동 복구를 통합 검증"
```

### Task 9: 최종 회귀 검토

**Files:**
- Review: all files changed by Tasks 1-8.

**Interfaces:**
- Consumes: completed implementation and all verification output.
- Produces: release-ready branch without push or release side effects.

- [ ] **Step 1: spec coverage 대조**

`docs/superpowers/specs/2026-07-14-historical-pricing-recovery-design.md`의 목적, 시간 규칙, staging, promotion, 부하, 실패 복구, UI, 검증 항목을 각각 구현 commit과 test에 매핑한다. 매핑되지 않은 항목이 있으면 해당 task로 돌아가 테스트부터 추가한다.

- [ ] **Step 2: secret·외부 호출 경계 검사**

Run: `rg -n "GITHUB_TOKEN|api.github.com|raw.githubusercontent.com" apps packages scripts README.md`

Expected: token은 source client의 request header 구성에만 존재하고 로그·상태 API·UI에는 없다. 외부 URL은 history source와 문서·검증 fixture에만 존재한다.

- [ ] **Step 3: 변경 범위 검사**

Run: `git status --short && git log --oneline origin/main..HEAD`

Expected: 계획된 파일만 변경됐고 Task별 conventional commit이 존재한다.

- [ ] **Step 4: 최종 전체 검증 재실행**

Run: `pnpm typecheck && pnpm test && pnpm --filter @toard/web build && git diff --check`

Expected: all PASS and no diff-check output.

- [ ] **Step 5: handoff 상태 기록**

push·PR·merge·release는 이 계획의 구현 범위에 포함하지 않는다. 사용자가 명시적으로 요청할 때만 현재 branch를 publish한다.
