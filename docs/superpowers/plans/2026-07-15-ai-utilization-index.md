# AI 활용 지수 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 본인 과거 기준선과 비교하는 개인 AI 활용 지수와 5명 최소 표본을 강제하는 익명 조직 집계를 `/insights`와 `/org`에 제공한다.

**Architecture:** `@toard/core`가 기간·capability·산식을 순수 함수로 소유하고, PostgreSQL·ClickHouse는 동일한 일별 사용량 계약을 구현한다. 웹 서비스가 사용량 일별 행과 PostgreSQL 도구 일별 행을 병합한 뒤 개인 결과 또는 표본 억제가 적용된 조직 집계만 UI에 전달한다.

**Tech Stack:** TypeScript, Node test runner, Next.js 15 Server Components, next-intl, PostgreSQL, ClickHouse, pnpm workspace

## Global Constraints

- 개인 지수·세부 축·원시 비율은 해당 사용자 본인만 볼 수 있다.
- 조직에는 개인 행 없이 익명 통계만 제공하고 활성 사용자 5명 미만은 서버에서 `suppressed` 처리한다.
- 프롬프트·응답·코드·파일 경로·도구 인자와 결과를 조회하지 않는다.
- 콘텐츠 수집 on/off 상태는 점수와 신뢰도에 영향을 주지 않는다.
- `50 = 본인의 직전 28일 평소 수준`; 현재 기간은 직전 완료 7일이다.
- 데이터 부족과 미지원 신호는 0점이 아니라 이유 코드가 있는 계산 불가 상태다.
- 사용량, 도구 종류, 활성 일수 자체를 늘려도 점수가 오르지 않는다.
- 방법론 버전은 `utilization-v1`이다.
- 새 런타임 의존성을 추가하지 않는다.
- 모든 사용자 문구는 한국어·영어 next-intl 카탈로그에 함께 추가한다.

---

### Task 1: 코어 기간·capability·산식

**Files:**
- Create: `packages/core/src/utilization.ts`
- Create: `packages/core/src/utilization.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `addLocalCalendarDays`, `firstInstantOfLocalDate`, `localDateKey` from `packages/core/src/timezone.ts`
- Produces: `buildUtilizationPeriods`, `calculatePersonalUtilization`, `aggregateOrganizationUtilization`, `UtilizationDailyFeature`, `PersonalUtilizationResult`, `OrganizationUtilizationResult`, `UtilizationUsageDay`, `UTILIZATION_METHODOLOGY_VERSION`

- [ ] **Step 1: 기간과 robust 통계 실패 테스트 작성**

```ts
test("완료된 7일과 직전 28일을 조직 타임존으로 만든다", () => {
  const periods = buildUtilizationPeriods(new Date("2026-07-15T05:00:00Z"), "Asia/Seoul");
  assert.equal(periods.current.from.toISOString(), "2026-07-07T15:00:00.000Z");
  assert.equal(periods.current.to.toISOString(), "2026-07-14T15:00:00.000Z");
  assert.equal(periods.baseline.from.toISOString(), "2026-06-09T15:00:00.000Z");
});

