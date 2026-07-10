# Token-First Insights Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 개인 인사이트의 기본 관점을 토큰으로 전환하고 상단 레이아웃을 현재 대시보드 툴바 문법에 맞춘다.

**Architecture:** 저장소 집계와 10분 캐시는 그대로 두고 서버 페이지의 지표 기본값·KPI 순서와 클라이언트 필터의 표현만 변경한다. 기존 `InsightFilters`는 인사이트 전용 기간 의미와 URL 갱신 책임을 유지하며, 페이지는 공통 대시보드처럼 14px 제목·인라인 컨트롤·우측 freshness 정보로 조합한다.

**Tech Stack:** Next.js App Router, React Server Components, TypeScript, next-intl, Tailwind CSS, shadcn UI, Node test runner

## Global Constraints

- 기본 지표는 `tokens`이며 유효한 명시적 `metric=cost`는 보존한다.
- KPI 순서는 토큰, 세션, 비용으로 고정한다.
- 비용을 선택하면 인사이트 후보, 추이, 모델 및 provider 구성은 비용 기준으로 전환한다.
- 제목은 현재 개인 화면과 같은 14px 툴바 제목을 사용한다.
- 시각 필드 라벨을 제거해도 기간, provider, 지표 컨트롤의 `aria-label`은 유지한다.
- 현재·이전 기간 범위와 최대 10분 지연 안내는 유지한다.
- ClickHouse 쿼리, 저장소 계약, 10분 캐시, 최대 90일 제한, 15분 rollup과 raw tail 정책은 변경하지 않는다.
- 다른 대시보드 페이지와 공통 `DashboardFilters`는 변경하지 않는다.

---

## File Map

- Modify: `apps/web/app/(dashboard)/insights/page.tsx`
  - 지표 기본값, 헤더 조합, KPI 순서, 그리드 간격을 담당한다.
- Modify: `apps/web/components/dashboard/insight-filters.tsx`
  - 인사이트 기간·provider·지표 URL 갱신과 인라인 컨트롤 표현을 담당한다.
- Modify: `apps/web/lib/ui-commonization.test.ts`
  - 토큰 기본값, 정보 순서, 공통 헤더 밀도, 접근성 라벨의 정적 계약을 검증한다.
- Verify only: `apps/web/messages/ko/insights.json`, `apps/web/messages/en/insights.json`
  - 기존 라벨과 freshness 번역을 재사용하며 카탈로그 형태가 계속 일치하는지 기존 테스트로 확인한다.

### Task 1: 토큰 중심 기본값과 정보 순서

**Files:**
- Modify: `apps/web/lib/ui-commonization.test.ts:56-108`
- Modify: `apps/web/app/(dashboard)/insights/page.tsx:66-75,191-225`
- Modify: `apps/web/components/dashboard/insight-filters.tsx:29-37`

**Interfaces:**
- Consumes: `generateInsightCandidates(comparison, metric)`, `InsightComparisonChart`의 `metric`, `InsightComposition`의 `metric`.
- Produces: `metric: "cost" | "tokens"`에서 기본 `tokens`, 명시적 `cost` 보존, KPI와 지표 선택의 토큰 우선 순서.

- [ ] **Step 1: 토큰 기본값과 순서에 대한 실패 테스트를 작성한다**

`apps/web/lib/ui-commonization.test.ts`에 다음 테스트를 추가한다.

```ts
test("insights default to tokens while preserving explicit cost selection", () => {
  const page = source("app/(dashboard)/insights/page.tsx");
  assert.match(page, /const metric = sp\.metric === "cost" \? "cost" : "tokens"/);
  assert.match(page, /generateInsightCandidates\(comparison, metric\)/);
  assert.match(page, /<InsightComparisonChart data=\{comparison\.trend\} metric=\{metric\}/);
  assert.match(page, /<InsightComposition[\s\S]*metric=\{metric\}/);
});

test("insights keep token-first KPI and metric-control order", () => {
  const page = source("app/(dashboard)/insights/page.tsx");
  const filters = source("components/dashboard/insight-filters.tsx");
  const tokenKpi = page.indexOf('label={t("kpi.tokens")}');
  const sessionKpi = page.indexOf('label={t("kpi.sessions")}');
  const costKpi = page.indexOf('label={t("kpi.cost")}');
  const tokenMetric = filters.indexOf('{ value: "tokens", label: t("filters.tokens") }');
  const costMetric = filters.indexOf('{ value: "cost", label: t("filters.cost") }');

  assert.notEqual(tokenKpi, -1);
  assert.notEqual(sessionKpi, -1);
  assert.notEqual(costKpi, -1);
  assert.equal(tokenKpi < sessionKpi && sessionKpi < costKpi, true);
  assert.notEqual(tokenMetric, -1);
  assert.notEqual(costMetric, -1);
  assert.equal(tokenMetric < costMetric, true);
});
```

