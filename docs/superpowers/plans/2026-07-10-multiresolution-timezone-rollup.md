# 다중 해상도 시간대 Rollup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 이벤트 시각 기준 가격 확정, 90일 원본 보정, 400일 15분 기준 데이터, 실제 사용 IANA 시간대별 1시간·일별 가속 캐시로 최근 12개월 대시보드의 정합성과 P95 2초 목표를 함께 달성한다.

**Architecture:** ClickHouse `usage_events`는 논리 90일 동안 원본 정합성 기준이고 물리적으로는 7일 grace를 더한 97일 보존되며, 그 뒤에는 versioned 15분 rollup v2가 400일 동안 시간대 독립 기준 데이터가 된다. 활성 IANA 시간대의 시간·일별 rollup은 15분 기준 데이터를 다시 묶는 캐시이며, watermark·dirty job·읽기 플래그가 불완전하면 항상 더 세밀한 15분 또는 raw 소스로 fallback한다. 가격은 불변 revision schedule에서 `UsageEvent.ts` 이하의 최신 revision을 골라 서버에서 확정한다.

**Tech Stack:** TypeScript, Next.js 15 App Router, PostgreSQL 16, ClickHouse, `@clickhouse/client`, `node:test`, pnpm workspace, node-pg-migrate.

## Global Constraints

- 다중 해상도 rollup, 90일 원본 TTL, 12개월 P50/P95 SLO는 `STORAGE_BACKEND=clickhouse`에만 적용한다. PostgreSQL 백엔드는 기존 조회 경로를 유지한다.
- 두 수집 엔드포인트(`/api/v1/events`, `/api/v1/logs`) 모두 이벤트 발생 시각 기준 가격 확정과 90일 초과 이벤트의 `expired` 응답을 사용한다.
- 원본·15분·시간대별 cache의 기간은 `[from, to)`이며 UTC `DateTime64(3)`을 사용한다.
- 사용자가 보는 하루·시간 경계는 IANA 시간대 이름을 사용한다. UTC offset 숫자나 브라우저 locale 문자열을 저장하지 않는다.
- 원본 논리 cutoff 90일·물리 TTL 97일, 15분·시간·일별 cache 400일, 활성 시간대 최대 64개, worker 60초 tick당 8개 작업을 사용한다. activation prewarm은 day 최근 400 local days·hour 최근 32 local days를 16-bucket 청크로 추가한다.
- 시간대별 cache는 정답 데이터가 아니다. 읽기는 watermark 완전성·dirty 상태를 확인하고 실패 시 15분 rollup으로 fallback한다.
- `CLICKHOUSE_ENFORCE_RETENTION_TTL=1` 전에는 원본 `usage_events`의 물리 97일 TTL을 켜지 않는다. v2와 시간대 cache table의 400일 TTL은 schema 생성 시부터 둔다.
- 장기 전체 재가격 계산 UI·action은 제거한다. migration 이전 비용은 기존 수치를 보존하되 `legacy`로 표시한다.
- 가격 revision은 과거 행을 UPDATE·DELETE하지 않는다. 공급자 가격 파일에 실제 적용일이 없으면 최초 확인 시각부터 앞으로만 적용한다.
- 새 의존성을 추가하지 않는다.

---

## 파일 구조

| 경로 | 책임 |
| --- | --- |
| `migrations/1700000020_pricing_revisions.sql` | 가격 revision 원장과 PG 사용 이벤트의 가격 상태 migration |
| `migrations/1700000021_clickhouse_multiresolution.sql` | ClickHouse outbox 가격 필드와 v2 rollup 지원 |
| `migrations/1700000022_clickhouse_timezone_rollup.sql` | 시간대 registry·작업 큐·watermark 확장 |
| `packages/core/src/storage.ts` | 서버가 저장할 확정 사용 이벤트 계약 |
| `packages/pricing/src/{types,aliases,cost}.ts` | revision schedule 선택과 비용 산정 |
| `apps/web/lib/{pricing,pricing-sync,usage-finalization}.ts` | DB schedule 로드·불변 sync·90일 cutoff·서버 권위 이벤트 확정 |
| `apps/web/app/api/v1/{events,logs}/route.ts` | 공통 finalization 결과 저장과 `expired` 응답 |
| `packages/storage-{postgres,clickhouse}/src/storage.ts` | 확정 가격 상태를 저장하는 백엔드 구현 |
| `packages/storage-clickhouse/src/storage.ts` | 15분 기준 v2, 시간대별 cache compactor, source router, TTL |
| `apps/web/lib/{clickhouse-outbox,timezone-rollup}.ts` | bounded worker, 활성 시간대 등록, lifecycle cleanup |
| `apps/web/lib/period.ts` 및 대시보드 페이지 | 일반 대시보드의 최근 12개월 상한 |
| `scripts/verify-clickhouse-exact-rollup.ts` | raw 동등성 검증 |
| `scripts/benchmark-dashboard-http.ts` | 인증된 dashboard HTTP release 성능 gate |
| `scripts/benchmark-timezone-rollup.ts` | direct ClickHouse 진단용 microbenchmark |
| `docs/clickhouse-exact-rollup-runbook.md` | shadow·전환·롤백 운영 절차 |

### Task 1: 불변 가격 revision schedule과 서버 확정 이벤트 계약

