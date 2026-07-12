# Insights Filter Toolbar Commonization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 인사이트의 전용 필터 동작은 유지하면서 다른 대시보드 화면과 같은 툴바·버튼 스타일을 사용하고, 메뉴와 본문에 베타 배지를 표시한다.

**Architecture:** `DashboardFilters`에 결합된 제목·필터·trailing 배치만 `DashboardToolbar`로 분리한다. 기존 `DashboardFilters`와 인사이트 페이지가 이 공통 셸을 사용하고, 인사이트의 기간·프로바이더·지표 URL 로직은 `InsightFilters`에 그대로 둔다.

**Tech Stack:** TypeScript, React, Next.js, next-intl, Tailwind CSS, Node test runner

## Global Constraints

- 인사이트 기간 계산, 10분 캐시, PostgreSQL·ClickHouse 쿼리를 변경하지 않는다.
- 기존 `DashboardFilters` 소비 화면의 기능·URL 규약·시각 배치를 변경하지 않는다.
- 인사이트 비교 기간은 `최근 7일`, `이번 주`, `이번 달`을 유지한다.
- 필터 버튼은 32px `Button size="sm"`, 선택 `default`, 미선택 `outline`을 사용한다.
- 사이드바와 본문은 기존 `beta` 상태 배지와 `nav.badge.beta` 번역을 재사용한다.

---

### Task 1: 공통 DashboardToolbar 셸 추출

**Files:**
- Create: `apps/web/components/dashboard/dashboard-toolbar.tsx`
- Modify: `apps/web/components/dashboard/dashboard-filters.tsx:11-270`
- Test: `apps/web/lib/ui-commonization.test.ts`

**Interfaces:**
- Consumes: `title?: string`, `statusBadge?: { status: FeatureStatus; label: string }`, `leading?: ReactNode`, `filters: ReactNode`, `trailing?: ReactNode`, `splitHeader?: boolean`
- Produces: `DashboardToolbar(props): ReactNode`

- [ ] **Step 1: 공통 셸 추출 계약의 실패 테스트 작성**

`apps/web/lib/ui-commonization.test.ts`에 추가한다.

```ts
test("dashboard filters delegate their visual shell to the shared toolbar", () => {
  const toolbar = source("components/dashboard/dashboard-toolbar.tsx");
  const filters = source("components/dashboard/dashboard-filters.tsx");

  assert.match(toolbar, /function DashboardToolbar/);
  assert.match(toolbar, /FeatureStatusBadge/);
  assert.match(toolbar, /splitHeader[\s\S]*filters/);
  assert.match(filters, /<DashboardToolbar[\s\S]*filters=\{filterControls\}/);
  assert.match(filters, /showCustom[\s\S]*<Input/);
});
```

- [ ] **Step 2: web 테스트를 실행해 RED 확인**

Run: `pnpm --filter @toard/web test`

Expected: FAIL because `components/dashboard/dashboard-toolbar.tsx` does not exist.

- [ ] **Step 3: 레이아웃 전용 DashboardToolbar 구현**

`apps/web/components/dashboard/dashboard-toolbar.tsx`를 생성한다.

```tsx
import type { ReactNode } from "react";
import { FeatureStatusBadge, type FeatureStatus } from "./feature-status-badge";

type DashboardToolbarProps = {
  title?: string;
  statusBadge?: { status: FeatureStatus; label: string };
  leading?: ReactNode;
  filters: ReactNode;
  trailing?: ReactNode;
  splitHeader?: boolean;
};

export function DashboardToolbar({
  title,
  statusBadge,
  leading,
  filters,
  trailing,
  splitHeader = false,
}: DashboardToolbarProps) {
  const titleNode = title ? (
    <div className="mr-2 flex shrink-0 items-center gap-2">
      <h1 className="text-sm font-medium">{title}</h1>
      {statusBadge ? <FeatureStatusBadge status={statusBadge.status}>{statusBadge.label}</FeatureStatusBadge> : null}
    </div>
  ) : null;
  const trailingNode = trailing ? <div className="ml-auto flex flex-wrap items-center gap-2">{trailing}</div> : null;

  if (splitHeader) {
    return (
      <>
        <div className="flex flex-wrap items-center gap-2">
          {titleNode}
          {leading}
          {trailingNode}
        </div>
        <div className="flex flex-wrap items-center gap-2">{filters}</div>
      </>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {titleNode}
      {leading}
      {filters}
      {trailingNode}
    </div>
  );
}
```

