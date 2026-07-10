# Insight Comparison Date Axis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 인사이트 비교 그래프의 숫자 경과 위치를 현재 기간의 실제 날짜로 바꾸고, 툴팁에 현재·이전 기간의 대응 날짜를 함께 표시한다.

**Architecture:** 저장소가 반환하는 0 기반 `position`은 그대로 유지한다. web 계층의 순수 날짜 헬퍼가 기간 시작 시각을 뷰어 timezone의 캘린더 날짜로 바꾼 뒤 position만큼 달력 일수를 더하고, 차트가 locale에 맞게 표시한다.

**Tech Stack:** TypeScript, React, Next.js, next-intl, Recharts, Node test runner

## Global Constraints

- PostgreSQL·ClickHouse 집계 쿼리와 `InsightTrendPoint` 계약은 변경하지 않는다.
- 날짜 계산은 24시간 밀리초 가산이 아니라 timezone 기준 캘린더 일수 가산을 사용한다.
- x축은 현재 기간 날짜만 표시하고 툴팁은 현재·이전 기간 날짜를 함께 표시한다.
- 기존 10분 캐시와 서버 부하 특성은 그대로 유지한다.

---

### Task 1: 경과 위치를 캘린더 날짜로 변환

**Files:**
- Create: `apps/web/lib/insight-chart-date.ts`
- Create: `apps/web/lib/insight-chart-date.test.ts`

**Interfaces:**
- Consumes: 기간 시작 `Date`, 0 기반 `position`, IANA timezone 문자열
- Produces: `getInsightPositionDate(periodStart: Date, position: number, timezone: string): Date`

- [ ] **Step 1: 최근 7일과 DST 경계의 실패 테스트 작성**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { getInsightPositionDate } from "./insight-chart-date";

test("최근 7일의 position 0부터 7까지 실제 캘린더 날짜로 변환한다", () => {
  const from = new Date("2026-07-03T05:30:00.000Z");
  assert.equal(getInsightPositionDate(from, 0, "Asia/Seoul").toISOString(), "2026-07-03T12:00:00.000Z");
  assert.equal(getInsightPositionDate(from, 7, "Asia/Seoul").toISOString(), "2026-07-10T12:00:00.000Z");
});

test("DST 전환에도 24시간이 아닌 캘린더 일수를 더한다", () => {
  const from = new Date("2026-03-07T20:00:00.000Z");
  assert.equal(
    getInsightPositionDate(from, 2, "America/Los_Angeles").toISOString(),
    "2026-03-09T12:00:00.000Z",
  );
});
```

- [ ] **Step 2: 테스트를 실행해 RED 확인**

Run: `pnpm --filter @toard/web test`

Expected: FAIL with `Cannot find module './insight-chart-date'`.

- [ ] **Step 3: timezone 캘린더 날짜 변환 최소 구현**

```ts
function calendarParts(at: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(at);
  const value = (type: "year" | "month" | "day") =>
    Number(parts.find((part) => part.type === type)?.value);
  return { year: value("year"), month: value("month"), day: value("day") };
}