**Files:**
- Create: `migrations/1700000020_pricing_revisions.sql`
- Modify: `packages/core/src/storage.ts:46-80`
- Modify: `packages/pricing/src/types.ts`
- Modify: `packages/pricing/src/aliases.ts`
- Modify: `packages/pricing/src/cost.ts`
- Modify: `packages/pricing/src/cost.test.ts`
- Modify: `apps/web/lib/pricing.ts`
- Modify: `apps/web/lib/pricing-sync.ts`
- Create: `apps/web/lib/pricing.test.ts`
- Modify: `scripts/seed.ts`
- Modify: `scripts/seed-dashboard-demo.ts`
- Test: `packages/pricing/src/cost.test.ts`
- Test: `apps/web/lib/pricing.test.ts`

**Interfaces:**
- Produces from `@toard/core`:

```ts
export type UsageCostStatus = "priced" | "unpriced" | "legacy";

export interface FinalizedUsageEvent extends UsageEvent {
  pricingRevisionId: string | null;
  costStatus: UsageCostStatus;
}
```

- Produces from `@toard/pricing`:

```ts
export interface PricingRevision {
  id: string;
  modelId: string;
  effectiveAt: Date;
  pricing: ModelPricing;
}
export type PricingSchedule = Map<string, readonly PricingRevision[]>;
export type CostResolution = {
  costUsd: number;
  pricingRevisionId: string | null;
  status: "priced" | "unpriced";
};
export function resolveCostAt(args: Omit<ResolveCostArgs, "pricing"> & {
  occurredAt: Date;
  schedule: PricingSchedule;
}): CostResolution;
```

- Consumed by later tasks: `getPricingSchedule()`, `runPricingSync()`, `FinalizedUsageEvent`.

- [ ] **Step 1: 가격 revision과 시각 선택의 실패 테스트를 작성한다.**

`packages/pricing/src/cost.test.ts`에 두 revision과 늦게 도착한 이벤트를 추가한다.

```ts
test("resolveCostAt은 사용 시각 이하의 마지막 revision을 선택한다", () => {
  const schedule: PricingSchedule = new Map([["model-a", [
    { id: "old", modelId: "model-a", effectiveAt: new Date("2026-07-01T00:00:00Z"), pricing: { inputPerM: 1, outputPerM: 1 } },
    { id: "new", modelId: "model-a", effectiveAt: new Date("2026-07-11T00:00:00Z"), pricing: { inputPerM: 2, outputPerM: 2 } },
  ]]])

  assert.deepEqual(resolveCostAt({
    model: "model-a", occurredAt: new Date("2026-07-10T23:59:59Z"),
    inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    schedule, mode: "calculate",
  }), { costUsd: 1, pricingRevisionId: "old", status: "priced" })
})

test("resolveCostAt은 일치 가격이 없으면 unpriced를 돌려준다", () => {
  assert.deepEqual(resolveCostAt({
    model: "missing", occurredAt: new Date("2026-07-10T00:00:00Z"),
    inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    schedule: new Map(), mode: "calculate",
  }), { costUsd: 0, pricingRevisionId: null, status: "unpriced" })
})
```

- [ ] **Step 2: 실패 테스트를 실행한다.**

Run: `pnpm --filter @toard/pricing test`

Expected: `resolveCostAt is not a function` 또는 export 누락으로 FAIL.

- [ ] **Step 3: revision migration과 pricing API를 구현한다.**

`migrations/1700000020_pricing_revisions.sql`은 기존 `pricing_models`를 수정하지 않고 canonical `pricing_revisions`를 만든다. 기존 비용은 revision을 추정하지 않는다.

```sql
CREATE TABLE pricing_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id TEXT NOT NULL,
  effective_at TIMESTAMPTZ NOT NULL,
  input_price_per_mtok NUMERIC NOT NULL,
  output_price_per_mtok NUMERIC NOT NULL,
  cache_read_price_per_mtok NUMERIC,
  cache_creation_price_per_mtok NUMERIC,
  input_price_above_200k_per_mtok NUMERIC,
  output_price_above_200k_per_mtok NUMERIC,
  fast_multiplier NUMERIC NOT NULL DEFAULT 1,
  source TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (model_id, effective_at, source)
);

INSERT INTO pricing_revisions (
  model_id, effective_at, input_price_per_mtok, output_price_per_mtok,
  cache_read_price_per_mtok, cache_creation_price_per_mtok,
  input_price_above_200k_per_mtok, output_price_above_200k_per_mtok,
  fast_multiplier, source
)
SELECT
  model_id, effective_date::timestamp AT TIME ZONE 'UTC',
  input_price_per_mtok, output_price_per_mtok,
  cache_read_price_per_mtok, cache_creation_price_per_mtok,
  input_price_above_200k_per_mtok, output_price_above_200k_per_mtok,
  fast_multiplier, source
FROM pricing_models;

ALTER TABLE usage_events ADD COLUMN pricing_revision_id UUID REFERENCES pricing_revisions(id);
ALTER TABLE usage_events ADD COLUMN cost_status TEXT NOT NULL DEFAULT 'legacy'
  CHECK (cost_status IN ('priced', 'unpriced', 'legacy'));
```

`resolveCostAt()`은 기존 alias 정규화 후 `effectiveAt <= occurredAt`인 revision 중 가장 늦은 행을 골라, 기존 token·cache·fast 산정 함수를 재사용한다. `resolveCost()`는 기존 호출 호환을 위해 남긴다. `getPricingSchedule()`은 revision 전체를 `effective_at ASC`로 읽어 1시간 캐시하고, `runPricingSync()`은 최신 revision과 가격이 다른 모델만 `effective_at=now()`로 INSERT한다. 기존 `ON CONFLICT DO UPDATE` 경로는 제거한다.