- [ ] **Step 4: DashboardFilters가 공통 셸을 사용하도록 변경**

기존 `titleNode`와 `splitHeader` 분기 마크업을 제거하고, 직접 선택 입력을 감싸는 바깥 구조는 유지한다.

```tsx
return (
  <div className="flex flex-col gap-2">
    <DashboardToolbar
      title={title}
      statusBadge={statusBadge}
      leading={leading}
      filters={filterControls}
      trailing={trailing}
      splitHeader={splitHeader}
    />
    {showCustom && (
      <div className="flex flex-wrap items-center gap-1">
        <Input
          type="date"
          value={from}
          max={to || undefined}
          onChange={(event) => setFrom(event.target.value)}
          className="h-8 w-auto"
          aria-label={t("filters.startDate")}
        />
        <span className="text-muted-foreground text-sm">~</span>
        <Input
          type="date"
          value={to}
          min={from || undefined}
          onChange={(event) => setTo(event.target.value)}
          className="h-8 w-auto"
          aria-label={t("filters.endDate")}
        />
        <Button size="sm" onClick={applyCustom} disabled={!from || !to}>
          {t("filters.apply")}
        </Button>
      </div>
    )}
  </div>
);
```

- [ ] **Step 5: web 테스트·typecheck로 GREEN 확인**

Run: `pnpm --filter @toard/web test && pnpm --filter @toard/web typecheck && git diff --check`

Expected: all web tests pass, typecheck and diff check exit 0.

- [ ] **Step 6: 공통 셸 추출 커밋**

```bash
git add apps/web/components/dashboard/dashboard-toolbar.tsx \
  apps/web/components/dashboard/dashboard-filters.tsx \
  apps/web/lib/ui-commonization.test.ts
git commit -m "refactor(dashboard): 필터 툴바 셸 공통화"
```

### Task 2: 인사이트 필터 스타일과 베타 상태 연결

**Files:**
- Modify: `apps/web/components/dashboard/insight-filters.tsx:1-73`
- Modify: `apps/web/app/(dashboard)/insights/page.tsx:1-160`
- Modify: `apps/web/components/dashboard/sidebar-nav.tsx:35-43`
- Test: `apps/web/lib/ui-commonization.test.ts:51-157`

**Interfaces:**
- Consumes: Task 1의 `DashboardToolbar`, 기존 `nav.badge.beta` 번역
- Produces: 공통 Button 문법의 `InsightFilters`, 메뉴와 본문에 `beta` 상태가 표시된 인사이트 화면

- [ ] **Step 1: 공통 버튼·툴바·베타 배지의 실패 테스트 작성**

기존 인사이트 필터/툴바 계약 테스트를 다음 요구로 갱신하고 베타 상태 테스트를 추가한다.

```ts
test("insight filters use dashboard button variants and keep URL updates", () => {
  const filters = source("components/dashboard/insight-filters.tsx");
  assert.match(filters, /@\/components\/ui\/button/);
  assert.doesNotMatch(filters, /@\/components\/ui\/segmented-control/);
  assert.match(filters, /size="sm"/);
  assert.match(filters, /variant=\{value === item\.value \? "default" : "outline"\}/);
  assert.match(filters, /new URLSearchParams\(searchParams\.toString\(\)\)/);
});

test("insights expose beta status in navigation and the shared toolbar", () => {
  const nav = source("components/dashboard/sidebar-nav.tsx");
  const page = source("app/(dashboard)/insights/page.tsx");
  assert.match(nav, /href: "\/insights", key: "insights", icon: Lightbulb, badge: "beta"/);
  assert.match(page, /getTranslations\("nav"\)/);
  assert.match(page, /<DashboardToolbar[\s\S]*statusBadge=\{\{ status: "beta", label: navT\("badge\.beta"\) \}\}/);
});
```

