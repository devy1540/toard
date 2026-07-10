# Insight Comparison Gradient Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 인사이트 비교 그래프의 현재 기간에만 옅은 면 그라데이션을 추가해 기존 대시보드와 시각적 통일감을 높인다.

**Architecture:** 기존 추이 데이터와 포맷 로직은 유지하고 Recharts 컨테이너만 `LineChart`에서 `ComposedChart`로 바꾼다. 현재 기간은 선과 면을 함께 그리는 `Area`, 이전 기간은 기존 회색 점선 `Line`으로 렌더링하며 고유 SVG gradient ID를 사용한다.

**Tech Stack:** React 19, TypeScript, Recharts 2.15, Tailwind CSS, Node test runner

## Global Constraints

- 현재 기간에만 `var(--color-chart-1)` 세로 그라데이션을 적용한다.
- 그라데이션 불투명도는 상단 `0.32`, 하단 `0.04`다.
- 이전 기간은 `var(--color-muted-foreground)`의 `4 4` 점선이며 면 채움이 없다.
- 현재와 이전 시리즈 모두 애니메이션을 비활성화한다.
- tooltip, 숫자 포맷, 숫자형 X축, 접근 가능한 이름과 설명 연결을 유지한다.
- 비용과 토큰 지표가 같은 렌더링 구조를 사용한다.
- 저장소, 캐시, rollup, 메시지 카탈로그와 다른 차트 파일은 변경하지 않는다.

---

## File Map

- Modify: `apps/web/components/charts/insight-comparison-chart.tsx`
  - 현재 `Area`, 이전 `Line`, 고유 그라데이션과 기존 축·tooltip·접근성 속성을 렌더링한다.
- Modify: `apps/web/lib/ui-commonization.test.ts`
  - 현재 면 채움, 이전 점선, 투명도, 애니메이션, 숫자형 축과 접근성 계약을 검증한다.

### Task 1: 현재 기간 전용 그라데이션 비교 차트

**Files:**
- Modify: `apps/web/lib/ui-commonization.test.ts:153-172`
- Modify: `apps/web/components/charts/insight-comparison-chart.tsx:3-96`

**Interfaces:**
- Consumes: `InsightTrendPoint[]`, `metric: "cost" | "tokens"`, 기존 `insights.chart.*` 번역 키.
- Produces: `ComposedChart` 안의 `Area[dataKey="current"]`와 `Line[dataKey="previous"]`.

- [ ] **Step 1: 승인된 시각 계약의 실패 테스트를 작성한다**

`apps/web/lib/ui-commonization.test.ts`의 기존 비교 차트 테스트를 다음처럼 보강한다.

```ts
test("insight comparison chart fills only the current period with the approved gradient", () => {
  const chart = source("components/charts/insight-comparison-chart.tsx");

  assert.match(chart, /ComposedChart/);
  assert.match(chart, /<linearGradient id=\{gradientId\}[\s\S]*stopOpacity=\{0\.32\}[\s\S]*stopOpacity=\{0\.04\}/);
  assert.match(
    chart,
    /<Area[^>]*dataKey="current"[^>]*stroke="var\(--color-chart-1\)"[^>]*fill=\{`url\(#\$\{gradientId\}\)`\}[^>]*isAnimationActive=\{false\}/s,
  );
  assert.doesNotMatch(chart, /<Area[^>]*dataKey="previous"/s);
  assert.match(
    chart,
    /<Line[^>]*dataKey="previous"[^>]*stroke="var\(--color-muted-foreground\)"[^>]*strokeDasharray="4 4"[^>]*isAnimationActive=\{false\}/s,
  );
});
```

기존 접근성 테스트의 `<LineChart` 기대값을 `<ComposedChart`로 바꾼다.

```ts
assert.match(
  chart,
  /<ComposedChart[\s\S]*aria-label=\{t\("chart\.accessibleLabel"\)\}[\s\S]*aria-describedby=\{descriptionId\}/,
);
```

- [ ] **Step 2: 집중 테스트를 실행해 실패를 확인한다**

Run:

```bash
pnpm --filter @toard/web exec node --import tsx --test lib/ui-commonization.test.ts
```

Expected: `ComposedChart`, `linearGradient`, `Area` 계약이 현재 소스에 없어 새 테스트가 실패한다.

- [ ] **Step 3: 차트를 `ComposedChart`와 현재 기간 `Area`로 변경한다**

import를 다음과 같이 변경한다.

```ts
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
```

기존 `descriptionId`에서 고유 그라데이션 ID를 파생한다.

```ts
const descriptionId = useId();
const gradientId = `${descriptionId.replace(/:/g, "")}-current-fill`;
```

`ResponsiveContainer` 내부를 다음 전체 구조로 바꾼다.

```tsx
<ComposedChart
  data={chartData}
  margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
  accessibilityLayer
  aria-label={t("chart.accessibleLabel")}
  aria-describedby={descriptionId}