- [ ] **Step 4: seed와 가격 테스트를 통과시킨다.**

Run: `pnpm --filter @toard/pricing test && pnpm --filter @toard/pricing typecheck && pnpm --filter @toard/web exec node --import tsx --test lib/pricing.test.ts`

Expected: pricing package tests PASS, schedule 로더 테스트는 과거 revision·동일 가격 sync skip·가격 변경 INSERT를 검증해 PASS.

- [ ] **Step 5: 첫 번째 원자 커밋을 만든다.**

```bash
git add migrations/1700000020_pricing_revisions.sql packages/core/src/storage.ts \
  packages/pricing/src/{types,aliases,cost,cost.test}.ts \
  apps/web/lib/{pricing,pricing-sync,pricing.test}.ts scripts/seed.ts scripts/seed-dashboard-demo.ts
git commit -m "feat(pricing): 이벤트 시각 기준 가격 revision 추가"
```

### Task 2: 두 수집 경로의 90일 cutoff와 공통 비용 확정

**Files:**
- Create: `apps/web/lib/usage-finalization.ts`
- Create: `apps/web/lib/usage-finalization.test.ts`
- Modify: `apps/web/app/api/v1/events/route.ts:1-98`
- Modify: `apps/web/app/api/v1/logs/route.ts:1-107`
- Delete: `apps/web/lib/pricing-reprice.ts`
- Delete: `apps/web/lib/pricing-reprice.test.ts`
- Modify: `apps/web/app/(dashboard)/admin/pricing-actions.ts`
- Modify: `apps/web/app/(dashboard)/admin/pricing-panel.tsx`
- Modify: `apps/web/messages/{ko,en}/admin.json`
- Test: `apps/web/lib/usage-finalization.test.ts`

**Interfaces:**

```ts
export const MAX_USAGE_EVENT_AGE_MS = 90 * 24 * 60 * 60 * 1000;
export type FinalizationResult = {
  events: FinalizedUsageEvent[];
  expired: number;
};
export type FinalizationOptions = {
  mode: "calculate" | "auto";
  priceHints?: Map<string, { providedCostUsd?: number | null; isFast?: boolean }>;
};
export function finalizeUsageEvents(
  events: UsageEvent[], userId: string, schedule: PricingSchedule, options: FinalizationOptions, now?: Date,
): FinalizationResult;
```

- Consumes: `resolveCostAt()` and `FinalizedUsageEvent` from Task 1.
- Produces: storage-safe events and stable JSON response field `expired`.

- [ ] **Step 1: cutoff·late event·unpriced 상태의 실패 테스트를 작성한다.**

```ts
test("90일을 넘긴 이벤트는 expired이고 저장 대상이 아니다", () => {
  const now = new Date("2026-07-10T00:00:00Z");
  const result = finalizeUsageEvents([eventAt("2026-04-10T23:59:59Z")], "u1", schedule, { mode: "calculate" }, now);
  assert.equal(result.expired, 1);
  assert.deepEqual(result.events, []);
});

test("늦게 도착했어도 90일 이내면 ts 기준 revision으로 확정한다", () => {
  const result = finalizeUsageEvents([eventAt("2026-07-09T10:00:00Z")], "u1", schedule, { mode: "calculate" }, new Date("2026-07-10T00:00:00Z"));
  assert.equal(result.expired, 0);
  assert.equal(result.events[0]?.pricingRevisionId, "old");
});
```

- [ ] **Step 2: 실패 테스트를 실행한다.**

Run: `pnpm --filter @toard/web exec node --import tsx --test lib/usage-finalization.test.ts`

Expected: module not found로 FAIL.

- [ ] **Step 3: 공통 finalizer를 도입하고 라우트를 교체한다.**

`usage-finalization.ts`는 서버 수신 시각과 `event.ts` 차이가 90일을 초과한 이벤트를 세되 저장하지 않는다. 수용 이벤트에는 `userId`, `costUsd`, `pricingRevisionId`, `costStatus`만 서버가 채운다.

```ts
export function finalizeUsageEvents(events: UsageEvent[], userId: string, schedule: PricingSchedule, options: FinalizationOptions, now = new Date()): FinalizationResult {
  const cutoff = now.getTime() - MAX_USAGE_EVENT_AGE_MS;
  const accepted = events.filter((event) => event.ts.getTime() >= cutoff);
  return {
    expired: events.length - accepted.length,
    events: accepted.map((event) => {
      const hints = options.priceHints?.get(event.dedupKey);
      const price = resolveCostAt({ ...event, ...hints, occurredAt: event.ts, schedule, mode: options.mode });
      return { ...event, userId, costUsd: price.costUsd, pricingRevisionId: price.pricingRevisionId, costStatus: price.status };
    }),
  };
}
```

`/v1/events`는 provider gate 뒤에 `{ mode: "calculate" }` finalizer를 호출해 `{ inserted, deduped, expired }`를 반환한다. `/v1/logs`는 normalizer의 `providedCostUsd`·`isFast`를 `priceHints`에 넣고 `{ mode: "auto" }`로 같은 finalizer를 호출해 provider별 `expired`를 합산한다. HTTP 200을 유지해 shim cursor가 만료 이벤트를 재전송하지 않게 한다. 재가격 action·패널·번역·테스트는 완전히 제거한다.

- [ ] **Step 4: 웹 테스트와 타입 검사를 실행한다.**

Run: `pnpm --filter @toard/web exec node --import tsx --test lib/usage-finalization.test.ts && pnpm --filter @toard/web test && pnpm --filter @toard/web typecheck`