test("기준선 중앙값은 50점이고 복구 부담 방향은 반대다", () => {
  assert.equal(normalizeUtilizationDimension(0.8, [0.8, 0.8, 0.8], 1), 50);
  assert.ok(normalizeUtilizationDimension(0.1, [0.2, 0.2, 0.2], -1) > 50);
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @toard/core exec node --import tsx --test src/utilization.test.ts`

Expected: FAIL with `Cannot find module './utilization'`.

- [ ] **Step 3: 기간·median·MAD·정규화 최소 구현**

```ts
export const UTILIZATION_METHODOLOGY_VERSION = "utilization-v1" as const;

export function buildUtilizationPeriods(now: Date, timezone: string): UtilizationPeriods {
  const today = localDateKey(now, timezone);
  const currentTo = firstInstantOfLocalDate(today, timezone);
  const currentFrom = firstInstantOfLocalDate(addLocalCalendarDays(today, -7), timezone);
  const baselineFrom = firstInstantOfLocalDate(addLocalCalendarDays(today, -35), timezone);
  return { current: { from: currentFrom, to: currentTo }, baseline: { from: baselineFrom, to: currentFrom }, timezone };
}

export function normalizeUtilizationDimension(current: number, baseline: number[], direction: 1 | -1): number {
  const center = median(baseline);
  const mad = median(baseline.map((value) => Math.abs(value - center)));
  const scale = Math.max(1.4826 * mad, 0.05);
  return Math.max(0, Math.min(100, Math.round(50 + 15 * direction * ((current - center) / scale))));
}
```

- [ ] **Step 4: 개인 산식 실패 테스트 작성**

현재 3일·5세션, 기준 7일, 10회 도구 호출, 70% 결과 확인 범위 fixture를 만들고 다음을 검증한다.

```ts
assert.equal(result.methodologyVersion, "utilization-v1");
assert.equal(result.dimensions.length, 3);
assert.equal(result.dimensions.filter((row) => row.score != null).length, 3);
assert.equal(result.score, Math.round(validScores.reduce((a, b) => a + b, 0) / 3));
assert.equal(result.confidence, "medium");
```

별도 fixture로 세션 4개, unknown coverage 69%, 지원되지 않는 cache 이벤트, 유효 축 1개를 검증한다. 기대 reason은 각각 `insufficient_current_sessions`, `low_tool_outcome_coverage`, `unsupported_cache_signal`, `insufficient_valid_dimensions`다.

- [ ] **Step 5: 개인 산식 구현**

`calculatePersonalUtilization`은 다음 순서로 구현한다.

```ts
const currentRows = rows.filter((row) => inPeriod(row.day, periods.current, periods.timezone));
const baselineRows = rows.filter((row) => inPeriod(row.day, periods.baseline, periods.timezone));
const currentActiveDays = new Set(currentRows.filter((row) => row.sessions > 0).map((row) => row.day)).size;
const currentSessions = currentRows.reduce((sum, row) => sum + row.sessions, 0);
```

- 공통 조건을 먼저 평가한다.
- 세 축의 일별 비율 배열과 eligibility를 각각 계산한다.
- current는 일별 비율 중앙값, baseline은 일별 비율 배열로 정규화한다.
- 유효 축이 2개 이상일 때 동일 가중치 평균을 계산한다.
- 중립 관측값은 점수 계산 이후 별도로 채운다.
- `cacheUnsupportedEvents`는 신뢰도와 reason에만 사용하고 0점으로 넣지 않는다.

- [ ] **Step 6: 조직 집계 테스트와 구현**

```ts
assert.deepEqual(aggregateOrganizationUtilization(fourValidResults, 4), {
  state: "suppressed",
  methodologyVersion: "utilization-v1",
  reason: "suppressed_small_cohort",
});

const available = aggregateOrganizationUtilization(fiveValidResults, 5);
assert.equal(available.state, "available");
assert.equal(available.median, 50);
assert.equal("users" in available, false);
assert.equal(JSON.stringify(available).includes("userId"), false);
```

활성 사용자가 5명 이상이어도 보통 이상 결과가 5개 미만이면 `insufficient_data`를 반환한다. available 결과는 median, p25, p75, 세부 축 중앙값, 개인 기준선 대비 above/usual/below 비율만 포함한다.

- [ ] **Step 7: 코어 테스트와 export 확인**

Run: `pnpm --filter @toard/core test && pnpm --filter @toard/core typecheck`

Expected: PASS.

- [ ] **Step 8: 커밋**

```bash
git add packages/core/src/utilization.ts packages/core/src/utilization.test.ts packages/core/src/index.ts
git commit -m "feat(core): AI 활용 지수 산식을 추가"
```

### Task 2: StorageBackend 계약과 PostgreSQL 일별 사용량

**Files:**
- Modify: `packages/core/src/storage.ts`
- Modify: `packages/storage-postgres/src/storage.ts`
- Modify: `packages/storage-postgres/src/storage.test.ts`

**Interfaces:**
- Consumes: `UtilizationUsageDay`, `UtilizationUsageQuery`, `CACHE_SIGNAL_PROVIDER_KEYS` from Task 1
- Produces: `StorageBackend.getUserUtilizationUsage`, `StorageBackend.getOrganizationUtilizationUsage`

- [ ] **Step 1: PostgreSQL query 실패 테스트 작성**

Recording pool fixture가 다음 SQL 속성을 검증하게 한다.

```ts
assert.match(call.sql, /AT TIME ZONE/);
assert.match(call.sql, /COUNT\(DISTINCT session_id\)/);
assert.match(call.sql, /FILTER \(WHERE provider_key = ANY/);
assert.deepEqual(result[0], {
  userId: "user-1",
  day: "2026-07-10",
  sessions: 2,
  inputTokens: 100,
  cacheReadTokens: 80,
  cacheCreationTokens: 20,
  cacheSignalEvents: 3,
  cacheUnsupportedEvents: 1,
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @toard/storage-postgres exec node --import tsx --test --test-name-pattern="활용 지수" src/storage.test.ts`

Expected: FAIL because the storage methods do not exist.

- [ ] **Step 3: 계약과 PostgreSQL helper 구현**

`StorageBackend`에 다음을 추가한다.

```ts
getUserUtilizationUsage(userId: string, q: UtilizationUsageQuery): Promise<UtilizationUsageDay[]>;
getOrganizationUtilizationUsage(q: UtilizationUsageQuery): Promise<UtilizationUsageDay[]>;
```

PostgreSQL은 공통 private helper를 사용한다.

```sql
SELECT user_id,
       to_char((ts AT TIME ZONE $timezone)::date, 'YYYY-MM-DD') AS day,
       COUNT(DISTINCT session_id) AS sessions,
       COALESCE(SUM(input_tokens) FILTER (WHERE provider_key = ANY($providers)), 0) AS input,
       COALESCE(SUM(cache_read_tokens) FILTER (WHERE provider_key = ANY($providers)), 0) AS cache_read,
       COALESCE(SUM(cache_creation_tokens) FILTER (WHERE provider_key = ANY($providers)), 0) AS cache_creation,
       COUNT(*) FILTER (WHERE provider_key = ANY($providers)) AS cache_signal_events,
       COUNT(*) FILTER (WHERE NOT (provider_key = ANY($providers))) AS cache_unsupported_events
FROM usage_events
WHERE ts >= $from AND ts < $to
GROUP BY user_id, day
ORDER BY day, user_id
```

개인 메서드는 `user_id` 조건을 추가한다. 조직 메서드는 모든 사용자를 반환한다. null user는 저장 불변식상 제외하고 mapper에서도 빈 user ID를 반환하지 않는다.

- [ ] **Step 4: 테스트·타입 검사**

Run: `pnpm --filter @toard/storage-postgres test && pnpm --filter @toard/storage-postgres typecheck`

Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add packages/core/src/storage.ts packages/storage-postgres/src/storage.ts packages/storage-postgres/src/storage.test.ts
git commit -m "feat(storage): 활용 지수 일별 사용량을 조회"
```

### Task 3: ClickHouse 일별 사용량 동등 계약

**Files:**
- Modify: `packages/storage-clickhouse/src/storage.ts`
- Modify: `packages/storage-clickhouse/src/storage.test.ts`

**Interfaces:**
- Consumes: Task 2의 `StorageBackend` 메서드와 Task 1의 cache capability provider 목록
- Produces: ClickHouse raw/rollup 공통 활용 지수 사용량 행

- [ ] **Step 1: ClickHouse query 실패 테스트 작성**

```ts
assert.match(query, /resolveTimeseriesSource|usage_15m/);
assert.match(query, /uniqExactIf\(session_id/);
assert.match(query, /sumIf\(input_tokens/);
assert.deepEqual(rows[0], postgresExpectedRow);
```

raw source fixture와 15분 hybrid source fixture에서 같은 `UtilizationUsageDay`를 기대한다.

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @toard/storage-clickhouse exec node --import tsx --test --test-name-pattern="활용 지수" src/storage.test.ts`

Expected: FAIL because ClickHouse does not implement the new interface methods.

- [ ] **Step 3: ClickHouse helper 구현**

`resolveTimeseriesSource(q, "day", q.timezone)`를 재사용하고 source의 `event_count`를 보존한다.

```sql
SELECT user_id,
       toDate(ts, {timezone:String}) AS day,
       uniqExactIf(session_id, session_id != '') AS sessions,
       sumIf(input_tokens, provider_key IN {cache_providers:Array(String)}) AS input,
       sumIf(cache_read_tokens, provider_key IN {cache_providers:Array(String)}) AS cache_read,
       sumIf(cache_creation_tokens, provider_key IN {cache_providers:Array(String)}) AS cache_creation,
       sumIf(event_count, provider_key IN {cache_providers:Array(String)}) AS cache_signal_events,
       sumIf(event_count, provider_key NOT IN {cache_providers:Array(String)}) AS cache_unsupported_events
FROM source
GROUP BY user_id, day
ORDER BY day, user_id
```

개인 메서드는 source resolution 전에 `userId`를 scoped query에 넣는다. 조직 메서드는 전체 범위를 사용한다.

- [ ] **Step 4: 테스트·타입 검사**

Run: `pnpm --filter @toard/storage-clickhouse test && pnpm --filter @toard/storage-clickhouse typecheck`

Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add packages/storage-clickhouse/src/storage.ts packages/storage-clickhouse/src/storage.test.ts
git commit -m "feat(clickhouse): 활용 지수 일별 집계를 지원"
```

### Task 4: 도구 일별 feature와 반복 실패

**Files:**
- Modify: `apps/web/lib/tool-metadata.ts`
- Modify: `apps/web/lib/tool-metadata.test.ts`

**Interfaces:**
- Consumes: `PeriodQuery`, 조직 타임존, optional user ID
- Produces: `getUtilizationToolDaysWithDb`, `getUserUtilizationToolDays`, `getOrganizationUtilizationToolDays`, `UtilizationToolDay`

- [ ] **Step 1: SQL·mapper 실패 테스트 작성**

Recording DB에 success 7, failure 3, unknown 2, repeated failure 1 fixture를 반환하고 다음을 검증한다.

```ts
assert.match(db.calls[0]!.sql, /LAG\(outcome\)/);
assert.match(db.calls[0]!.sql, /INTERVAL '30 minutes'/);
assert.match(db.calls[0]!.sql, /PARTITION BY user_id, session_id, activity_kind, item_key/);
assert.deepEqual(result[0], {
  userId: "user-1",
  day: "2026-07-10",
  successes: 7,
  failures: 3,
  unknown: 2,
  repeatedFailures: 1,
  sessionToolKnownCalls: 10,
  toolActiveSessions: 2,
  distinctTools: 3,
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @toard/web exec node --import tsx --test --test-name-pattern="활용 지수 도구" lib/tool-metadata.test.ts`

Expected: FAIL because the functions do not exist.

- [ ] **Step 3: window query와 mapper 구현**

```sql
WITH ordered AS (
  SELECT user_id, session_id, activity_kind, item_key, outcome, ts, dedup_key,
         LAG(outcome) OVER (
           PARTITION BY user_id, session_id, activity_kind, item_key
           ORDER BY ts, dedup_key
         ) AS previous_outcome,
         LAG(ts) OVER (
           PARTITION BY user_id, session_id, activity_kind, item_key
           ORDER BY ts, dedup_key
         ) AS previous_ts
  FROM tool_activity_events
  WHERE ts >= $1 AND ts < $2
), tagged AS (
  SELECT *, to_char((ts AT TIME ZONE $timezone)::date, 'YYYY-MM-DD') AS day
  FROM ordered
)
SELECT user_id, day,
       COUNT(*) FILTER (WHERE outcome = 'success') AS successes,
       COUNT(*) FILTER (WHERE outcome = 'failure') AS failures,
       COUNT(*) FILTER (WHERE outcome = 'unknown') AS unknown,
       COUNT(*) FILTER (
         WHERE outcome = 'failure' AND previous_outcome = 'failure'
           AND ts - previous_ts <= INTERVAL '30 minutes'
       ) AS repeated_failures,
       COUNT(*) FILTER (WHERE outcome <> 'unknown' AND session_id IS NOT NULL) AS session_tool_known_calls,
       COUNT(DISTINCT session_id) FILTER (WHERE session_id IS NOT NULL) AS tool_active_sessions,
       COUNT(DISTINCT (activity_kind, item_key)) AS distinct_tools
FROM tagged GROUP BY user_id, day ORDER BY day, user_id
```

optional user 조건은 `ordered` CTE 내부에 추가한다. provider 필터는 활용 지수 v1 고정 범위에는 사용하지 않는다.

- [ ] **Step 4: 테스트·타입 검사**

Run: `pnpm --filter @toard/web test && pnpm --filter @toard/web typecheck`

Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add apps/web/lib/tool-metadata.ts apps/web/lib/tool-metadata.test.ts
git commit -m "feat(insights): 도구 안정성 일별 신호를 계산"
```

### Task 5: 개인·조직 조합 서비스와 캐시

**Files:**
- Create: `apps/web/lib/ai-utilization.ts`
- Create: `apps/web/lib/ai-utilization.test.ts`

**Interfaces:**
- Consumes: Task 1 core 산식, Task 2·3 storage methods, Task 4 tool day query, `getOrgTimezone`, `getStorage`
- Produces: `getCachedPersonalUtilization(userId)`, `getCachedOrganizationUtilization()`, 테스트용 `mergeUtilizationDays`, `utilizationCacheArgs`

- [ ] **Step 1: 병합·개인 범위 실패 테스트 작성**

```ts
const merged = mergeUtilizationDays(usageRows, toolRows);
assert.deepEqual(merged[0], {
  userId: "user-1",
  day: "2026-07-10",
  sessions: 2,
  inputTokens: 100,
  cacheReadTokens: 80,
  cacheCreationTokens: 20,
  cacheSignalEvents: 3,
  cacheUnsupportedEvents: 0,
  toolSuccesses: 7,
  toolFailures: 3,
  toolUnknown: 2,
  repeatedToolFailures: 1,
  sessionToolKnownCalls: 10,
  toolActiveSessions: 2,
  distinctTools: 3,
});
```

사용량만 있는 날과 도구만 있는 날도 0 기본값으로 보존한다. key는 `${userId}\0${day}`다.

- [ ] **Step 2: 조직 개인정보 실패 테스트 작성**

fake storage와 fake tool DB를 주입하는 내부 함수를 두고 4명/5명 경계를 검증한다.

```ts
assert.equal(fourUsers.state, "suppressed");
assert.equal(fiveUsers.state, "available");
for (const forbidden of ["userId", "email", "name", "individualScores"]) {
  assert.equal(JSON.stringify(fiveUsers).includes(forbidden), false);
}
```

- [ ] **Step 3: 서비스 구현**

```ts
export async function calculatePersonalUtilizationForUser(
  userId: string,
  now = new Date(),
): Promise<PersonalUtilizationResult> {
  const timezone = getOrgTimezone();
  const periods = buildUtilizationPeriods(now, timezone);
  const range = { from: periods.baseline.from, to: periods.current.to, timezone };
  const [usage, tools] = await Promise.all([
    getStorage().getUserUtilizationUsage(userId, range),
    getUserUtilizationToolDays(userId, range),
  ]);
  return calculatePersonalUtilization(mergeUtilizationDays(usage, tools), periods);
}
```

조직 함수는 전체 일별 행을 사용자별로 group하고 현재 기간에 세션이 있는 사용자를 active로 센다. core 개인 산식을 사용자별로 호출한 뒤 core 조직 집계에 넘기고 개인 배열을 버린다.

- [ ] **Step 4: 캐시 키와 namespace 구현**

개인 cache args는 user ID, 기간, timezone, 방법론 버전을 포함한다. 조직 cache에는 user ID를 넣지 않고 별도 namespace `organization-utilization-v1`을 사용한다. TTL은 600초다.

- [ ] **Step 5: 테스트·타입 검사**

Run: `pnpm --filter @toard/web exec node --import tsx --test lib/ai-utilization.test.ts && pnpm --filter @toard/web typecheck`

Expected: PASS.

- [ ] **Step 6: 커밋**

```bash
git add apps/web/lib/ai-utilization.ts apps/web/lib/ai-utilization.test.ts
git commit -m "feat(insights): 활용 지수 조회 서비스를 추가"
```

### Task 6: 개인 인사이트 UI

**Files:**
- Create: `apps/web/components/dashboard/utilization-index-card.tsx`
- Modify: `apps/web/app/(dashboard)/insights/page.tsx`
- Modify: `apps/web/messages/ko/insights.json`
- Modify: `apps/web/messages/en/insights.json`
- Create: `apps/web/lib/ai-utilization-ui.test.ts`

**Interfaces:**
- Consumes: `getCachedPersonalUtilization`, `PersonalUtilizationResult`
- Produces: 개인 전용 점수·세부 축·중립 관측·계산 불가 UI

- [ ] **Step 1: UI 계약 실패 테스트 작성**

source contract test가 다음을 검증한다.

```ts
assert.match(page, /getCachedPersonalUtilization\(userId\)/);
assert.match(card, /methodologyVersion/);
assert.match(card, /confidence/);
assert.match(card, /dimension\.currentValue/);
assert.doesNotMatch(card, /prompt_records|contentCollection|TOARD_SHIM_COLLECT_CONTENT/);
assert.doesNotMatch(card, /ranking|rank|productivity/);
```

한국어·영어 JSON은 `utilization.title`, `utilization.baseline`, 세 축, 세 confidence, 모든 reason code를 가져야 한다.

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @toard/web exec node --import tsx --test lib/ai-utilization-ui.test.ts`

Expected: FAIL because the component and message keys do not exist.

- [ ] **Step 3: Server Component 구현**

카드는 다음 상태를 렌더한다.

- score 있음: 큰 숫자, 자기 기준 문구, confidence badge.
- score 없음: `계산할 데이터가 부족합니다`; 숫자 0 미표시.
- 세 축: score 또는 `—`, current 비율, baseline 비율, reason.
- 중립 관측: 활성일, 세션, 도구 사용 세션 비율, 도구 종류.
- footer: current/baseline 기간, `utilization-v1`, 최대 10분 지연.

빨강·초록 성공/실패 색상을 쓰지 않고 기존 muted/chart 토큰을 사용한다.

- [ ] **Step 4: 개인 페이지 연결**

`comparison`과 `utilization`을 `Promise.all`로 조회한다. 사용량 empty 상태와 무관하게 활용 지수 카드는 렌더해 기준선 부족 이유를 보여준다. 카드 위치는 `PricingNotice` 다음, 기존 `주요 변화` 앞이다.

- [ ] **Step 5: 테스트·타입 검사**

Run: `pnpm --filter @toard/web test && pnpm --filter @toard/web typecheck`

Expected: PASS.

- [ ] **Step 6: 커밋**

```bash
git add apps/web/components/dashboard/utilization-index-card.tsx 'apps/web/app/(dashboard)/insights/page.tsx' apps/web/messages/ko/insights.json apps/web/messages/en/insights.json apps/web/lib/ai-utilization-ui.test.ts
git commit -m "feat(ui): 개인 AI 활용 지수를 표시"
```

### Task 7: 조직 익명 집계 UI

**Files:**
- Create: `apps/web/components/dashboard/org-utilization-card.tsx`
- Modify: `apps/web/app/(dashboard)/org/page.tsx`
- Modify: `apps/web/messages/ko/org.json`
- Modify: `apps/web/messages/en/org.json`
- Modify: `apps/web/lib/ai-utilization-ui.test.ts`

**Interfaces:**
- Consumes: `getCachedOrganizationUtilization`, `OrganizationUtilizationResult`
- Produces: 중앙값·IQR·세부 축 중앙값·개인 기준 상태 비율 또는 표본 억제 상태

- [ ] **Step 1: 개인정보 UI 실패 테스트 추가**

```ts
assert.match(orgPage, /getCachedOrganizationUtilization\(\)/);
assert.match(orgCard, /result\.state === "suppressed"/);
assert.doesNotMatch(orgCard, /userId|email|individualScores|leaderboard/i);
assert.match(koOrg, /활성 사용자 5명/);
assert.match(enOrg, /5 active users/);
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @toard/web exec node --import tsx --test lib/ai-utilization-ui.test.ts`

Expected: FAIL because the organization card does not exist.

- [ ] **Step 3: 조직 카드 구현**

- `available`: median, p25~p75, 세 축 median, above/usual/below 비율, 포함 인원.
- `suppressed`: 숫자·차트 없이 최소 표본 안내.
- `insufficient_data`: 활성 사용자는 충분하지만 신뢰도 보통 이상 결과가 부족하다는 안내.
- 정책 링크와 `개인 순위나 성과평가에 사용하지 않습니다` 설명.

- [ ] **Step 4: 조직 페이지 연결**

`OverviewTab`의 기존 병렬 조회에 조직 활용 지수를 추가하고, 도구 활동 카드 다음에 배치한다. 기존 `topUsers`·`topTeams` 데이터와 props를 공유하지 않는다.

- [ ] **Step 5: 테스트·타입 검사**

Run: `pnpm --filter @toard/web test && pnpm --filter @toard/web typecheck`

Expected: PASS.

- [ ] **Step 6: 커밋**

```bash
git add apps/web/components/dashboard/org-utilization-card.tsx 'apps/web/app/(dashboard)/org/page.tsx' apps/web/messages/ko/org.json apps/web/messages/en/org.json apps/web/lib/ai-utilization-ui.test.ts
git commit -m "feat(ui): 조직 활용 지수 익명 집계를 표시"
```

### Task 8: 정책 일치·전체 검증

**Files:**
- Modify: `docs/ai-utilization-methodology.md` only if implementation reason/type names differ
- Modify: `docs/superpowers/specs/2026-07-15-ai-utilization-index-design.md` only if verified implementation boundaries differ
- Modify: `README.md` to link the policy and methodology from the feature documentation section

**Interfaces:**
- Consumes: Tasks 1~7 completed implementation
- Produces: verified repository state and operator-facing documentation links

- [ ] **Step 1: 문서·코드 계약 검사 작성 또는 갱신**

`apps/web/lib/ai-utilization-ui.test.ts`에 다음 source checks를 둔다.

```ts
for (const forbidden of ["prompt_records", "content_ciphertext", "turn_role"]) {
  assert.equal(serviceSource.includes(forbidden), false);
}
assert.match(methodology, /utilization-v1/);
assert.match(policy, /활성 사용자가 5명/);
```

- [ ] **Step 2: 집중 테스트 실행**

Run:

```bash
pnpm --filter @toard/core test
pnpm --filter @toard/storage-postgres test
pnpm --filter @toard/storage-clickhouse test
pnpm --filter @toard/web test
```

Expected: all PASS.

- [ ] **Step 3: 전체 정적·회귀 검증**

Run:

```bash
pnpm -r typecheck
pnpm -r test
pnpm test:migrations
git diff --check origin/main...HEAD
```

Expected: all commands exit 0.

- [ ] **Step 4: 개인정보·표본 경계 audit**

- 개인 서비스가 호출자 user ID를 강제하는지 코드 확인.
- 조직 반환형·JSON fixture에 user ID·이메일·이름·개인 점수가 없는지 테스트 확인.
- 4명 suppressed, 5명 available, 5명 active지만 유효 결과 4명인 insufficient 상태 확인.
- 콘텐츠 수집 상태를 참조하는 import·SQL·문자열이 없는지 `rg` 확인.
- unknown outcome이 성공으로 계산되지 않는지 core fixture 확인.

- [ ] **Step 5: 로컬 화면 검증**

개발 DB에 현재 7일과 기준 28일 fixture를 넣은 로컬 환경에서 다음을 확인한다.

- `/insights`: 점수, 세 축, 신뢰도, 기간, 방법론 버전.
- `/insights`: 데이터 부족 사용자는 0점이 아니라 계산 불가.
- `/org`: 4명 fixture는 숫자 없는 억제 상태.
- `/org`: 5명 fixture는 중앙값·IQR만 표시하고 개인 행 없음.
- 데스크톱과 390px 폭에서 overflow와 정보 계층 확인.

- [ ] **Step 6: README 링크와 최종 커밋**

```bash
git add README.md docs/ai-utilization-methodology.md docs/superpowers/specs/2026-07-15-ai-utilization-index-design.md apps/web/lib/ai-utilization-ui.test.ts
git commit -m "docs(insights): AI 활용 지수 운영 문서를 연결"
```