툴바 테스트는 다음도 검증한다.

```ts
assert.match(page, /<DashboardToolbar[\s\S]*filters=\{\s*<InsightFilters/);
assert.match(page, /splitHeader/);
assert.match(page, /trailing=\{/);
```

- [ ] **Step 2: web 테스트를 실행해 RED 확인**

Run: `pnpm --filter @toard/web test`

Expected: FAIL because Insights still uses SegmentedControl, a bespoke header, and no beta badge.

- [ ] **Step 3: InsightFilters를 공통 Button 문법으로 변경**

`SegmentedControl`을 제거하고 기간과 지표에 동일한 로컬 버튼 그룹을 사용한다.

```tsx
function FilterButtons<T extends string>({
  value,
  items,
  label,
  onChange,
}: {
  value: T;
  items: readonly { value: T; label: React.ReactNode }[];
  label: string;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1" role="group" aria-label={label}>
      {items.map((item) => (
        <Button
          key={item.value}
          size="sm"
          variant={value === item.value ? "default" : "outline"}
          aria-pressed={value === item.value}
          onClick={() => onChange(item.value)}
        >
          {item.label}
        </Button>
      ))}
    </div>
  );
}
```

프로바이더 Select와 URL 갱신 함수는 변경하지 않는다.

- [ ] **Step 4: 인사이트 페이지를 DashboardToolbar로 조립**

`getTranslations("nav")`를 추가하고 기존 header 첫 행을 다음 구조로 바꾼다.

```tsx
const [t, navT, format, locale] = await Promise.all([
  getTranslations("insights"),
  getTranslations("nav"),
  getFormatter(),
  getLocale(),
]);

<header className="space-y-2">
  <DashboardToolbar
    title={t("title")}
    statusBadge={{ status: "beta", label: navT("badge.beta") }}
    filters={
      <InsightFilters
        preset={preset}
        metric={metric}
        provider={providerKey ?? "all"}
        providers={providers}
      />
    }
    trailing={
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
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
    }
    splitHeader
  />
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

- [ ] **Step 5: 사이드바 인사이트 항목에 beta 상태 추가**

```ts
{ href: "/insights", key: "insights", icon: Lightbulb, badge: "beta" },
```

- [ ] **Step 6: 전체 자동 검증 실행**

Run: `pnpm test && pnpm typecheck && git diff --check`

Expected: all workspace tests pass, all typechecks pass, diff check exits 0.

- [ ] **Step 7: 실제 브라우저 UI 검증**

`http://127.0.0.1:3102/insights?period=7`과 `/`를 비교한다.

- 사이드바 인사이트 메뉴와 본문 제목 옆에 cyan 베타 배지가 표시된다.
- 인사이트 기간·지표 버튼이 높이 32px이고 선택 primary/미선택 outline이다.
- 제목·freshness 첫 줄, 필터 둘째 줄로 표시된다.
- 내 사용량의 필터 배치와 선택 스타일이 변경되지 않는다.
- 390px viewport에서 필터가 줄바꿈되고 가로 오버플로가 없다.

- [ ] **Step 8: 인사이트 필터 공통화 커밋**

```bash
git add apps/web/components/dashboard/insight-filters.tsx \
  'apps/web/app/(dashboard)/insights/page.tsx' \
  apps/web/components/dashboard/sidebar-nav.tsx \
  apps/web/lib/ui-commonization.test.ts
git commit -m "style(insights): 필터 툴바와 베타 상태 통일"
```