- [ ] **Step 2: 집중 테스트를 실행해 실패를 확인한다**

Run:

```bash
pnpm --filter @toard/web exec node --import tsx --test lib/ui-commonization.test.ts
```

Expected: 새 기본값 정규식 또는 토큰 우선 순서 assertion이 실패한다.

- [ ] **Step 3: 페이지 기본값과 KPI 순서를 최소 변경한다**

`apps/web/app/(dashboard)/insights/page.tsx`의 기본값을 명시적 비용만 비용으로 해석하도록 바꾼다.

```ts
const metric = sp.metric === "cost" ? "cost" : "tokens";
```

KPI 섹션을 다음 순서로 배치하고 그리드 간격을 공통 밀도에 맞춘다.

```tsx
<section className="grid gap-4 sm:grid-cols-3" aria-label={t("comparison.current")}>
  <KpiCard
    label={t("kpi.tokens")}
    value={format.number(comparison.current.totalTokens)}
    comparison={formatComparison(comparison.current.totalTokens, comparison.previous.totalTokens)}
  />
  <KpiCard
    label={t("kpi.sessions")}
    value={format.number(comparison.current.sessions)}
    comparison={formatComparison(comparison.current.sessions, comparison.previous.sessions)}
  />
  <KpiCard
    label={t("kpi.cost")}
    value={format.number(comparison.current.costUsd, {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    })}
    comparison={formatComparison(comparison.current.costUsd, comparison.previous.costUsd)}
  />
</section>
```

핵심 변화 카드 그리드도 `className="grid gap-4 lg:grid-cols-3"`로 맞춘다. 카드 내부 `gap-3`은 유지한다.

- [ ] **Step 4: 지표 선택 순서를 토큰 우선으로 변경한다**

`apps/web/components/dashboard/insight-filters.tsx`의 `metrics`를 다음 순서로 변경한다.

```ts
const metrics: SegmentedControlItem<"cost" | "tokens">[] = [
  { value: "tokens", label: t("filters.tokens") },
  { value: "cost", label: t("filters.cost") },
];
```

- [ ] **Step 5: 집중 테스트와 타입 검사를 실행한다**

Run:

```bash
pnpm --filter @toard/web exec node --import tsx --test lib/ui-commonization.test.ts
pnpm --filter @toard/web typecheck
```

Expected: `ui-commonization.test.ts` 전체 PASS, typecheck exit 0.

- [ ] **Step 6: 토큰 중심 변경을 커밋한다**

```bash
git add apps/web/lib/ui-commonization.test.ts \
  'apps/web/app/(dashboard)/insights/page.tsx' \
  apps/web/components/dashboard/insight-filters.tsx
git commit -m "feat(insights): 토큰 중심 정보 계층 적용"
```

### Task 2: 현재 대시보드 문법에 맞춘 상단 툴바

**Files:**
- Modify: `apps/web/lib/ui-commonization.test.ts:103-108`
- Modify: `apps/web/components/dashboard/insight-filters.tsx:39-78`
- Modify: `apps/web/app/(dashboard)/insights/page.tsx:122-162`

**Interfaces:**
- Consumes: `InsightFiltersProps`, 기존 `update(key, value)` URL 갱신 함수, `freshness.*`와 `ranges.*` 번역 키.
- Produces: 시각 라벨 없는 인라인 `InsightFilters`, 14px `h1`, 우측 freshness, 기존 현재·이전 범위 영역.

- [ ] **Step 1: 레이아웃과 접근성 계약의 실패 테스트를 작성한다**

`apps/web/lib/ui-commonization.test.ts`의 기존 인사이트 필터 테스트 아래에 다음 테스트를 추가한다.