Expected: finalizer의 90일 경계, 과거 revision, unpriced, 두 route의 `expired` 응답 테스트가 PASS.

- [ ] **Step 5: 두 번째 원자 커밋을 만든다.**

```bash
git add apps/web/lib/usage-finalization.ts apps/web/lib/usage-finalization.test.ts \
  apps/web/app/api/v1/events/route.ts apps/web/app/api/v1/logs/route.ts \
  apps/web/app/'(dashboard)'/admin/pricing-actions.ts \
  apps/web/app/'(dashboard)'/admin/pricing-panel.tsx apps/web/messages/ko/admin.json apps/web/messages/en/admin.json
git rm apps/web/lib/pricing-reprice.ts apps/web/lib/pricing-reprice.test.ts
git commit -m "feat(ingest): 가격 확정과 90일 지연 수집 제한 적용"
```

### Task 3: ClickHouse v2 원본·15분 기준 테이블과 outbox 가격 상태 저장

**Files:**
- Create: `migrations/1700000021_clickhouse_multiresolution.sql`
- Modify: `clickhouse/init/001-schema.sql`
- Modify: `clickhouse/init/004-rollup.sql`
- Modify: `packages/storage-clickhouse/src/storage.ts:70-244,535-861`
- Modify: `packages/storage-clickhouse/src/storage.test.ts`
- Modify: `packages/storage-postgres/src/storage.ts`
- Test: `packages/storage-clickhouse/src/storage.test.ts`
- Test: `packages/storage-postgres/src/storage.test.ts`

**Interfaces:**

```ts
export interface CompactUsage15mV2Result {
  buckets: number;
  rows: number;
  watermark: string;
}
async compactUsage15mV2(limitBuckets?: number): Promise<CompactUsage15mV2Result>;
```

- Consumes: `FinalizedUsageEvent` from Task 2.
- Produces: `usage_events` price metadata, `usage_15m_rollup_v2` as 400일 canonical aggregate.

- [ ] **Step 1: 저장 필드와 v2 테이블의 실패 테스트를 작성한다.**

`packages/storage-clickhouse/src/storage.test.ts`에 mock insert assertions를 추가한다.

```ts
test("ClickHouse outbox raw insert는 pricing revision과 status를 보존한다", async () => {
  const inserts: Array<{ table: string; values: unknown[] }> = [];
  const storage = storageWithInsertedRows(inserts);
  await storage.saveUsageEvents([pricedEvent({ pricingRevisionId: "rev-1", costStatus: "priced" })]);
  await storage.flushUsageOutbox();
  assert.equal(inserts.find((x) => x.table === "usage_events")?.values[0]?.pricing_revision_id, "rev-1");
  assert.equal(inserts.find((x) => x.table === "usage_events")?.values[0]?.cost_status, "priced");
});
```

- [ ] **Step 2: 실패 테스트를 실행한다.**

Run: `pnpm --filter @toard/storage-clickhouse test`

Expected: `pricing_revision_id`가 없어서 FAIL.

- [ ] **Step 3: Postgres outbox와 ClickHouse v2 스키마를 구현한다.**

`1700000021_clickhouse_multiresolution.sql`에 다음 PG 변경을 넣는다.

```sql
ALTER TABLE clickhouse_usage_outbox ADD COLUMN pricing_revision_id UUID;
ALTER TABLE clickhouse_usage_outbox ADD COLUMN cost_status TEXT NOT NULL DEFAULT 'legacy'
  CHECK (cost_status IN ('priced', 'unpriced', 'legacy'));
```

`usage_events`에는 `pricing_revision_id String`, `cost_status LowCardinality(String)`를 추가한다. 새 `usage_15m_rollup_v2`는 `ReplacingMergeTree(version)`, `TTL bucket_15m + INTERVAL 400 DAY DELETE`, 다음 ORDER BY를 사용한다.

```sql
ORDER BY (bucket_15m, provider_key, user_id, team_id, session_id, model, host, pricing_revision_id, cost_status)
```

`enqueueUsageEvents`, outbox SELECT, `insertOutboxRows`, `OutboxRow`, Postgres `saveUsageEvents`는 가격 revision과 상태를 끝까지 전달한다. 기존 원본 `usage_events`는 `CLICKHOUSE_ENFORCE_RETENTION_TTL=1`일 때만 `ALTER TABLE usage_events MODIFY TTL toDateTime(ts) + INTERVAL 97 DAY DELETE`를 실행한다. 이 플래그가 비어 있으면 raw TTL을 추가·변경하지 않는다.

- [ ] **Step 4: 저장소 패키지 테스트와 타입 검사를 실행한다.**

Run: `pnpm --filter @toard/storage-clickhouse test && pnpm --filter @toard/storage-clickhouse typecheck && pnpm --filter @toard/storage-postgres test && pnpm --filter @toard/storage-postgres typecheck`

Expected: 가격 revision·`priced`·`unpriced`·`legacy` 이벤트가 PG와 CH outbox를 통과하고, v2 schema DDL에 TTL과 version key가 포함돼 PASS.

- [ ] **Step 5: 세 번째 원자 커밋을 만든다.**

```bash
git add migrations/1700000021_clickhouse_multiresolution.sql clickhouse/init/001-schema.sql clickhouse/init/004-rollup.sql \
  packages/storage-clickhouse/src/{storage,storage.test}.ts packages/storage-postgres/src/{storage,storage.test}.ts
git commit -m "feat(storage): 가격 상태를 포함한 15분 rollup v2 추가"
```

### Task 4: 90일 원본에서 400일 15분 기준 데이터를 만드는 bounded compactor

