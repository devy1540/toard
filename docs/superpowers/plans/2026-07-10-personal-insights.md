# Personal Insights Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 개인 메뉴에 비용·세션·토큰·모델·도구 변화를 직전 대응 기간과 비교해 규칙 기반으로 요약하는 `/insights` 화면을 추가한다.

**Architecture:** `StorageBackend`에 현재·이전 기간을 한 번에 집계하는 공통 계약을 추가하고 PostgreSQL과 ClickHouse가 같은 DTO를 반환한다. ClickHouse는 기존 15분 rollup+raw tail source를 재사용하며, 웹 계층은 사용자·기간·provider별 10분 캐시 위에서 순수 규칙 엔진과 요약 우선 UI를 렌더링한다.

**Tech Stack:** TypeScript 5.7, Next.js 15 App Router, React 19 Server Components, next-intl, Recharts, PostgreSQL 16, ClickHouse 24, Node test runner, pnpm 9.

## Global Constraints

- 메뉴 순서는 `내 사용량 → 인사이트 → 히스토리`다.
- 첫 버전의 기간은 `최근 7일`, `이번 주`, `이번 달`만 제공한다.
- 이번 주와 이번 달은 직전 기간의 같은 경과 길이와 비교한다.
- ClickHouse는 `usage_15m_rollup`과 최신 raw tail을 합친 source를 사용한다.
- 캐시 미스 한 번당 ClickHouse 쿼리 요청은 최대 2개다.
- 사용자·기간·provider·타임존별 집계 DTO를 10분 캐시한다.
- 규칙 문장 임계값은 수치 변화 10%, 구성 변화 5%p이며 최대 3개만 노출한다.
- 비율 기반 문장은 양쪽 기간 모두 세션 5개 이상일 때만 만든다.
- KPI와 차트는 임계값과 무관하게 실제 값을 표시한다.
- 신규 런타임 의존성과 별도 캐시·스냅샷 테이블을 추가하지 않는다.
- 한국어와 영어 메시지를 함께 추가한다.
- 작업 완료 판단 전에 PostgreSQL↔ClickHouse 동등성, raw↔15분 hybrid 동등성, 타입 검사, 브라우저 렌더를 확인한다.

---

## File Structure

- `apps/web/lib/insight-period.ts`: 프리셋 파싱과 현재·이전 비교 기간 계산만 담당한다.
- `apps/web/lib/insight-period.test.ts`: 롤링 7일, 주·월 경과 길이, 타임존 경계를 검증한다.
- `packages/core/src/storage.ts`: 저장소 공통 인사이트 쿼리·결과 타입과 `StorageBackend` 메서드를 선언한다.
- `packages/core/src/insights.ts`: 저장소가 반환한 기간별 행을 정렬된 DTO로 조립하는 공통 순수 함수를 둔다.
- `packages/core/src/insights.test.ts`: trend 위치 정렬과 빈 구성 정규화를 검증한다.
- `apps/web/lib/insight-rules.ts`: DTO를 번역 가능한 최대 3개 후보로 바꾸는 규칙 엔진을 둔다.
- `apps/web/lib/insight-rules.test.ts`: 10%, 5%p, 최소 세션, 0값, 우선순위를 검증한다.
- `packages/storage-postgres/src/storage.ts`: PostgreSQL의 2-query 인사이트 집계를 구현한다.
- `packages/storage-clickhouse/src/storage.ts`: 15분 hybrid source 기반 2-query 인사이트 집계를 구현한다.
- `scripts/verify-equivalence.ts`: PostgreSQL과 ClickHouse raw 인사이트 결과를 비교한다.
- `scripts/verify-clickhouse-exact-rollup.ts`: ClickHouse raw와 15분 hybrid 인사이트 결과를 비교한다.
- `apps/web/lib/user-insights.ts`: ISO 인자 변환, 10분 캐시, 계산 시각 부착을 담당한다.
- `apps/web/lib/user-insights.test.ts`: 캐시 키에 사용자·기간·provider·타임존이 모두 들어가는지 검증한다.
- `apps/web/app/(dashboard)/insights/page.tsx`: 인증·기간·provider를 해석하고 인사이트 화면을 조립한다.
- `apps/web/components/dashboard/insight-filters.tsx`: 세 기간과 provider, metric URL 상태를 제어한다.
- `apps/web/components/charts/insight-comparison-chart.tsx`: 현재·이전 기간 추이를 겹쳐 그린다.
- `apps/web/components/dashboard/insight-composition.tsx`: 모델·도구 구성 변화를 표시한다.
- `apps/web/components/dashboard/sidebar-nav.tsx`: 개인 메뉴에 인사이트 링크를 추가한다.
- `apps/web/messages/{ko,en}/insights.json`: 화면·규칙 문장을 제공한다.
- `apps/web/messages/{ko,en}/nav.json`, `apps/web/i18n/{request,messages}.ts`: 새 namespace를 등록한다.
- `apps/web/lib/ui-commonization.test.ts`: 메뉴·메시지·공통 UI 사용을 소스 수준에서 검증한다.

---

### Task 1: 비교 기간 계산