export function getInsightPositionDate(periodStart: Date, position: number, timezone: string): Date {
  const { year, month, day } = calendarParts(periodStart, timezone);
  return new Date(Date.UTC(year, month - 1, day + position, 12));
}
```

- [ ] **Step 4: web 테스트로 GREEN 확인**

Run: `pnpm --filter @toard/web test`

Expected: 68 tests pass, 0 fail.

- [ ] **Step 5: 날짜 헬퍼 커밋**

```bash
git add apps/web/lib/insight-chart-date.ts apps/web/lib/insight-chart-date.test.ts
git commit -m "feat(insights): 비교 위치 날짜 변환 추가"
```

### Task 2: 차트 축과 툴팁에 날짜 연결

**Files:**
- Modify: `apps/web/components/charts/insight-comparison-chart.tsx:25-113`
- Modify: `apps/web/app/(dashboard)/insights/page.tsx:228-232`
- Modify: `apps/web/messages/ko/insights.json:41-49`
- Modify: `apps/web/messages/en/insights.json:41-49`
- Modify: `apps/web/lib/ui-commonization.test.ts:153-193`

**Interfaces:**
- Consumes: Task 1의 `getInsightPositionDate`, `pair.current.from`, `pair.previous.from`, `pair.timezone`
- Produces: `InsightComparisonChart` props `currentFrom: string`, `previousFrom: string`, `timezone: string`

- [ ] **Step 1: 날짜 축·툴팁 계약의 실패 테스트 작성**

`apps/web/lib/ui-commonization.test.ts`에 다음 검증을 추가한다.

```ts
test("insight comparison chart labels positions with current and previous dates", () => {
  const chart = source("components/charts/insight-comparison-chart.tsx");
  const page = source("app/(dashboard)/insights/page.tsx");
  assert.match(chart, /getInsightPositionDate/);
  assert.match(chart, /tickFormatter=.*formatPositionDate/s);
  assert.match(chart, /labelFormatter=.*chart\.dateComparison/s);
  assert.match(page, /currentFrom=\{pair\.current\.from\.toISOString\(\)\}/);
  assert.match(page, /previousFrom=\{pair\.previous\.from\.toISOString\(\)\}/);
  assert.match(page, /timezone=\{pair\.timezone\}/);
});
```

한국어·영어 번역 카탈로그 형태 테스트가 `chart.dateComparison` 추가를 요구하도록 두 JSON 파일에 같은 키가 없어서 실패하는 상태도 확인한다.

- [ ] **Step 2: 테스트를 실행해 RED 확인**

Run: `pnpm --filter @toard/web test`

Expected: FAIL because the chart has no date formatter or period-start props.

- [ ] **Step 3: 차트 props와 날짜 formatter 최소 구현**

`InsightComparisonChart`에 ISO 기간 시작 문자열과 timezone을 받고 다음 formatter를 추가한다.

```tsx
const currentStart = new Date(currentFrom);
const previousStart = new Date(previousFrom);
const formatDate = (date: Date) =>
  format.dateTime(date, { month: "numeric", day: "numeric", timeZone: "UTC" });
const formatPositionDate = (start: Date, displayPosition: number) =>
  formatDate(getInsightPositionDate(start, displayPosition - 1, timezone));
```

숫자 x축 정렬은 유지하되 라벨과 툴팁만 바꾼다.

```tsx
<XAxis
  dataKey="position"
  type="number"
  domain={["dataMin", "dataMax"]}
  allowDecimals={false}
  tickFormatter={(position: number) => formatPositionDate(currentStart, position)}
  // 기존 시각 속성 유지
/>
<Tooltip
  contentStyle={tooltipStyle}
  labelFormatter={(position: number) =>
    t("chart.dateComparison", {
      current: formatPositionDate(currentStart, position),
      previous: formatPositionDate(previousStart, position),
    })
  }
  // 기존 값 formatter 유지
/>
```

페이지 호출부는 서버에서 ISO 문자열만 전달한다.

```tsx
<InsightComparisonChart
  data={comparison.trend}
  metric={metric}
  currentFrom={pair.current.from.toISOString()}
  previousFrom={pair.previous.from.toISOString()}
  timezone={pair.timezone}
/>
```

번역 키는 기존 `chart.position`을 대체한다.

```json
// ko
"dateComparison": "현재 {current} · 이전 {previous}"

// en
"dateComparison": "Current {current} · Previous {previous}"
```

- [ ] **Step 4: 전체 관련 자동 검증으로 GREEN 확인**

Run: `pnpm --filter @toard/web test && pnpm --filter @toard/core test && pnpm --filter @toard/web typecheck`

Expected: web 69 tests pass, core 18 tests pass, typecheck exits 0.

- [ ] **Step 5: 실제 브라우저에서 표시 검증**

`http://127.0.0.1:3102/insights?period=7`에서 다음을 확인한다.

- x축에 경과 숫자가 아닌 locale 날짜가 표시된다.
- 툴팁에 현재·이전 날짜와 두 사용량이 함께 표시된다.
- 390px viewport에서 가로 스크롤이 생기지 않는다.
- 토큰·비용 전환 후에도 날짜 라벨이 유지된다.

- [ ] **Step 6: 차트 날짜 표시 커밋**

```bash
git add apps/web/components/charts/insight-comparison-chart.tsx \
  'apps/web/app/(dashboard)/insights/page.tsx' \
  apps/web/messages/ko/insights.json \
  apps/web/messages/en/insights.json \
  apps/web/lib/ui-commonization.test.ts
git commit -m "feat(insights): 비교 그래프 축을 날짜로 표시"
```