**Files:**
- Modify: `packages/storage-clickhouse/src/storage.ts:248-250,367-442,769-937`
- Modify: `scripts/verify-clickhouse-exact-rollup.ts`
- Modify: `apps/web/lib/clickhouse-outbox.ts`
- Modify: `apps/web/instrumentation.ts`
- Test: `packages/storage-clickhouse/src/storage.test.ts`
- Test: `scripts/verify-clickhouse-exact-rollup.ts`

**Interfaces:**

```ts
type RollupSource = { source: string; params: Params; from: Date; to: Date };
private async rollup15mV2Source(q: ScopedQuery): Promise<RollupSource | null>;
async compactUsage15mV2(limitBuckets?: number): Promise<CompactUsage15mV2Result>;
```

- Consumes: v2 schema and outbox rows from Task 3.
- Produces: dirty/watermark guarded 15분 source for later timezone cache and query routing.

- [ ] **Step 1: dirty 재생성·90일 논리 경계와 97일 물리 TTL grace의 실패 테스트를 작성한다.**

`verify-clickhouse-exact-rollup.ts`에 기준 시각을 고정하고 다음 assertions를 추가한다.

```ts
await raw.saveUsageEvents([pricedEvent({ ts: new Date("2026-04-15T10:05:00Z") })]);
await v2.compactUsage15mV2(256);
assertEqual(
  await v2.getDailyTimeseries({ from, to, bucket: "15m", timezone: "UTC" }),
  await raw.getDailyTimeseries({ from, to, bucket: "15m", timezone: "UTC" }),
  "15m v2 dirty fallback raw equivalence",
);
```

또한 90일보다 오래된 이벤트가 finalizer에서 제외된 경우 v2 dirty bucket·watermark가 변하지 않는 단위 테스트를 작성한다.

- [ ] **Step 2: 실패 테스트를 실행한다.**

Run: `pnpm exec tsx scripts/verify-clickhouse-exact-rollup.ts`

Expected: `compactUsage15mV2 is not a function`으로 FAIL.

- [ ] **Step 3: v2 compactor와 guarded worker를 구현한다.**

기존 `compactUsage15mRollup`을 `usage_15m_rollup_v2` 전용으로 복제하지 말고, table·bucket column·interval·watermark name을 받는 작은 `RollupSpec`으로 분리한다.

```ts
type RollupSpec = {
  name: "usage_15m_v2";
  table: "usage_15m_rollup_v2";
  bucketColumn: "bucket_15m";
  intervalMs: 15 * 60 * 1000;
};

const USAGE_15M_V2: RollupSpec = {
  name: "usage_15m_v2", table: "usage_15m_rollup_v2", bucketColumn: "bucket_15m", intervalMs: 15 * 60 * 1000,
};
```

aggregate SQL은 `pricing_revision_id`, `cost_status`를 SELECT·GROUP BY에 포함하고 `sumIf(cost_usd, cost_status != 'unpriced')`를 비용으로 쓴다. 수집 worker는 `CLICKHOUSE_15M_V2_COMPACTOR=1`일 때만 60초 tick에서 실행하고, 기존 `CLICKHOUSE_READ_15M_ROLLUP`과 독립된 `CLICKHOUSE_READ_15M_V2_ROLLUP=1`에서만 읽는다.

- [ ] **Step 4: 정확성 검증과 패키지 테스트를 통과시킨다.**

Run: `pnpm --filter @toard/storage-clickhouse test && pnpm exec tsx scripts/verify-clickhouse-exact-rollup.ts`

Expected: same-token retry, late event, unaligned boundary, 15분 raw-v2 동등성 모두 PASS.

- [ ] **Step 5: 네 번째 원자 커밋을 만든다.**

```bash
git add packages/storage-clickhouse/src/{storage,storage.test}.ts scripts/verify-clickhouse-exact-rollup.ts \
  apps/web/lib/clickhouse-outbox.ts apps/web/instrumentation.ts
git commit -m "feat(rollup): 400일 15분 기준 compactor 추가"
```

### Task 5: 활성 시간대 registry·bounded 작업 큐·1시간/일별 가속 cache

**Files:**
- Create: `apps/web/lib/timezone-rollup.ts`
- Create: `apps/web/lib/timezone-rollup.test.ts`
- Create: `migrations/1700000022_clickhouse_timezone_rollup.sql`
- Modify: `packages/storage-clickhouse/src/storage.ts`
- Modify: `apps/web/app/(dashboard)/settings/actions.ts`
- Modify: `apps/web/lib/viewer-time.ts`
- Modify: `apps/web/lib/clickhouse-outbox.ts`
- Modify: `clickhouse/init/004-rollup.sql`
- Test: `packages/storage-clickhouse/src/storage.test.ts`
- Test: `apps/web/lib/timezone-rollup.test.ts`

**Interfaces:**

```ts
export const MAX_ACTIVE_ROLLUP_TIMEZONES = 64;
export const TIMEZONE_ROLLUP_JOBS_PER_TICK = 8;
export async function activateTimezoneRollup(timezone: string): Promise<void>;
export async function enqueueTimezoneRollup(
  resolution: "hour" | "day", timezone: string, bucket: Date,
): Promise<void>;
export async function runTimezoneRollupWorker(): Promise<{ jobs: number; rows: number }>;
```

- Consumes: v2 15분 rollup and viewer timezone settings.
- Produces: `usage_hourly_timezone_rollup`, `usage_daily_timezone_rollup`, deduplicated PG jobs.