**Files:**
- Create: `apps/web/lib/insight-period.ts`
- Create: `apps/web/lib/insight-period.test.ts`
- Read: `apps/web/lib/org-time.ts`

**Interfaces:**
- Consumes: `dayStartUtc()` from `apps/web/lib/org-time.ts`.
- Produces: `InsightPreset`, `parseInsightPreset(value)`, `buildInsightPeriodPair(preset, timezone, now)`.

- [ ] **Step 1: Write the failing period tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { buildInsightPeriodPair, parseInsightPreset } from "./insight-period";

test("parseInsightPreset는 세 프리셋 외 값을 최근 7일로 폴백한다", () => {
  assert.equal(parseInsightPreset("week"), "week");
  assert.equal(parseInsightPreset("month"), "month");
  assert.equal(parseInsightPreset("7"), "7");
  assert.equal(parseInsightPreset("custom"), "7");
});

test("최근 7일은 직전 7일과 연속되고 겹치지 않는다", () => {
  const now = new Date("2026-07-10T04:00:00.000Z");
  const pair = buildInsightPeriodPair("7", "Asia/Seoul", now);
  assert.equal(pair.current.to.toISOString(), now.toISOString());
  assert.equal(pair.previous.to.toISOString(), pair.current.from.toISOString());
  assert.equal(pair.current.to.getTime() - pair.current.from.getTime(), 7 * 86_400_000);
  assert.equal(pair.previous.to.getTime() - pair.previous.from.getTime(), 7 * 86_400_000);
});

test("이번 주는 지난주의 같은 경과 길이와 비교한다", () => {
  const now = new Date("2026-07-08T03:30:00.000Z");
  const pair = buildInsightPeriodPair("week", "Asia/Seoul", now);
  assert.equal(pair.current.to.toISOString(), now.toISOString());
  assert.equal(
    pair.current.to.getTime() - pair.current.from.getTime(),
    pair.previous.to.getTime() - pair.previous.from.getTime(),
  );
  assert.equal(pair.previous.to.getTime() <= pair.current.from.getTime(), true);
});

test("이번 달은 지난달 말일을 넘기지 않는다", () => {
  const now = new Date("2026-03-31T12:00:00.000Z");
  const pair = buildInsightPeriodPair("month", "UTC", now);
  assert.equal(pair.previous.to.toISOString(), "2026-03-01T00:00:00.000Z");
  assert.equal(pair.previous.from.toISOString(), "2026-02-01T00:00:00.000Z");
});
```

- [ ] **Step 2: Run the tests and verify the module is missing**

Run: `pnpm --filter @toard/web test`

Expected: FAIL with `Cannot find module './insight-period'`.

- [ ] **Step 3: Implement the minimal period module**

```ts
import type { PeriodQuery } from "@toard/core";
import { dayStartUtc } from "./org-time";

const DAY_MS = 86_400_000;
export const INSIGHT_PRESETS = ["7", "week", "month"] as const;
export type InsightPreset = (typeof INSIGHT_PRESETS)[number];

export interface InsightPeriodPair {
  preset: InsightPreset;
  current: PeriodQuery;
  previous: PeriodQuery;
  timezone: string;
}

export function parseInsightPreset(value: string | undefined): InsightPreset {
  return INSIGHT_PRESETS.includes(value as InsightPreset) ? (value as InsightPreset) : "7";
}

function dateKey(at: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

function addDays(ymd: string, days: number): string {
  const [year, month, day] = ymd.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
}

function monthStart(ymd: string, offset = 0): string {
  const [year, month] = ymd.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1 + offset, 1)).toISOString().slice(0, 10);
}

function weekStart(ymd: string): string {
  const [year, month, day] = ymd.split("-").map(Number);
  const weekday = new Date(Date.UTC(year!, month! - 1, day!)).getUTCDay();
  return addDays(ymd, -weekday);
}