```ts
test("insights use the compact dashboard toolbar while preserving accessible labels", () => {
  const page = source("app/(dashboard)/insights/page.tsx");
  const filters = source("components/dashboard/insight-filters.tsx");

  assert.match(page, /<h1 className="[^\"]*text-sm font-medium[^\"]*">\{t\("title"\)\}<\/h1>/);
  assert.doesNotMatch(page, /<h1 className="text-2xl/);
  assert.match(page, /flex flex-wrap items-center gap-2[\s\S]*<InsightFilters/);
  assert.match(page, /sm:ml-auto[\s\S]*t\("freshness\.dataThrough"/);
  assert.match(filters, /<div className="flex flex-wrap items-center gap-2">/);
  assert.doesNotMatch(filters, /className="text-muted-foreground text-xs">\{t\("presets\.label"\)\}/);
  assert.doesNotMatch(filters, /className="text-muted-foreground text-xs">\{t\("filters\.providerLabel"\)\}/);
  assert.doesNotMatch(filters, /className="text-muted-foreground text-xs">\{t\("filters\.metricLabel"\)\}/);
  assert.match(filters, /aria-label=\{t\("presets\.label"\)\}/);
  assert.match(filters, /aria-label=\{t\("filters\.providerLabel"\)\}/);
  assert.match(filters, /aria-label=\{t\("filters\.metricLabel"\)\}/);
});
```

- [ ] **Step 2: 집중 테스트를 실행해 실패를 확인한다**

Run:

```bash
pnpm --filter @toard/web exec node --import tsx --test lib/ui-commonization.test.ts
```

Expected: 24px 제목, 세로 라벨 래퍼, 기존 `items-end gap-3` 때문에 새 테스트가 실패한다.

- [ ] **Step 3: `InsightFilters`를 인라인 컨트롤로 압축한다**

반환 JSX를 다음 구조로 변경한다. URL 갱신 함수와 모든 `aria-label`은 유지한다.

```tsx
return (
  <div className="flex flex-wrap items-center gap-2">
    <SegmentedControl
      value={preset}
      items={presets}
      onValueChange={(value) => update("period", value)}
      aria-label={t("presets.label")}
    />

    <Select value={provider} onValueChange={(value) => update("provider", value)}>
      <SelectTrigger
        className="h-8 w-fit min-w-0 max-w-44 justify-start gap-1.5 px-2.5"
        aria-label={t("filters.providerLabel")}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="max-w-[min(24rem,var(--radix-select-content-available-width))]">
        <SelectItem value="all">{t("filters.allProviders")}</SelectItem>
        {providers.map((option) => (
          <SelectItem key={option.key} value={option.key} title={option.label}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>

    <SegmentedControl
      value={metric}
      items={metrics}
      onValueChange={(value) => update("metric", value)}
      aria-label={t("filters.metricLabel")}
    />
  </div>
);
```

- [ ] **Step 4: 페이지 헤더를 공통 대시보드 툴바 문법으로 변경한다**

`apps/web/app/(dashboard)/insights/page.tsx`의 `header`를 다음 구조로 변경한다.

```tsx
<header className="space-y-2">
  <div className="flex flex-wrap items-center gap-2">
    <h1 className="mr-2 text-sm font-medium">{t("title")}</h1>
    <InsightFilters
      preset={preset}
      metric={metric}
      provider={providerKey ?? "all"}
      providers={providers}
    />
    <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs sm:ml-auto sm:justify-end">
      <span className="flex items-center gap-1.5">
        <Clock3 className="size-3.5" />
        {t("freshness.dataThrough", {
          time: format.dateTime(pair.current.to, {
            dateStyle: "medium",
            timeStyle: "short",
            timeZone: timezone,
          }),
        })}
      </span>
      <span>{t("freshness.delay")}</span>
    </div>
  </div>
  <div className="bg-muted/30 text-muted-foreground grid gap-1 rounded-lg px-3 py-2 text-xs sm:grid-cols-2 sm:gap-4">
    <p>
      {t("ranges.current", {
        range: formatInsightPeriodRange(pair.current, locale, timezone),
      })}
    </p>
    <p>
      {t("ranges.previous", {
        range: formatInsightPeriodRange(pair.previous, locale, timezone),
      })}
    </p>
  </div>
</header>
```