- [ ] **Step 1: 시간대 job 중복 제거와 DST 경계의 실패 테스트를 작성한다.**

```ts
test("같은 시간대·해상도·버킷 작업은 한 번만 enqueue한다", async () => {
  const repo = fakeTimezoneRollupRepository();
  await enqueueTimezoneRollupWith(repo, "day", "Asia/Seoul", new Date("2026-07-01T00:00:00Z"));
  await enqueueTimezoneRollupWith(repo, "day", "Asia/Seoul", new Date("2026-07-01T00:00:00Z"));
  assert.equal(repo.jobs.length, 1);
});

test("Los Angeles DST 전환일의 일별 cache는 15분 기준 합계와 같다", async () => {
  await assertTimezoneEquivalence("America/Los_Angeles", "2026-03-08");
});
```

- [ ] **Step 2: 실패 테스트를 실행한다.**

Run: `pnpm --filter @toard/web test -- timezone-rollup.test.ts`

Expected: module not found로 FAIL.

- [ ] **Step 3: registry, queue, cache table과 compactor를 구현한다.**

`1700000022_clickhouse_timezone_rollup.sql`에 다음 PG 테이블을 추가한다.

```sql
CREATE TABLE clickhouse_rollup_timezones (
  timezone TEXT PRIMARY KEY,
  activated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_requested_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE clickhouse_timezone_rollup_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  resolution TEXT NOT NULL CHECK (resolution IN ('hour', 'day')),
  timezone TEXT NOT NULL,
  bucket TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'inflight', 'done')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (resolution, timezone, bucket)
);
```

ClickHouse에는 `timezone LowCardinality(String)`, `bucket_start DateTime64(3, 'UTC')`, dimensions, `pricing_revision_id`, `cost_status`, metrics, `version`을 가진 두 `ReplacingMergeTree(version)` 테이블을 만든다. ORDER BY는 `(timezone, bucket_start, user_id, team_id, provider_key, model, host, session_id, pricing_revision_id, cost_status)`다. 두 table 모두 `TTL bucket_start + INTERVAL 400 DAY DELETE`를 사용한다.

`activateTimezoneRollup()`은 IANA 검증 후 최대 64개 registry를 ensure하고, coverage가 없는 day 최근 400 local days와 hour 최근 32 local days만 16-bucket chunks로 `ON CONFLICT DO NOTHING` prewarm한다. 반복 activation은 done/coverage를 유지하며 v2 dirty propagation만 coverage 삭제와 pending 전환을 수행한다. `saveTimezoneAction()`은 DB timezone UPDATE 성공 뒤 activation을 호출하고, viewer resolver는 saved/cookie/`ORG_TIMEZONE` 선택을 process-local non-blocking gate로 활성화한다. startup은 `ORG_TIMEZONE`과 `SELECT DISTINCT timezone FROM users`를 비대화형으로 seed한다.

worker는 `FOR UPDATE SKIP LOCKED`로 최대 8 jobs를 잡고, PG advisory lock `timezone-rollup:${resolution}:${timezone}`을 얻은 뒤 15분 v2 source를 `toStartOfInterval(bucket_15m, INTERVAL 1 HOUR, timezone)` 또는 `toStartOfDay(bucket_15m, timezone)`로 그룹화한다. 성공 후에만 job을 `done`으로 바꾸고, 실패하면 `pending`으로 되돌린다.

- [ ] **Step 4: 시간대와 storage 검증을 통과시킨다.**

Run: `pnpm --filter @toard/web test -- timezone-rollup.test.ts && pnpm --filter @toard/storage-clickhouse test && pnpm exec tsx scripts/verify-clickhouse-exact-rollup.ts`

Expected: Asia/Seoul, America/Los_Angeles DST, Asia/Kolkata, Asia/Kathmandu, Europe/London에서 15분 source와 시간·일별 cache가 동일하고, duplicate job은 한 행만 남아 PASS.

- [ ] **Step 5: 다섯 번째 원자 커밋을 만든다.**

```bash
git add migrations/1700000022_clickhouse_timezone_rollup.sql clickhouse/init/004-rollup.sql \
  apps/web/lib/{timezone-rollup,timezone-rollup.test,clickhouse-outbox,viewer-time}.ts \
  apps/web/app/'(dashboard)'/settings/actions.ts packages/storage-clickhouse/src/{storage,storage.test}.ts
git commit -m "feat(rollup): 시간대별 가속 cache worker 추가"
```

### Task 6: source router·12개월 대시보드 상한·fallback 표시

**Files:**
- Modify: `packages/storage-clickhouse/src/storage.ts:308-495,955-1137`
- Modify: `packages/storage-clickhouse/src/storage.test.ts`
- Modify: `apps/web/lib/period.ts`
- Modify: `apps/web/lib/period.test.ts`
- Modify: `apps/web/app/(dashboard)/page.tsx`
- Modify: `apps/web/app/(dashboard)/org/page.tsx`
- Modify: `apps/web/app/(dashboard)/org/team/page.tsx`
- Modify: `apps/web/app/(dashboard)/org/teams/page.tsx`
- Modify: `apps/web/components/dashboard/dashboard-filters.tsx`
- Modify: `apps/web/messages/{ko,en}/dashboard.json`
- Test: `apps/web/lib/period.test.ts`

**Interfaces:**

```ts
type TimeseriesSource = {
  source: string;
  params: Params;
  resolution: "raw" | "15m" | "timezone-hour" | "timezone-day";
};
export const DASHBOARD_MAX_RANGE_DAYS = 366;
export function parseDashboardPeriod(sp: DashboardSearchParams, timezone: string): DashboardPeriod & { limited: boolean };
```