export function buildInsightPeriodPair(preset: InsightPreset, timezone: string, now = new Date()): InsightPeriodPair {
  if (preset === "7") {
    const current = { from: new Date(now.getTime() - 7 * DAY_MS), to: now };
    return {
      preset,
      current,
      previous: { from: new Date(current.from.getTime() - 7 * DAY_MS), to: current.from },
      timezone,
    };
  }

  const today = dateKey(now, timezone);
  const currentStartKey = preset === "week" ? weekStart(today) : monthStart(today);
  const previousStartKey = preset === "week" ? addDays(currentStartKey, -7) : monthStart(currentStartKey, -1);
  const current = { from: dayStartUtc(currentStartKey, timezone), to: now };
  const previousFull = {
    from: dayStartUtc(previousStartKey, timezone),
    to: dayStartUtc(currentStartKey, timezone),
  };
  const elapsed = current.to.getTime() - current.from.getTime();
  const previousTo = new Date(Math.min(previousFull.to.getTime(), previousFull.from.getTime() + elapsed));
  return { preset, current, previous: { from: previousFull.from, to: previousTo }, timezone };
}
```

- [ ] **Step 4: Run the period tests**

Run: `pnpm --filter @toard/web test`

Expected: PASS for the four new tests.

- [ ] **Step 5: Commit the period calculation**

```bash
git add apps/web/lib/insight-period.ts apps/web/lib/insight-period.test.ts
git commit -m "feat(insights): 비교 기간 계산 추가"
```

---

### Task 2: 공통 DTO와 규칙 엔진

**Files:**
- Create: `packages/core/src/insights.ts`
- Create: `packages/core/src/insights.test.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/storage.ts`
- Create: `apps/web/lib/insight-rules.ts`
- Create: `apps/web/lib/insight-rules.test.ts`

**Interfaces:**
- Consumes: `InsightComparisonQuery`, `InsightAggregateRow`, `InsightCompositionRow`.
- Produces: `UserInsightComparison`, `buildUserInsightComparison(rows, compositions)`, `generateInsightCandidates(comparison, metric)`.

- [ ] **Step 1: Write failing core DTO assembly tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { buildUserInsightComparison } from "./insights";

test("기간 행을 같은 position의 현재·이전 trend로 정렬한다", () => {
  const result = buildUserInsightComparison(
    [
      { kind: "summary", period: "current", position: null, costUsd: 12, sessions: 6, totalTokens: 120 },
      { kind: "summary", period: "previous", position: null, costUsd: 10, sessions: 5, totalTokens: 100 },
      { kind: "trend", period: "previous", position: 0, costUsd: 4, sessions: 2, totalTokens: 40 },
      { kind: "trend", period: "current", position: 0, costUsd: 6, sessions: 3, totalTokens: 60 },
    ],
    [],
  );
  assert.deepEqual(result.current, { costUsd: 12, sessions: 6, totalTokens: 120 });
  assert.deepEqual(result.previous, { costUsd: 10, sessions: 5, totalTokens: 100 });
  assert.deepEqual(result.trend[0], {
    position: 0,
    current: { costUsd: 6, sessions: 3, totalTokens: 60 },
    previous: { costUsd: 4, sessions: 2, totalTokens: 40 },
  });
});

test("빈 모델·provider 키를 unknown으로 정규화한다", () => {
  const result = buildUserInsightComparison([], [
    { dimension: "model", key: "", period: "current", costUsd: 1, totalTokens: 10 },
    { dimension: "provider", key: "codex", period: "previous", costUsd: 2, totalTokens: 20 },
  ]);
  assert.equal(result.byModel[0]?.key, "(unknown)");
  assert.equal(result.byProvider[0]?.key, "codex");
});
```

- [ ] **Step 2: Run core tests and verify failure**

Run: `pnpm --filter @toard/core test`

Expected: FAIL because `./insights` does not exist.

- [ ] **Step 3: Add exact common types and the DTO assembler**

Add to `packages/core/src/storage.ts`:

```ts
export interface InsightComparisonQuery {
  current: { from: Date; to: Date };
  previous: { from: Date; to: Date };
  providerKey?: string;
  timezone: string;
}

export interface InsightMetricSummary {
  costUsd: number;
  sessions: number;
  totalTokens: number;
}

export interface InsightTrendPoint {
  position: number;
  current: InsightMetricSummary;
  previous: InsightMetricSummary;
}

export interface InsightCompositionChange {
  key: string;
  current: { costUsd: number; totalTokens: number };
  previous: { costUsd: number; totalTokens: number };
}

export interface UserInsightComparison {
  current: InsightMetricSummary;
  previous: InsightMetricSummary;
  trend: InsightTrendPoint[];
  byModel: InsightCompositionChange[];
  byProvider: InsightCompositionChange[];
}
```

Create `packages/core/src/insights.ts` with exported row types and a deterministic assembler that:

```ts
export type InsightPeriod = "current" | "previous";
export type InsightAggregateRow = {
  kind: "summary" | "trend";
  period: InsightPeriod;
  position: number | null;
  costUsd: number;
  sessions: number;
  totalTokens: number;
};
export type InsightCompositionRow = {
  dimension: "model" | "provider";
  key: string;
  period: InsightPeriod;
  costUsd: number;
  totalTokens: number;
};

const zeroSummary = (): InsightMetricSummary => ({ costUsd: 0, sessions: 0, totalTokens: 0 });
```

The function must merge both periods by position/key, fill absent sides with zeroes, sort `trend` by `position`, and sort composition by descending current cost.

Export it from `packages/core/src/index.ts`:

```ts
export * from "./insights";
```

- [ ] **Step 4: Run core tests**

Run: `pnpm --filter @toard/core test`

Expected: PASS.

- [ ] **Step 5: Write failing rule tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import type { UserInsightComparison } from "@toard/core";
import { generateInsightCandidates } from "./insight-rules";

const base = (overrides: Partial<UserInsightComparison> = {}): UserInsightComparison => ({
  current: { costUsd: 110, sessions: 11, totalTokens: 109 },
  previous: { costUsd: 100, sessions: 10, totalTokens: 100 },
  trend: [],
  byModel: [],
  byProvider: [],
  ...overrides,
});

test("10% 수치 변화는 포함하고 10% 미만은 제외한다", () => {
  const keys = generateInsightCandidates(base(), "cost").map((v) => v.key);
  assert.equal(keys.includes("cost.increase"), true);
  assert.equal(keys.includes("tokens.increase"), false);
});