>
  <defs>
    <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
      <stop offset="5%" stopColor="var(--color-chart-1)" stopOpacity={0.32} />
      <stop offset="95%" stopColor="var(--color-chart-1)" stopOpacity={0.04} />
    </linearGradient>
  </defs>

  <CartesianGrid vertical={false} stroke="var(--color-border)" />
  <XAxis
    dataKey="position"
    type="number"
    domain={["dataMin", "dataMax"]}
    allowDecimals={false}
    tickLine={false}
    axisLine={false}
    tickMargin={8}
    minTickGap={20}
    fontSize={12}
    stroke="var(--color-muted-foreground)"
  />
  <YAxis
    tickLine={false}
    axisLine={false}
    width={56}
    fontSize={12}
    stroke="var(--color-muted-foreground)"
    tickFormatter={formatValue}
  />
  <Tooltip
    contentStyle={tooltipStyle}
    labelFormatter={(position: number) => t("chart.position", { position: format.number(position) })}
    formatter={(value: number, name: string) => [
      formatValue(value),
      name === "current" ? t("chart.current") : t("chart.previous"),
    ]}
  />
  <Area
    type="monotone"
    dataKey="current"
    stroke="var(--color-chart-1)"
    strokeWidth={2}
    fill={`url(#${gradientId})`}
    dot={false}
    isAnimationActive={false}
  />
  <Line
    type="monotone"
    dataKey="previous"
    stroke="var(--color-muted-foreground)"
    strokeDasharray="4 4"
    dot={false}
    isAnimationActive={false}
  />
</ComposedChart>
```

- [ ] **Step 4: 집중 테스트, 전체 웹 테스트와 타입 검사를 실행한다**

Run:

```bash
pnpm --filter @toard/web exec node --import tsx --test lib/ui-commonization.test.ts
pnpm --filter @toard/web test
pnpm --filter @toard/web typecheck
git diff --check
```

Expected: 집중 테스트와 웹 전체 테스트 PASS, typecheck와 diff check exit 0.

- [ ] **Step 5: 그라데이션 구현을 커밋한다**

```bash
git add apps/web/components/charts/insight-comparison-chart.tsx apps/web/lib/ui-commonization.test.ts
git commit -m "style(insights): 현재 기간 그래프에 그라데이션 적용"
```

### Task 2: 실제 화면과 회귀 검증

**Files:**
- Verify only: `apps/web/components/charts/insight-comparison-chart.tsx`
- Verify only: `apps/web/app/(dashboard)/insights/page.tsx`

**Interfaces:**
- Consumes: 로컬 서버의 토큰·비용 인사이트 화면.
- Produces: 라이트·다크·모바일과 무부하 회귀에 대한 검증 증거.

- [ ] **Step 1: 변경 범위가 UI 파일 두 개뿐인지 확인한다**

```bash
git diff 2347831..HEAD --name-only
```

Expected: 계획 문서를 제외한 구현 파일은 `apps/web/components/charts/insight-comparison-chart.tsx`, `apps/web/lib/ui-commonization.test.ts`뿐이다.

- [ ] **Step 2: 로컬 서버와 데이터 응답을 확인한다**

```bash
curl -fsS http://127.0.0.1:3102/api/health
curl -fsS http://127.0.0.1:3102/api/ready
curl -fsS 'http://127.0.0.1:3102/insights?period=7' | rg 'metric.{0,8}tokens'
curl -fsS 'http://127.0.0.1:3102/insights?period=7&metric=cost' | rg 'metric.{0,8}cost'
```

Expected: health와 ready는 200 응답이며 토큰·비용 페이지는 각각 선택 지표를 직렬화한다.

- [ ] **Step 3: 실제 브라우저에서 토큰·비용과 라이트·다크를 확인한다**

`/insights?period=7`과 `/insights?period=7&metric=cost`를 각각 열고 라이트·다크 테마에서 확인한다.

Expected:

- 현재 기간 아래에만 브랜드 색상의 옅은 면이 보인다.
- 이전 기간 회색 점선과 교차 구간이 구분된다.
- tooltip에서 현재·이전 값이 모두 보인다.

- [ ] **Step 4: 모바일 viewport를 확인한다**

viewport를 390×844로 설정해 `/insights?period=7`을 확인한 뒤 override를 해제한다.

Expected: 그래프와 카드에 가로 오버플로가 없고 현재 면과 이전 점선이 보인다.

- [ ] **Step 5: 최종 회귀를 실행한다**

```bash
pnpm --filter @toard/web test
pnpm --filter @toard/web typecheck
pnpm --filter @toard/core test
git diff --check
git status --short
```

Expected: 웹·core 테스트 PASS, 웹 typecheck와 diff check exit 0, 의도하지 않은 미커밋 파일 없음.