- Consumes: active timezone registry and cache watermarks from Task 5.
- Produces: exact fallback routing and UI-visible range limit state.

- [ ] **Step 1: source selection과 기간 상한의 실패 테스트를 작성한다.**

```ts
test("활성 Seoul 시간대의 12개월 일별 요청은 timezone-day source를 사용한다", async () => {
  const { query } = await queryFor({ timezone: "Asia/Seoul", bucket: "day", from: yearAgo, to: now });
  assert.match(query, /usage_daily_timezone_rollup/);
});

test("활성화되지 않은 Kathmandu 시간대는 15분 source로 fallback한다", async () => {
  const { query } = await queryFor({ timezone: "Asia/Kathmandu", bucket: "day", from: yearAgo, to: now });
  assert.match(query, /usage_15m_rollup_v2/);
  assert.doesNotMatch(query, /usage_daily_timezone_rollup/);
});

test("일반 대시보드의 all과 366일 초과 custom은 최근 366일로 제한한다", () => {
  const p = parseDashboardPeriod({ period: "all" }, "UTC");
  assert.equal(p.limited, true);
  assert.ok(p.to.getTime() - p.from.getTime() <= DASHBOARD_MAX_RANGE_DAYS * 86_400_000);
});
```

- [ ] **Step 2: 실패 테스트를 실행한다.**

Run: `pnpm --filter @toard/storage-clickhouse test && pnpm --filter @toard/web test -- period.test.ts`

Expected: `parseDashboardPeriod is not a function`와 timezone source 미선택으로 FAIL.

- [ ] **Step 3: 모든 대시보드 집계에 공통 source router를 구현한다.**

`dailyQuery`, `getUserModelTimeseries`, `getTeamMemberTimeseries`, `overviewQuery`, `modelBreakdown`, `hostBreakdown`, leaderboard는 각자 `usage_hourly_rollup`을 직접 고르지 않고 `resolveTimeseriesSource(q, bucket, timezone)`을 호출한다. resolver는 다음 우선순위를 지킨다.

```ts
if (bucket === "day" && await cacheReady("day", timezone, q)) return timezoneDaySource(q, timezone);
if (bucket === "hour" && await cacheReady("hour", timezone, q)) return timezoneHourSource(q, timezone);
return await rollup15mV2Source(q) ?? rawSource(q);
```

`cacheReady()`는 시간대 registry, cache watermark, dirty jobs를 함께 확인한다. 15분 source를 사용하는 경우 `bucketExpr()`는 항상 요청 IANA timezone으로 그룹화한다. active cache table은 이미 그 timezone으로 물질화됐으므로 `bucket_start`을 직접 label·filter에 사용한다.

`parseDashboardPeriod()`은 일반 대시보드 페이지에서만 사용한다. `period=all` 또는 366일 초과 custom을 최근 366일로 clamp하고 `limited=true`를 반환한다. 히스토리 페이지는 기존 `parseFilters(..., "all")`을 그대로 사용한다. `DashboardFilters`는 `limited`일 때 번역된 “최근 12개월까지만 표시합니다” 안내를 렌더한다.

- [ ] **Step 4: 라우팅·기간·대시보드 테스트를 통과시킨다.**

Run: `pnpm --filter @toard/storage-clickhouse test && pnpm --filter @toard/web test && pnpm --filter @toard/web typecheck`

Expected: 다섯 IANA timezone source equivalence, inactive fallback, history `all` 불변, 일반 대시보드 366일 제한, UI 안내가 모두 PASS.

- [ ] **Step 5: 여섯 번째 원자 커밋을 만든다.**

```bash
git add packages/storage-clickhouse/src/{storage,storage.test}.ts apps/web/lib/{period,period.test}.ts \
  apps/web/app/'(dashboard)'/{page.tsx,org/page.tsx,org/team/page.tsx,org/teams/page.tsx} \
  apps/web/components/dashboard/dashboard-filters.tsx apps/web/messages/ko/dashboard.json apps/web/messages/en/dashboard.json
git commit -m "feat(dashboard): 시간대별 rollup 조회와 12개월 제한 적용"
```

### Task 7: 안정성 gate·retention cleanup·전환 runbook·성능 benchmark

**Files:**
- Create: `scripts/benchmark-dashboard-http.ts`
- Create: `scripts/benchmark-dashboard-http-lib.ts`
- Create: `scripts/benchmark-dashboard-http.test.ts`
- Create: `scripts/benchmark-dashboard-release.ts`
- Keep as diagnostic: `scripts/benchmark-timezone-rollup.ts`
- Modify: `apps/web/lib/clickhouse-outbox.ts`
- Modify: `apps/web/instrumentation.ts`
- Modify: `apps/web/app/api/ready/route.ts`
- Modify: `docker-compose.yml`
- Modify: `docs/clickhouse-exact-rollup-runbook.md`
- Modify: `README.md`
- Test: `scripts/verify-clickhouse-exact-rollup.ts`

**Interfaces:**

```ts
export async function pruneClickHouseUsageRetention(now?: Date): Promise<{
  deliveredOutboxRows: number;
  deliveredBatches: number;
  completedTimezoneJobs: number;
}>;
```

- Consumes: Tasks 4–6 compactor, job queue, source flags.
- Produces: observable bounded background lifecycle and a repeatable P50/P95 benchmark.

- [ ] **Step 1: readiness·cleanup·benchmark의 실패 검증을 작성한다.**