test("5%p 구성 변화는 포함한다", () => {
  const result = generateInsightCandidates(base({
    byModel: [{
      key: "claude",
      current: { costUsd: 66, totalTokens: 66 },
      previous: { costUsd: 50, totalTokens: 50 },
    }],
  }), "cost");
  assert.equal(result.some((v) => v.key === "composition.increase"), true);
});

test("세션이 5개 미만이면 비율 기반 문장을 만들지 않는다", () => {
  const result = generateInsightCandidates(base({
    current: { costUsd: 20, sessions: 4, totalTokens: 20 },
    previous: { costUsd: 10, sessions: 4, totalTokens: 10 },
  }), "cost");
  assert.equal(result.some((v) => v.key === "efficiency.increase" || v.key === "efficiency.decrease"), false);
});

test("후보는 점수순 최대 3개다", () => {
  const result = generateInsightCandidates(base({
    current: { costUsd: 200, sessions: 20, totalTokens: 200 },
    previous: { costUsd: 100, sessions: 10, totalTokens: 100 },
    byProvider: [{ key: "codex", current: { costUsd: 180, totalTokens: 180 }, previous: { costUsd: 20, totalTokens: 20 } }],
  }), "cost");
  assert.equal(result.length, 3);
  assert.deepEqual([...result].sort((a, b) => b.score - a.score), result);
});
```

- [ ] **Step 6: Run rule tests and verify failure**

Run: `pnpm --filter @toard/web test`

Expected: FAIL because `./insight-rules` does not exist.

- [ ] **Step 7: Implement the rule engine**

```ts
import type { InsightCompositionChange, UserInsightComparison } from "@toard/core";

export type InsightMetric = "cost" | "tokens";
export type InsightRuleKey =
  | "cost.increase" | "cost.decrease"
  | "sessions.increase" | "sessions.decrease"
  | "tokens.increase" | "tokens.decrease"
  | "efficiency.increase" | "efficiency.decrease"
  | "composition.increase" | "composition.decrease"
  | "composition.new";

export interface InsightCandidate {
  key: InsightRuleKey;
  score: number;
  values: Record<string, number | string>;
}

const RATE_THRESHOLD = 10;
const SHARE_THRESHOLD = 5;
const MIN_SESSIONS = 5;
const MAX_INSIGHTS = 3;

