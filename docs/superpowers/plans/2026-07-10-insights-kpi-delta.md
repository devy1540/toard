# Insights KPI Delta Commonization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 인사이트의 토큰·세션·비용 KPI 증감 표시를 다른 대시보드와 같은 `pctDelta`·`DeltaBadge` 규칙으로 통일한다.

**Architecture:** 인사이트 전용 백분율 문자열 계산을 제거하고 기존 `apps/web/lib/stat-delta.ts`가 증감 데이터를 만들도록 한다. `KpiCard`는 공통 `StatDelta`와 비교 안내 문구를 받아 `DeltaBadge`를 렌더링하며, 비교 가능 여부를 설명하는 문구만 인사이트 번역 카탈로그에서 제공한다.

**Tech Stack:** TypeScript, React, Next.js, next-intl, Tailwind CSS, Node test runner

## Global Constraints

- 증가는 빨간색 상승 배지, 감소는 초록색 하락 배지로 표시한다.
- 증감률은 기존 공통 규칙대로 정수로 반올림한다.
- 이전 값이 0이거나 반올림 결과가 0%이면 배지를 표시하지 않는다.
- 극단적인 증감률은 기존 공통 규칙대로 ±999%에서 제한한다.
- 배지가 있으면 옆에 `이전 기간 대비` 문구를 유지한다.
- 배지가 없으면 기존 `이전 기간 데이터 없음` 문구를 유지해 비교 불가 상태를 설명한다.
- 인사이트 후보 문장, 구성 비중 `%p`, KPI 값 포맷, 기간 계산, 10분 캐시, PostgreSQL·ClickHouse 쿼리는 변경하지 않는다.

---

### Task 1: 인사이트 KPI 증감 표시 공통화

**Files:**
- Modify: `apps/web/app/(dashboard)/insights/page.tsx:1-126,213-233`
- Modify: `apps/web/messages/ko/insights.json`
- Modify: `apps/web/messages/en/insights.json`
- Test: `apps/web/lib/ui-commonization.test.ts:67-97`

**Interfaces:**
- Consumes: `pctDelta(curr: number, prev: number): StatDelta | null`, `DeltaBadge({ delta }: { delta: StatDelta }): ReactNode`
- Produces: `KpiCard({ label, value, delta, comparison }: { label: string; value: string; delta: StatDelta | null; comparison: string }): ReactNode`, `insights.kpi.previousPeriod: string`

- [ ] **Step 1: 공통 증감 계약의 실패 테스트 작성**

`apps/web/lib/ui-commonization.test.ts`에 다음 테스트를 추가한다.

```ts
test("insight KPI deltas use the shared dashboard badge and calculation", () => {
  const page = source("app/(dashboard)/insights/page.tsx");
  const ko = JSON.parse(source("messages/ko/insights.json"));
  const en = JSON.parse(source("messages/en/insights.json"));

  assert.match(page, /@\/components\/dashboard\/stat-card/);
  assert.match(page, /@\/lib\/stat-delta/);
  assert.match(page, /<DeltaBadge delta=\{delta\}/);
  assert.match(page, /const tokenDelta = pctDelta\(/);
  assert.match(page, /const sessionsDelta = pctDelta\(/);
  assert.match(page, /const costDelta = pctDelta\(/);
  assert.doesNotMatch(page, /const formatComparison/);
  assert.doesNotMatch(page, /signDisplay: "always"/);
  assert.equal(ko.kpi.previousPeriod, "이전 기간 대비");
  assert.equal(en.kpi.previousPeriod, "vs previous period");
});
```

- [ ] **Step 2: 웹 테스트를 실행해 RED 확인**

Run: `pnpm --filter @toard/web test`

Expected: FAIL because the insights page does not import `DeltaBadge` or `pctDelta`, still defines `formatComparison`, and the message catalogs do not contain `kpi.previousPeriod`.

- [ ] **Step 3: 비교 안내 번역 추가**

`apps/web/messages/ko/insights.json`의 `kpi`에 다음 항목을 추가한다.

```json
"previousPeriod": "이전 기간 대비"
```

`apps/web/messages/en/insights.json`의 `kpi`에 다음 항목을 추가한다.

```json
"previousPeriod": "vs previous period"
```

기존 `vsPrevious`와 `noPrevious`는 카탈로그 호환성을 위해 유지한다.

- [ ] **Step 4: KpiCard와 세 KPI를 공통 증감 API로 변경**

`apps/web/app/(dashboard)/insights/page.tsx`에 공통 API를 import한다.

```tsx
import { DeltaBadge, type StatDelta } from "@/components/dashboard/stat-card";
import { pctDelta } from "@/lib/stat-delta";
```

`KpiCard`가 더 이상 `ReactNode`를 받지 않으므로 기존 `import type { ReactNode } from "react";`도 제거한다.

`KpiCard`를 다음 구조로 변경한다.

```tsx
function KpiCard({
  label,
  value,
  delta,
  comparison,
}: {
  label: string;
  value: string;
  delta: StatDelta | null;
  comparison: string;
}) {
  return (
    <Card className="gap-3 py-5">
      <CardHeader className="px-5">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl tabular-nums">{value}</CardTitle>
      </CardHeader>
      <CardContent className="px-5">
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
          {delta ? <DeltaBadge delta={delta} /> : null}
          <span className="text-muted-foreground">{comparison}</span>
        </div>
      </CardContent>
    </Card>
  );
}
```

기존 `formatComparison`을 제거하고, 비교 결과를 읽은 직후 세 증감값을 만든다.

```tsx
const tokenDelta = pctDelta(comparison.current.totalTokens, comparison.previous.totalTokens);
const sessionsDelta = pctDelta(comparison.current.sessions, comparison.previous.sessions);
const costDelta = pctDelta(comparison.current.costUsd, comparison.previous.costUsd);
```

각 KPI에 공통 증감값과 비교 안내 문구를 전달한다. 토큰 KPI의 완성 형태는 다음과 같고 세션·비용도 같은 규칙을 사용한다.

```tsx
<KpiCard
  label={t("kpi.tokens")}
  value={format.number(comparison.current.totalTokens)}
  delta={tokenDelta}
  comparison={comparison.previous.totalTokens === 0 ? t("kpi.noPrevious") : t("kpi.previousPeriod")}
/>
```

- [ ] **Step 5: 웹 테스트와 타입 검사로 GREEN 확인**

Run: `pnpm --filter @toard/web test && pnpm --filter @toard/web typecheck && git diff --check`

Expected: all web tests pass, typecheck exits 0, and diff check prints no errors.

- [ ] **Step 6: 전체 회귀 검증**

Run: `pnpm test && pnpm typecheck && git diff --check`

Expected: every workspace test and typecheck passes with exit code 0.

- [ ] **Step 7: 로컬 화면 검증**

`http://127.0.0.1:3102/insights?period=7`에서 다음을 확인한다.

- 토큰·세션·비용의 증가 값은 빨간 상승 배지, 감소 값은 초록 하락 배지다.
- 각 배지 옆에 `이전 기간 대비`가 표시된다.
- 이전 값이 0인 KPI는 배지 없이 `비교할 이전 기간 데이터가 없습니다.`를 표시한다.
- KPI 값, 카드 크기, 토큰 우선 순서는 변경되지 않는다.

- [ ] **Step 8: 변경 커밋**

```bash
git add 'apps/web/app/(dashboard)/insights/page.tsx' \
  apps/web/messages/ko/insights.json \
  apps/web/messages/en/insights.json \
  apps/web/lib/ui-commonization.test.ts
git commit -m "style(insights): KPI 증감 표시 공통화"
```