`verify-clickhouse-exact-rollup.ts`에 ready 상태 fixture와 cleanup query assertion을 넣고, benchmark script에는 400일·100만 event fixture가 없으면 종료 코드 1로 실패하는 argument validation을 넣는다.

```ts
assert.match(readyPayload.rollups.timezone, /healthy|fallback/);
assert.equal(await pruneClickHouseUsageRetentionAt(pool, cutoff), {
  deliveredOutboxRows: 12, deliveredBatches: 2, completedTimezoneJobs: 8,
});
```

- [ ] **Step 2: 실패 검증을 실행한다.**

Run: `pnpm benchmark:dashboard-http`

Expected: script missing으로 FAIL.

- [ ] **Step 3: worker gate, cleanup, health, flags, benchmark를 구현한다.**

`clickhouse-outbox.ts`는 flush, 15분 compactor, timezone worker를 독립 re-entrancy guard로 실행한다. timezone worker는 `CLICKHOUSE_TIMEZONE_ROLLUP_COMPACTOR=1`일 때만 실행한다. 읽기에는 `CLICKHOUSE_READ_TIMEZONE_ROLLUP=1`을 사용한다. `pruneClickHouseUsageRetention()`은 raw와 같은 97일보다 오래된 delivered outbox/batch와 7일보다 오래된 done timezone jobs만 삭제하며, pending/inflight row를 삭제하지 않는다.

`/api/ready`는 ClickHouse 연결 성공 외에 `timezoneRollup` 상태를 `healthy`, `fallback`, `disabled`로 돌려준다. watermark가 15분 기준보다 30분 이상 뒤처지거나 pending job이 10,000개를 넘으면 `fallback`으로 표시하되 HTTP ready 자체는 200으로 유지한다.

`benchmark-dashboard-release.ts`는 전용 Compose stack을 실제 기동하고 Docker inspect로 app·Postgres·ClickHouse 합계 4 vCPU/8 GiB를 확인한다. 검증 뒤 app 컨테이너 내부의 `benchmark-dashboard-http.ts`가 격리된 Postgres schema·ClickHouse database에 400일·100 사용자·5 provider·10 model의 100만 이벤트를 seed한다. raw에서 15분 v2 compactor와 timezone activation/worker를 거쳐 durable coverage를 만든 뒤, 임의 credentials로 로그인한 production Next 앱의 조직 5개 시간대·provider filter·team·individual 12개월 페이지를 각 100회 HTTP 요청한다. 매 요청 전 ClickHouse cache와 앱 응답 cache를 비우고 본문 완료까지 측정한다. 정렬된 duration 배열에서 `p50 = sorted[49]`, `p95 = sorted[94]`를 구하며 어느 시나리오든 p50이 1000ms 초과 또는 p95가 2000ms 초과면 `process.exitCode = 1`로 종료한다. host HTTP와 `benchmark-timezone-rollup.ts`는 진단용으로만 유지한다.

`docker-compose.yml`, README, runbook에는 `CLICKHOUSE_15M_V2_COMPACTOR`, `CLICKHOUSE_READ_15M_V2_ROLLUP`, `CLICKHOUSE_TIMEZONE_ROLLUP_COMPACTOR`, `CLICKHOUSE_READ_TIMEZONE_ROLLUP`, `CLICKHOUSE_ENFORCE_RETENTION_TTL` 다섯 환경변수와 다음 순서를 기록한다: schema 배포 → 15분 v2 shadow → 조직·저장 사용자 시간대 shadow → raw diff·benchmark → timezone day/hour read → 15분 v2 read → raw TTL. rollback은 해당 read flag만 비우고 app 컨테이너만 recreate한다.

- [ ] **Step 4: 전체 검증을 실행한다.**

Run:

```bash
pnpm -r typecheck
pnpm -r test
pnpm exec tsx scripts/verify-clickhouse-exact-rollup.ts
pnpm benchmark:dashboard-http
git diff --check
```

Expected: typecheck·test·exactness가 PASS하고, 참조 Docker 환경에서 benchmark의 모든 활성 시간대가 P50 ≤ 1000ms·P95 ≤ 2000ms를 출력한다.

- [ ] **Step 5: 마지막 구현 커밋을 만든다.**

```bash
git add scripts/benchmark-dashboard-http.ts scripts/benchmark-dashboard-http-lib.ts \
  scripts/benchmark-dashboard-http.test.ts scripts/benchmark-timezone-rollup.ts scripts/verify-clickhouse-exact-rollup.ts \
  apps/web/lib/clickhouse-outbox.ts apps/web/instrumentation.ts apps/web/app/api/ready/route.ts \
  docker-compose.yml docs/clickhouse-exact-rollup-runbook.md README.md
git commit -m "feat(rollup): 시간대별 rollup 운영 검증 추가"
```

## 계획 자체 점검

- 가격 revision·legacy 상태·90일 late cutoff는 Task 1–2가 구현한다.
- 90일 raw·400일 15분 기준 데이터·v2 versioning은 Task 3–4가 구현한다.
- 시간대 registry·bounded queue·DST 안전 cache·fallback은 Task 5–6이 구현한다.
- 12개월 UI 상한, P50/P95, readiness, rollback, cleanup, runbook은 Task 6–7이 구현한다.
- 모든 later-task 인터페이스는 앞선 task의 `PricingSchedule`, `FinalizedUsageEvent`, `CompactUsage15mV2Result`, timezone queue API 또는 `TimeseriesSource`를 사용한다.
- 미완성 표식 없이 고정 값·경로·명령·성공 조건을 문서에 포함했다.