기존 24px 제목 설명 문단은 제거한다. 번역 카탈로그의 `description` 키는 다른 호환성을 위해 이번 작업에서 삭제하지 않는다.

- [ ] **Step 5: 집중 테스트, 전체 웹 테스트, 타입 검사를 실행한다**

Run:

```bash
pnpm --filter @toard/web exec node --import tsx --test lib/ui-commonization.test.ts
pnpm --filter @toard/web test
pnpm --filter @toard/web typecheck
git diff --check
```

Expected: 집중 테스트 및 웹 전체 테스트 PASS, typecheck와 diff check exit 0.

- [ ] **Step 6: 레이아웃 정렬을 커밋한다**

```bash
git add apps/web/lib/ui-commonization.test.ts \
  'apps/web/app/(dashboard)/insights/page.tsx' \
  apps/web/components/dashboard/insight-filters.tsx
git commit -m "style(insights): 대시보드 툴바 문법으로 정렬"
```

### Task 3: 부하 회귀 및 실제 화면 검증

**Files:**
- Verify only: `apps/web/lib/user-insights.ts`
- Verify only: `apps/web/app/(dashboard)/insights/page.tsx`
- Verify only: `apps/web/components/dashboard/insight-filters.tsx`

**Interfaces:**
- Consumes: 완성된 `/insights` 페이지와 기존 로컬 개발 서버.
- Produces: 토큰 기본 화면, 비용 명시 화면, 모바일 줄바꿈, 무부하 회귀에 대한 검증 증거.

- [ ] **Step 1: 변경 파일이 UI 경계 안에 있는지 확인한다**

Run:

```bash
git diff 2c75b65..HEAD --name-only
```

Expected: 설계 문서와 계획 문서를 제외한 구현 파일은 `apps/web/app/(dashboard)/insights/page.tsx`, `apps/web/components/dashboard/insight-filters.tsx`, `apps/web/lib/ui-commonization.test.ts`뿐이다. storage, core, ClickHouse, cache 파일은 없다.

- [ ] **Step 2: 토큰 기본값과 비용 공유 URL을 HTTP 렌더 결과로 확인한다**

로컬 서버가 `http://127.0.0.1:3102`에서 실행 중인 상태에서 다음을 실행한다.

```bash
curl -fsS 'http://127.0.0.1:3102/insights?period=7' | rg 'metric.{0,8}tokens'
curl -fsS 'http://127.0.0.1:3102/insights?period=7&metric=cost' | rg 'metric.{0,8}cost'
```

Expected: 첫 응답은 차트 또는 구성 컴포넌트의 `metric`을 `tokens`로, 두 번째 응답은 `cost`로 직렬화한다.

- [ ] **Step 3: 실제 브라우저 데스크톱 화면을 비교한다**

브라우저에서 `/`, `/history`, `/settings`, `/insights?period=7`을 차례로 확인한다.

Expected:

- 인사이트 `h1` 계산 글꼴 크기가 다른 세 화면과 같은 14px이다.
- 기간, provider, 토큰/비용 컨트롤이 데스크톱에서 제목과 같은 툴바 흐름에 있다.
- 토큰이 선택되고 KPI가 토큰, 세션, 비용 순서다.
- current/previous 범위와 10분 지연 안내가 보인다.

- [ ] **Step 4: 모바일 줄바꿈과 접근 가능한 이름을 확인한다**

브라우저 viewport를 390×844로 설정해 `/insights?period=7`을 확인한 뒤 viewport override를 해제한다.

Expected:

- 제목, 필터, freshness 정보가 가로로 잘리지 않고 자연스럽게 줄바꿈된다.
- 현재·이전 범위는 한 열로 쌓인다.
- 기간, provider, 지표 컨트롤의 accessible name이 각각 번역된 라벨로 남아 있다.

- [ ] **Step 5: 최종 회귀 검증을 실행한다**

Run:

```bash
pnpm --filter @toard/web test
pnpm --filter @toard/web typecheck
pnpm --filter @toard/core test
git diff --check
git status --short
```

Expected: 모든 테스트 PASS, typecheck와 diff check exit 0, 의도하지 않은 미커밋 파일 없음.