function rate(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

function compositionCandidates(
  rows: InsightCompositionChange[],
  totalCurrent: number,
  totalPrevious: number,
  metric: InsightMetric,
  dimension: "model" | "provider",
): InsightCandidate[] {
  return rows.flatMap((row) => {
    const current = metric === "cost" ? row.current.costUsd : row.current.totalTokens;
    const previous = metric === "cost" ? row.previous.costUsd : row.previous.totalTokens;
    if (previous === 0 && current > 0) {
      return [{ key: "composition.new", score: 100, values: { name: row.key, dimension } }];
    }
    if (totalCurrent === 0 || totalPrevious === 0) return [];
    const delta = (current / totalCurrent - previous / totalPrevious) * 100;
    if (Math.abs(delta) < SHARE_THRESHOLD) return [];
    return [{
      key: delta > 0 ? "composition.increase" : "composition.decrease",
      score: Math.abs(delta),
      values: { name: row.key, delta: Math.abs(delta), dimension },
    }];
  });
}

function rateCandidate(
  name: "cost" | "sessions" | "tokens" | "efficiency",
  current: number,
  previous: number,
): InsightCandidate | null {
  const delta = rate(current, previous);
  if (delta == null || Math.abs(delta) < RATE_THRESHOLD) return null;
  return {
    key: `${name}.${delta > 0 ? "increase" : "decrease"}` as InsightRuleKey,
    score: Math.abs(delta),
    values: { delta: Math.abs(delta) },
  };
}

export function generateInsightCandidates(
  comparison: UserInsightComparison,
  metric: InsightMetric,
): InsightCandidate[] {
  const candidates: InsightCandidate[] = [];
  const add = (candidate: InsightCandidate | null) => {
    if (candidate) candidates.push(candidate);
  };
  add(rateCandidate("cost", comparison.current.costUsd, comparison.previous.costUsd));
  add(rateCandidate("sessions", comparison.current.sessions, comparison.previous.sessions));
  add(rateCandidate("tokens", comparison.current.totalTokens, comparison.previous.totalTokens));
  if (comparison.current.sessions >= MIN_SESSIONS && comparison.previous.sessions >= MIN_SESSIONS) {
    add(rateCandidate(
      "efficiency",
      comparison.current.costUsd / comparison.current.sessions,
      comparison.previous.costUsd / comparison.previous.sessions,
    ));
  }
  const totalCurrent = metric === "cost" ? comparison.current.costUsd : comparison.current.totalTokens;
  const totalPrevious = metric === "cost" ? comparison.previous.costUsd : comparison.previous.totalTokens;
  candidates.push(
    ...compositionCandidates(comparison.byModel, totalCurrent, totalPrevious, metric, "model"),
    ...compositionCandidates(comparison.byProvider, totalCurrent, totalPrevious, metric, "provider"),
  );
  return candidates.sort((a, b) => b.score - a.score).slice(0, MAX_INSIGHTS);
}
```

- [ ] **Step 8: Run core and web tests**

Run: `pnpm --filter @toard/core test && pnpm --filter @toard/web test`

Expected: PASS.

- [ ] **Step 9: Commit DTO and rules**

```bash
git add packages/core/src apps/web/lib/insight-rules.ts apps/web/lib/insight-rules.test.ts
git commit -m "feat(insights): 인사이트 규칙 엔진 추가"
```

---

### Task 3: PostgreSQL·ClickHouse 전용 집계

**Files:**
- Modify: `packages/storage-postgres/src/storage.ts`
- Modify: `packages/storage-clickhouse/src/storage.ts`
- Modify: `scripts/verify-equivalence.ts`
- Modify: `scripts/verify-clickhouse-exact-rollup.ts`

**Interfaces:**
- Consumes: `InsightComparisonQuery`, `buildUserInsightComparison()`.
- Produces: `PostgresStorage.getUserInsightComparison()` and `ClickHouseStorage.getUserInsightComparison()`.

- [ ] **Step 1: Add failing integration assertions**

Add to `scripts/verify-equivalence.ts` after the existing `getUserUsage` comparison:

```ts
const insightQuery = {
  previous: { from: new Date("2027-09-14T00:00:00Z"), to: new Date("2027-09-15T00:00:00Z") },
  current: { from: new Date("2027-09-15T00:00:00Z"), to: new Date("2027-09-16T00:00:00Z") },
  providerKey: pk,
  timezone: "UTC",
};
await cmp("getUserInsightComparison", (s) => s.getUserInsightComparison(u0, insightQuery));
```

Add to `scripts/verify-clickhouse-exact-rollup.ts` after 15-minute compaction:

```ts
const insightQuery = {
  previous: { from: new Date("2019-12-31T00:00:00Z"), to: from },
  current: { from, to },
  providerKey,
  timezone: "UTC",
};
assertEqual(
  await rollup15m.getUserInsightComparison(userId, insightQuery),
  await raw.getUserInsightComparison(userId, insightQuery),
  "insights raw vs hybrid rollup",
);
```

- [ ] **Step 2: Run typecheck and verify both storage classes miss the interface method**

Add the method to `StorageBackend` in `packages/core/src/storage.ts`:

```ts
getUserInsightComparison(userId: string, q: InsightComparisonQuery): Promise<UserInsightComparison>;
```

Then run: `pnpm --filter @toard/storage-postgres typecheck && pnpm --filter @toard/storage-clickhouse typecheck`

Expected: FAIL with `Property 'getUserInsightComparison' is missing`.

- [ ] **Step 3: Implement PostgreSQL summary/trend query**

Add a private query that uses one materialized scoped CTE over `[previous.from, current.to)` and returns tagged summary/trend rows:

```sql
WITH scoped AS MATERIALIZED (
  SELECT
    CASE WHEN ts >= $3 AND ts < $4 THEN 'current' ELSE 'previous' END AS period,
    ts,
    session_id,
    cost_usd,
    input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens AS tokens,
    model,
    provider_key
  FROM usage_events
  WHERE ts >= $1 AND ts < $4
    AND user_id = $5
    AND ($6::text IS NULL OR provider_key = $6)
), tagged AS (
  SELECT *,
    CASE WHEN period = 'current'
      THEN FLOOR(EXTRACT(EPOCH FROM (ts - $3)) / 86400)::int
      ELSE FLOOR(EXTRACT(EPOCH FROM (ts - $1)) / 86400)::int
    END AS position
  FROM scoped
)
SELECT 'summary' AS kind, period, NULL::int AS position,
       COALESCE(SUM(cost_usd), 0) AS cost,
       COUNT(DISTINCT session_id) AS sessions,
       COALESCE(SUM(tokens), 0) AS tokens
FROM tagged GROUP BY period
UNION ALL
SELECT 'trend' AS kind, period, position,
       COALESCE(SUM(cost_usd), 0), COUNT(DISTINCT session_id), COALESCE(SUM(tokens), 0)
FROM tagged GROUP BY period, position
ORDER BY kind, position, period
```

Pass parameters exactly as `[previous.from, previous.to, current.from, current.to, userId, q.providerKey ?? null]`. The `CASE` must reject the gap between `previous.to` and `current.from`; add `AND ((ts >= $1 AND ts < $2) OR (ts >= $3 AND ts < $4))` to `scoped`.

- [ ] **Step 4: Implement PostgreSQL model/provider composition query**

Use a second materialized scoped CTE and return both dimensions in one query:

```sql
WITH scoped AS MATERIALIZED (
  SELECT CASE WHEN ts >= $3 AND ts < $4 THEN 'current' ELSE 'previous' END AS period,
         COALESCE(model, '(unknown)') AS model,
         provider_key,
         cost_usd,
         input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens AS tokens
  FROM usage_events
  WHERE user_id = $5
    AND ((ts >= $1 AND ts < $2) OR (ts >= $3 AND ts < $4))
    AND ($6::text IS NULL OR provider_key = $6)
)
SELECT 'model' AS dimension, model AS key, period, SUM(cost_usd) AS cost, SUM(tokens) AS tokens
FROM scoped GROUP BY model, period
UNION ALL
SELECT 'provider' AS dimension, provider_key AS key, period, SUM(cost_usd), SUM(tokens)
FROM scoped GROUP BY provider_key, period
```

Map numeric strings with the existing `n()` helper and call `buildUserInsightComparison()`.

- [ ] **Step 5: Generalize the ClickHouse hybrid source for insight ranges**

Keep `rollup15mTimeseriesSource()` behavior unchanged for existing callers. Add an internal helper that accepts the combined outer range and returns the same normalized columns:

```ts
private async insightSource(q: InsightComparisonQuery, userId: string): Promise<InsightSource> {
  const combined = {
    from: q.previous.from,
    to: q.current.to,
    providerKey: q.providerKey,
    userId,
  };
  const hybrid = await this.rollup15mTimeseriesSource(combined);
  if (hybrid) return { kind: "hybrid", source: hybrid.source, params: hybrid.params };
  const raw = this.periodWhere(combined);
  return { kind: "raw", source: this.usageEventsSource, where: raw.where, params: raw.params };
}
```

Represent the result with a discriminated union so callers cannot forget the raw `where` clause:

```ts
type InsightSource =
  | { kind: "hybrid"; source: string; params: Params }
  | { kind: "raw"; source: string; where: string; params: Params };
```

- [ ] **Step 6: Implement the two ClickHouse insight queries**

The summary/trend request must start with the stable query comment `/* user-insights */`, tag rows with `if(ts >= {currentFrom}, 'current', 'previous')`, filter out any gap, and compute `position` with `dateDiff('day', start, ts, timezone)`. The composition request must use the same query comment and return model and provider rows using `UNION ALL`. Both queries use the normalized source from Step 5, bind `currentFrom/currentTo/previousFrom/previousTo`, and map results through `buildUserInsightComparison()`.

Use ClickHouse expressions:

```sql
sum(cost_usd) AS cost,
uniqExactIf(session_id, session_id != '') AS sessions,
sum(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens) AS tokens
```

For rollup rows, keep `argMax(..., version)` deduplication inside the existing hybrid source. Do not add `FINAL` or another table.

- [ ] **Step 7: Run typechecks and integration verifiers**

Run:

```bash
pnpm --filter @toard/core typecheck
pnpm --filter @toard/storage-postgres typecheck
pnpm --filter @toard/storage-clickhouse typecheck
DATABASE_URL=postgresql://toard:toard@localhost:5432/toard CLICKHOUSE_URL=http://localhost:8123 pnpm tsx scripts/verify-equivalence.ts
DATABASE_URL=postgresql://toard:toard@localhost:5432/toard CLICKHOUSE_URL=http://localhost:8123 pnpm tsx scripts/verify-clickhouse-exact-rollup.ts
```

Expected: typechecks PASS, equivalence prints `✓ getUserInsightComparison`, exact rollup prints JSON with `"ok":true` and no mismatch.

- [ ] **Step 8: Commit storage aggregation**

```bash
git add packages/storage-postgres/src/storage.ts packages/storage-clickhouse/src/storage.ts scripts/verify-equivalence.ts scripts/verify-clickhouse-exact-rollup.ts
git commit -m "feat(storage): 개인 인사이트 집계 추가"
```

---

### Task 4: 10분 사용자별 결과 캐시

**Files:**
- Create: `apps/web/lib/user-insights.ts`
- Create: `apps/web/lib/user-insights.test.ts`

**Interfaces:**
- Consumes: `getStorage().getUserInsightComparison()` and `InsightPeriodPair`.
- Produces: `getCachedUserInsights(userId, pair, providerKey)` and `CachedUserInsights`.

- [ ] **Step 1: Write the failing cache-key test**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { insightCacheArgs } from "./user-insights";

test("인사이트 캐시 인자에 사용자·기간·provider·타임존이 모두 포함된다", () => {
  const args = insightCacheArgs("user-a", {
    preset: "7",
    current: { from: new Date("2026-07-03T00:00:00Z"), to: new Date("2026-07-10T00:00:00Z") },
    previous: { from: new Date("2026-06-26T00:00:00Z"), to: new Date("2026-07-03T00:00:00Z") },
    timezone: "Asia/Seoul",
  }, "codex");
  assert.deepEqual(args, [
    "user-a", "2026-07-03T00:00:00.000Z", "2026-07-10T00:00:00.000Z",
    "2026-06-26T00:00:00.000Z", "2026-07-03T00:00:00.000Z", "codex", "Asia/Seoul",
  ]);
});
```

- [ ] **Step 2: Run the cache-key test and verify failure**

Run: `pnpm --filter @toard/web test`

Expected: FAIL because `./user-insights` does not exist.

- [ ] **Step 3: Implement ISO argument conversion and Next data cache**

```ts
import { unstable_cache } from "next/cache";
import type { UserInsightComparison } from "@toard/core";
import type { InsightPeriodPair } from "./insight-period";
import { getStorage } from "./storage";

export type CachedUserInsights = UserInsightComparison & { calculatedAt: string };

export function insightCacheArgs(userId: string, pair: InsightPeriodPair, providerKey?: string) {
  return [
    userId,
    pair.current.from.toISOString(),
    pair.current.to.toISOString(),
    pair.previous.from.toISOString(),
    pair.previous.to.toISOString(),
    providerKey ?? "",
    pair.timezone,
  ] as const;
}

const readCached = unstable_cache(
  async (
    userId: string,
    currentFrom: string,
    currentTo: string,
    previousFrom: string,
    previousTo: string,
    providerKey: string,
    timezone: string,
  ): Promise<CachedUserInsights> => ({
    ...(await getStorage().getUserInsightComparison(userId, {
      current: { from: new Date(currentFrom), to: new Date(currentTo) },
      previous: { from: new Date(previousFrom), to: new Date(previousTo) },
      providerKey: providerKey || undefined,
      timezone,
    })),
    calculatedAt: new Date().toISOString(),
  }),
  ["user-insights-v1"],
  { revalidate: 600 },
);

export function getCachedUserInsights(userId: string, pair: InsightPeriodPair, providerKey?: string) {
  return readCached(...insightCacheArgs(userId, pair, providerKey));
}
```

- [ ] **Step 4: Run the test and web typecheck**

Run: `pnpm --filter @toard/web test && pnpm --filter @toard/web typecheck`

Expected: PASS.

- [ ] **Step 5: Commit caching**

```bash
git add apps/web/lib/user-insights.ts apps/web/lib/user-insights.test.ts
git commit -m "perf(insights): 사용자별 집계 캐시 추가"
```

---

### Task 5: 인사이트 메뉴·화면·i18n

**Files:**
- Create: `apps/web/app/(dashboard)/insights/page.tsx`
- Create: `apps/web/components/dashboard/insight-filters.tsx`
- Create: `apps/web/components/charts/insight-comparison-chart.tsx`
- Create: `apps/web/components/dashboard/insight-composition.tsx`
- Modify: `apps/web/components/dashboard/sidebar-nav.tsx`
- Create: `apps/web/messages/ko/insights.json`
- Create: `apps/web/messages/en/insights.json`
- Modify: `apps/web/messages/ko/nav.json`
- Modify: `apps/web/messages/en/nav.json`
- Modify: `apps/web/i18n/request.ts`
- Modify: `apps/web/i18n/messages.ts`
- Modify: `apps/web/lib/ui-commonization.test.ts`

**Interfaces:**
- Consumes: `buildInsightPeriodPair()`, `getCachedUserInsights()`, `generateInsightCandidates()`.
- Produces: `/insights` and its filter/chart/composition components.

- [ ] **Step 1: Write failing source-level UI assertions**

Add to `apps/web/lib/ui-commonization.test.ts`:

```ts
test("personal navigation includes insights between usage and history", () => {
  const nav = source("components/dashboard/sidebar-nav.tsx");
  assert.match(nav, /key: "myUsage"[\s\S]*key: "insights"[\s\S]*key: "history"/);
});

test("insights page uses the cached comparison and shared cards", () => {
  const page = source("app/(dashboard)/insights/page.tsx");
  assert.match(page, /getCachedUserInsights/);
  assert.match(page, /@\/components\/ui\/card/);
});
```

- [ ] **Step 2: Run the UI tests and verify failure**

Run: `pnpm --filter @toard/web test`

Expected: FAIL because the navigation item and page do not exist.

- [ ] **Step 3: Add navigation and message namespaces**

In `sidebar-nav.tsx`, extend `NavKey` with `insights`, import `Lightbulb`, and place:

```ts
{ href: "/insights", key: "insights", icon: Lightbulb },
```

between `myUsage` and `history`.

Add `"insights": "인사이트"` and `"insights": "Insights"` to the two nav catalogs. Register `insights.json` in both `loadMessages()` and the `next-intl` `Messages` type.

- [ ] **Step 4: Implement the URL-backed filters**

`InsightFilters` must use `SegmentedControl` for `7|week|month`, preserve `provider` and `metric`, and use the existing compact `Select` for enabled providers. Selecting a period updates only `period`; selecting provider updates only `provider`; metric uses `cost|tokens`.

Required props:

```ts
type InsightFiltersProps = {
  preset: InsightPreset;
  metric: "cost" | "tokens";
  provider: string;
  providers: ProviderOption[];
};
```

- [ ] **Step 5: Implement the comparison chart**

Create a client component using Recharts `LineChart`, two `Line`s, shared tooltip, and no animation:

```tsx
<Line type="monotone" dataKey="current" stroke="var(--color-chart-1)" strokeWidth={2} dot={false} isAnimationActive={false} />
<Line type="monotone" dataKey="previous" stroke="var(--color-muted-foreground)" strokeDasharray="4 4" dot={false} isAnimationActive={false} />
```

Map each `InsightTrendPoint` to `{ position: position + 1, current, previous }`, selecting cost or totalTokens from the metric prop.

- [ ] **Step 6: Implement the composition panel**

Render `model|provider` tabs with `SegmentedControl`. For each row compute current and previous shares from the selected metric, show `±N%p`, and sort by absolute share delta descending. Keep the top five rows and collapse all absent data to the localized empty label.

- [ ] **Step 7: Implement the server page**

The page must:

```ts
const userId = await getCurrentUserId();
const sp = await searchParams;
const preset = parseInsightPreset(sp.period);
const timezone = await getViewerTimezone();
const providerKey = sp.provider && sp.provider !== "all" ? sp.provider : undefined;
const metric = sp.metric === "tokens" ? "tokens" : "cost";
const pair = buildInsightPeriodPair(preset, timezone);
const [comparison, providers] = await Promise.all([
  getCachedUserInsights(userId, pair, providerKey),
  getEnabledProviders(),
]);
const candidates = generateInsightCandidates(comparison, metric);
```

Render the approved order: header/filter/calculated-at → highlighted summary → three KPI cards → comparison chart → composition panel. Use existing `Empty` when `comparison.current` has no sessions, cost, or tokens. Translate candidates with an exhaustive `switch` over `InsightRuleKey`; do not pass arbitrary runtime keys to `t()`.

- [ ] **Step 8: Add complete Korean and English messages**

Both catalogs must contain the same shape for title, presets, comparison labels, cache age, KPI labels, chart labels, composition tabs, empty state, and all rule keys declared in Task 2. Use neutral wording and format numeric variables through next-intl number formatting.

- [ ] **Step 9: Run UI tests and typecheck**

Run: `pnpm --filter @toard/web test && pnpm --filter @toard/web typecheck`

Expected: PASS with no missing message keys or component type errors.

- [ ] **Step 10: Commit the user-facing feature**

```bash
git add apps/web/app/'(dashboard)'/insights apps/web/components apps/web/messages apps/web/i18n apps/web/lib/ui-commonization.test.ts
git commit -m "feat(insights): 개인 인사이트 화면 추가"
```

---

### Task 6: Full verification and visual acceptance

**Files:**
- Modify if needed: files changed in Tasks 1–5 only.
- Reference: `docs/superpowers/specs/2026-07-10-personal-insights-design.md`.

**Interfaces:**
- Consumes: completed `/insights` implementation.
- Produces: verified tests, query evidence, browser screenshot, clean worktree.

- [ ] **Step 1: Run the focused test suite**

Run:

```bash
pnpm --filter @toard/core test
pnpm --filter @toard/web test
```

Expected: all tests PASS.

- [ ] **Step 2: Run all relevant typechecks**

Run:

```bash
pnpm --filter @toard/core typecheck
pnpm --filter @toard/storage-postgres typecheck
pnpm --filter @toard/storage-clickhouse typecheck
pnpm --filter @toard/web typecheck
```

Expected: all commands exit 0.

- [ ] **Step 3: Run storage equivalence checks**

Run:

```bash
DATABASE_URL=postgresql://toard:toard@localhost:5432/toard CLICKHOUSE_URL=http://localhost:8123 pnpm tsx scripts/verify-equivalence.ts
DATABASE_URL=postgresql://toard:toard@localhost:5432/toard CLICKHOUSE_URL=http://localhost:8123 pnpm tsx scripts/verify-clickhouse-exact-rollup.ts
```

Expected: `getUserInsightComparison` matches PG↔CH and raw↔15m hybrid.

- [ ] **Step 4: Verify query count from ClickHouse query log**

Generate one uncached storage call in the exact-rollup verifier with a unique period/provider, then run:

```sql
SELECT count()
FROM system.query_log
WHERE event_time >= now() - INTERVAL 5 MINUTE
  AND type = 'QueryFinish'
  AND query_kind = 'Select'
  AND query LIKE '%/* user-insights */%';
```

If comments are not preserved in query log, add a stable `/* user-insights */` query comment to both ClickHouse statements. Expected count for one `getUserInsightComparison()` call: `2`.

- [ ] **Step 5: Start or reuse the open-auth local app**

Run from the worktree:

```bash
AUTH_MODE=open AUTH_OPEN_USER_EMAIL=demo.viewer@toard.local DATABASE_URL=postgresql://toard:toard@localhost:5432/toard pnpm --dir apps/web dev --hostname 127.0.0.1 --port 3101
```

Expected: Next dev server reports ready and `curl -fsS http://127.0.0.1:3101/api/ready` returns 200.

- [ ] **Step 6: Verify the actual browser UI against the approved mockup**

Open these states:

- `/insights?period=7&metric=cost`
- `/insights?period=week&metric=tokens`
- `/insights?period=month&metric=cost`

Check desktop expanded sidebar, collapsed sidebar, and mobile drawer. Confirm summary-first hierarchy, three KPI cards, current/previous chart, model/provider composition, calculated-at label, and empty state. Capture a screenshot for the final handoff.

- [ ] **Step 7: Run final repository checks**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors and only intentional changes.

- [ ] **Step 8: Commit verification-only fixes if Step 1–7 required changes**

```bash
git add apps/web packages/core packages/storage-postgres packages/storage-clickhouse scripts/verify-equivalence.ts scripts/verify-clickhouse-exact-rollup.ts
git commit -m "test(insights): 인사이트 검증 보강"
```

Skip this commit when verification required no code changes.
