# 기존 저장 비용 표시 개선 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 정상적인 과거 저장 비용은 비용 KPI의 보조 정보로 낮추고, 가격 미확정 상태만 경고로 유지한다.

**Architecture:** 기존 `UsageCostCoverage`와 `costCoverageState`를 그대로 사용하고, `legacy` 전용 보조 문구 표시 여부를 `apps/web/lib/pricing.ts`의 순수 함수로 중앙화한다. 공통 비용 포매터와 가격 알림을 먼저 고친 뒤 개인 화면, 인사이트, 조직·팀 화면이 같은 helper와 번역 키를 사용하도록 바꾼다.

**Tech Stack:** Next.js 15 App Router, React 19 Server Components, TypeScript, next-intl, Node.js test runner, Tailwind CSS

## Global Constraints

- 가격 집계 방식, 저장된 비용 값, 가격 동기화, rollup 생성과 조회 경로는 변경하지 않는다.
- `legacy` 비용은 상단 알림을 표시하지 않고 비용 숫자를 그대로 표시한다.
- `legacy` 보조 문구는 `{count}건은 이전 가격 기준`으로 표시한다.
- `partial`과 `unpriced`의 경고, 비용 포매팅, 관리자 링크는 유지한다.
- 사용자 화면에 `legacy`, `revision`, `provenance`를 새로 노출하지 않는다.
- 개인 대시보드, 클래식 뷰, 인사이트, 조직 개요, 팀 목록, 팀 상세에 같은 규칙을 적용한다.
- 추가 API 호출이나 가격 테이블 조회를 만들지 않는다.

---

## File Structure

- Modify: `apps/web/lib/pricing.ts` — 가격 coverage 상태별 표시 정책과 `legacy` 보조 문구 건수 판정.
- Modify: `apps/web/lib/pricing.test.ts` — 순수 표시 정책과 한영 메시지 계약 검증.
- Modify: `apps/web/components/dashboard/pricing-notice.tsx` — `partial`·`unpriced` 경고만 렌더링.
- Modify: `apps/web/messages/ko/dashboard.json` — 한국어 `legacyHint` 문구 추가.
- Modify: `apps/web/messages/en/dashboard.json` — 영어 `legacyHint` 문구 추가.
- Modify: `apps/web/components/dashboard/overview-view.tsx` — 개인 개요 비용 KPI에 보조 문구 적용.
- Modify: `apps/web/components/dashboard/classic-view.tsx` — 클래식 비용 카드에 보조 문구 적용.
- Modify: `apps/web/app/(dashboard)/insights/page.tsx` — 현재 기간 비용 KPI에 보조 문구 적용.
- Modify: `apps/web/app/(dashboard)/org/page.tsx` — 조직 대표 비용 KPI에 보조 문구 적용.
- Modify: `apps/web/app/(dashboard)/org/teams/page.tsx` — 팀 목록 총비용 KPI에 보조 문구 적용.
- Modify: `apps/web/app/(dashboard)/org/team/page.tsx` — 팀 상세 대표 비용 KPI에 보조 문구 적용.
- Create: `apps/web/lib/legacy-cost-display.test.ts` — 대상 화면 전체의 공통 helper 사용과 배너 제거 계약 검증.

---

### Task 1: 가격 coverage 표시 정책 중앙화

**Files:**
- Modify: `apps/web/lib/pricing.ts`
- Modify: `apps/web/lib/pricing.test.ts`
- Modify: `apps/web/components/dashboard/pricing-notice.tsx`
- Modify: `apps/web/messages/ko/dashboard.json`
- Modify: `apps/web/messages/en/dashboard.json`

**Interfaces:**
- Consumes: `UsageCostCoverage`, 기존 `costCoverageState(coverage)`.
- Produces: `legacyCostHintCount(coverage: UsageCostCoverage): number | null`; `formatCostForCoverage`의 `legacy` 반환값은 원래 비용 문자열; `PricingNotice`는 `partial`·`unpriced`에서만 렌더링.

- [ ] **Step 1: 실패하는 표시 정책 테스트 작성**

`apps/web/lib/pricing.test.ts`의 `비용 표시 상태는 mixed, all-unpriced, legacy-only를 구분한다` 테스트에서 `legacy` 포매팅 기대값을 바꾸고 helper 계약을 추가한다.

```ts
assert.equal(
  format("$4.50", { pricedEvents: 0, unpricedEvents: 0, legacyEvents: 4 }, labels),
  "$4.50",
);

assert.equal(typeof pricing.legacyCostHintCount, "function");
const legacyHintCount = pricing.legacyCostHintCount as (
  coverage: { pricedEvents: number; unpricedEvents: number; legacyEvents: number },
) => number | null;
assert.equal(legacyHintCount({ pricedEvents: 0, unpricedEvents: 0, legacyEvents: 4 }), 4);
assert.equal(legacyHintCount({ pricedEvents: 2, unpricedEvents: 0, legacyEvents: 4 }), 4);
assert.equal(legacyHintCount({ pricedEvents: 2, unpricedEvents: 1, legacyEvents: 4 }), null);
assert.equal(legacyHintCount({ pricedEvents: 2, unpricedEvents: 0, legacyEvents: 0 }), null);
```

같은 파일의 한영 메시지 테스트는 새 문구를 검증한다.

```ts
assert.match(messages.costCoverage.legacyHint, /\{count\}/);
```

- [ ] **Step 2: 테스트가 현재 동작에서 실패하는지 확인**

Run:

```bash
pnpm --filter @toard/web exec node --import tsx --test lib/pricing.test.ts
```

Expected: `legacyCostHintCount`가 없고 `legacy` 비용이 `$4.50 · 기존 저장 비용`으로 반환되어 FAIL.

- [ ] **Step 3: 최소 표시 정책 구현**

`apps/web/lib/pricing.ts`에서 `legacy` 비용은 숫자만 반환하고 보조 문구 건수를 순수 함수로 제공한다.

```ts
export function legacyCostHintCount(coverage: UsageCostCoverage): number | null {
  return costCoverageState(coverage) === "legacy" ? coverage.legacyEvents : null;
}

export function formatCostForCoverage(
  cost: string,
  coverage: UsageCostCoverage,
  labels: { partial: string; unpriced: string; legacy: string },
): string {
  const state = costCoverageState(coverage);
  if (state === "unpriced") return labels.unpriced;
  if (state === "partial") return `${cost} · ${labels.partial}`;
  return cost;
}
```

`apps/web/components/dashboard/pricing-notice.tsx`는 `legacy`를 조용한 정상 상태로 취급하고 amber 경고 경로만 남긴다.

```tsx
import { AlertTriangle } from "lucide-react";

export async function PricingNotice({ coverage }: { coverage: UsageCostCoverage }) {
  const state = costCoverageState(coverage);
  if (state === "complete" || state === "legacy") return null;

  const t = await getTranslations("dashboard");
  const isAdmin = (await getSessionUser())?.role === "admin";

  return (
    <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
      <div>
        <p className="font-medium">
          {t("pricingNotice.unpricedTitle", { count: coverage.unpricedEvents })}
        </p>
        <p className="text-muted-foreground mt-0.5 text-xs">
          {isAdmin
            ? t.rich("pricingNotice.unpricedAdminAction", {
                link: (chunks) => (
                  <Link href="/admin?tab=system" className="text-primary underline-offset-4 hover:underline">
                    {chunks}
                  </Link>
                ),
              })
            : t("pricingNotice.unpricedMemberAction")}
        </p>
      </div>
    </div>
  );
}
```

`apps/web/messages/ko/dashboard.json`과 `apps/web/messages/en/dashboard.json`의 `costCoverage`에 같은 shape의 키를 추가한다.

```json
// ko
"legacyHint": "{count}건은 이전 가격 기준"

// en
"legacyHint": "{count} events use earlier stored prices"
```

- [ ] **Step 4: 표시 정책 테스트 통과 확인**

Run:

```bash
pnpm --filter @toard/web exec node --import tsx --test lib/pricing.test.ts
```

Expected: `pricing.test.ts` 전체 PASS.

- [ ] **Step 5: 표시 정책 커밋**

```bash
git add apps/web/lib/pricing.ts apps/web/lib/pricing.test.ts apps/web/components/dashboard/pricing-notice.tsx apps/web/messages/ko/dashboard.json apps/web/messages/en/dashboard.json
git commit -m "refactor(ui): 기존 비용 표시 정책 분리"
```

---

### Task 2: 개인 대시보드 개요·클래식 뷰 적용

**Files:**
- Create: `apps/web/lib/legacy-cost-display.test.ts`
- Modify: `apps/web/components/dashboard/overview-view.tsx`
- Modify: `apps/web/components/dashboard/classic-view.tsx`

**Interfaces:**
- Consumes: Task 1의 `legacyCostHintCount(coverage): number | null`, `dashboard.costCoverage.legacyHint`.
- Produces: 개인 개요와 클래식 비용 KPI의 보조 문구. `legacy`가 아니면 기존 기간 비교 문구를 유지한다.

- [ ] **Step 1: 실패하는 개인 화면 계약 테스트 작성**

`apps/web/lib/legacy-cost-display.test.ts`를 만든다.

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

test("legacy 가격 상태는 상단 배너 없이 개인 비용 KPI의 보조 문구로 표시된다", () => {
  const notice = source("components/dashboard/pricing-notice.tsx");
  const overview = source("components/dashboard/overview-view.tsx");
  const classic = source("components/dashboard/classic-view.tsx");

  assert.match(notice, /state === "complete" \|\| state === "legacy"/);
  assert.doesNotMatch(notice, /pricingNotice\.legacyTitle|pricingNotice\.legacyDescription/);
  assert.match(overview, /legacyCostHintCount\(overview\.costCoverage\)/);
  assert.match(overview, /costCoverage\.legacyHint/);
  assert.match(classic, /legacyCostHintCount\(overview\.costCoverage\)/);
  assert.match(classic, /costCoverage\.legacyHint/);
});
```

- [ ] **Step 2: 개인 화면 테스트 실패 확인**

Run:

```bash
pnpm --filter @toard/web exec node --import tsx --test lib/legacy-cost-display.test.ts
```

Expected: 두 화면이 `legacyCostHintCount`와 `legacyHint`를 아직 사용하지 않아 FAIL.

- [ ] **Step 3: 개인 개요 뷰 구현**

`apps/web/components/dashboard/overview-view.tsx`에서 helper를 import하고 기존 비용 비교 힌트보다 `legacy` 힌트를 우선한다. 델타 배지는 그대로 둔다.

```ts
import { formatCostForCoverage, legacyCostHintCount } from "@/lib/pricing";

const legacyCount = legacyCostHintCount(overview.costCoverage);
const costHint = legacyCount == null
  ? costDelta
    ? t(period.preset === "today" ? "vsPrevToday" : "vsPrevPeriod")
    : undefined
  : t("costCoverage.legacyHint", { count: fmtNum(legacyCount) });
```

비용 `SummaryMetric`에는 계산한 힌트를 전달한다.

```tsx
<SummaryMetric
  label={t(`costLabel.${period.preset}`)}
  value={coveredCost(overview.totalCostUsd, overview.costCoverage, costLabels)}
  sub={costHint}
  badge={costDelta ? <DeltaBadge delta={costDelta} /> : undefined}
  icon={<DollarSign className="size-3.5" />}
/>
```

- [ ] **Step 4: 클래식 뷰 구현**

`apps/web/components/dashboard/classic-view.tsx`에도 같은 우선순위를 적용한다.

```ts
import { costCoverageState, legacyCostHintCount } from "@/lib/pricing";

const legacyCount = legacyCostHintCount(overview.costCoverage);
const costHint = legacyCount == null
  ? costDelta
    ? t(period.preset === "today" ? "vsPrevToday" : "vsPrevPeriod")
    : undefined
  : t("costCoverage.legacyHint", { count: fmtNum(legacyCount) });
```

```tsx
<StatCard
  label={t(`costLabel.${period.preset}`)}
  value={coveredCost(overview.totalCostUsd, overview.costCoverage, costLabels)}
  delta={costDelta}
  hint={costHint}
  spark={spark.cost}
  icon={<DollarSign className="size-4" />}
/>
```

- [ ] **Step 5: 개인 화면 계약과 기존 가격 테스트 통과 확인**

Run:

```bash
pnpm --filter @toard/web exec node --import tsx --test lib/pricing.test.ts lib/legacy-cost-display.test.ts
```

Expected: 두 테스트 파일 전체 PASS.

- [ ] **Step 6: 개인 화면 커밋**

```bash
git add apps/web/lib/legacy-cost-display.test.ts apps/web/components/dashboard/overview-view.tsx apps/web/components/dashboard/classic-view.tsx
git commit -m "feat(ui): 개인 비용 KPI에 이전 가격 기준 표시"
```

---

### Task 3: 인사이트·조직·팀 화면 공통 적용

**Files:**
- Modify: `apps/web/lib/legacy-cost-display.test.ts`
- Modify: `apps/web/app/(dashboard)/insights/page.tsx`
- Modify: `apps/web/app/(dashboard)/org/page.tsx`
- Modify: `apps/web/app/(dashboard)/org/teams/page.tsx`
- Modify: `apps/web/app/(dashboard)/org/team/page.tsx`

**Interfaces:**
- Consumes: Task 1의 `legacyCostHintCount`, Task 2의 `legacy-cost-display.test.ts` source helper.
- Produces: 인사이트 현재 기간, 조직 대표 비용, 팀 목록 총비용, 팀 상세 대표 비용에 동일한 보조 문구.

- [ ] **Step 1: 실패하는 전체 화면 계약 테스트 추가**

`apps/web/lib/legacy-cost-display.test.ts`에 대상 coverage가 정확한지 검증한다.

```ts
test("legacy 가격 보조 문구는 인사이트와 조직·팀의 대표 비용 KPI에 공통 적용된다", () => {
  const insights = source("app/(dashboard)/insights/page.tsx");
  const org = source("app/(dashboard)/org/page.tsx");
  const teams = source("app/(dashboard)/org/teams/page.tsx");
  const team = source("app/(dashboard)/org/team/page.tsx");

  assert.match(insights, /legacyCostHintCount\(comparison\.current\.costCoverage\)/);
  assert.match(insights, /costComplete[\s\S]*costCoverage\.legacyHint/);
  assert.match(org, /legacyCostHintCount\(overview\.costCoverage\)/);
  assert.match(teams, /legacyCostHintCount\(coverage\)/);
  assert.match(team, /legacyCostHintCount\(overview\.costCoverage\)/);

  for (const page of [insights, org, teams, team]) {
    assert.match(page, /costCoverage\.legacyHint/);
  }
});
```

- [ ] **Step 2: 전체 화면 계약 테스트 실패 확인**

Run:

```bash
pnpm --filter @toard/web exec node --import tsx --test lib/legacy-cost-display.test.ts
```

Expected: 인사이트·조직·팀 파일이 helper를 사용하지 않아 FAIL.

- [ ] **Step 3: 인사이트 현재 기간 비용 KPI 적용**

`apps/web/app/(dashboard)/insights/page.tsx`는 현재·이전 기간 중 가격 미확정이 없을 때만 현재 기간의 `legacyEvents`를 보조 문구로 쓴다.

```ts
import { formatCostForCoverage, legacyCostHintCount } from "@/lib/pricing";

const currentLegacyCount = costComplete
  ? legacyCostHintCount(comparison.current.costCoverage)
  : null;
const costComparison = currentLegacyCount == null
  ? costComplete
    ? comparison.previous.costUsd === 0
      ? t("kpi.noPrevious")
      : t("kpi.previousPeriod")
    : comparisonCoverage.pricedEvents + comparisonCoverage.legacyEvents > 0
      ? costLabels.partial
      : costLabels.unpriced
  : dashboardT("costCoverage.legacyHint", { count: format.number(currentLegacyCount) });
```

비용 `KpiCard`의 `comparison`에는 `costComparison`을 전달한다.

- [ ] **Step 4: 조직 개요 대표 비용 KPI 적용**

`apps/web/app/(dashboard)/org/page.tsx`는 현재·이전 중 가격 미확정이 있으면 기존 `부분 합계`를 우선하고, 아니면 현재 기간의 `legacy` 힌트를 기존 비용 비교 문구보다 우선한다.

```ts
import { formatCostForCoverage, legacyCostHintCount } from "@/lib/pricing";

const legacyCount = overview.costCoverage.unpricedEvents === 0 && prevOverview.costCoverage.unpricedEvents === 0
  ? legacyCostHintCount(overview.costCoverage)
  : null;
const legacyHint = legacyCount == null
  ? null
  : dashboardT("costCoverage.legacyHint", { count: fmtNum(legacyCount) });
const costComparison = legacyHint ?? (
  overview.costCoverage.unpricedEvents > 0 || prevOverview.costCoverage.unpricedEvents > 0
    ? dashboardT("costCoverage.partial")
    : prevOverview.totalCostUsd > 0
      ? t(overview.totalCostUsd <= prevOverview.totalCostUsd ? "hero.lessThanPrev" : "hero.moreThanPrev", {
          prev: fmtUsd(prevOverview.totalCostUsd),
          diff: fmtUsd(Math.abs(overview.totalCostUsd - prevOverview.totalCostUsd)),
        })
      : t("hero.noComparison")
);
```

- [ ] **Step 5: 팀 목록 총비용 KPI 적용**

`apps/web/app/(dashboard)/org/teams/page.tsx`에서 집계 coverage의 보조 문구를 만들고 기존 설명보다 우선한다.

```ts
import { formatCostForCoverage, legacyCostHintCount } from "@/lib/pricing";

const legacyCount = legacyCostHintCount(coverage);
const rankedCostSub = legacyCount == null
  ? t("ranking.totalCostSub", { scope: scopeLabel })
  : dashboardT("costCoverage.legacyHint", { count: fmtNum(legacyCount) });
```

```tsx
<SummaryTile
  label={t("ranking.totalCost")}
  value={formatCostForCoverage(fmtUsd(rankedCost), coverage, costLabels)}
  sub={rankedCostSub}
  icon={<DollarSign className="size-3.5" />}
/>
```

- [ ] **Step 6: 팀 상세 대표 비용 KPI 적용**

`apps/web/app/(dashboard)/org/team/page.tsx`의 `TeamHero` 인자 구조 분해에서 `costLabel` 다음에 `costSub`를 추가한다.

```tsx
  costLabel,
  costSub,
  activeUsersLabel,
```

같은 함수의 props 타입에서 `costLabel` 다음에 optional 문자열을 추가한다.

```tsx
  costLabel: string;
  costSub?: string;
  activeUsersLabel: string;
```

기존 비용 `SummaryTile` 전체를 다음 JSX로 교체한다.

```tsx
<SummaryTile
  label={costLabel}
  value={formatCostForCoverage(fmtUsd(overview.totalCostUsd), overview.costCoverage, costLabels)}
  sub={costSub}
/>
```

호출부는 현재 팀 overview만 사용한다.

```ts
const legacyCount = legacyCostHintCount(overview.costCoverage);
const costSub = legacyCount == null
  ? undefined
  : dashboardT("costCoverage.legacyHint", { count: fmtNum(legacyCount) });
```

```tsx
<TeamHero
  overview={overview}
  previousTokens={previousTokens}
  tokenLabel={t("totalTokens")}
  costLabel={t("totalCost")}
  costSub={costSub}
  activeUsersLabel={t("activeUsers")}
  sessionsLabel={t("sessions")}
  activeUsersSub={t("hero.activeUsersSub")}
  costLabels={costLabels}
/>
```

- [ ] **Step 7: 대상 화면 계약과 웹 테스트 통과 확인**

Run:

```bash
pnpm --filter @toard/web exec node --import tsx --test lib/pricing.test.ts lib/legacy-cost-display.test.ts lib/ui-commonization.test.ts
```

Expected: 세 테스트 파일 전체 PASS. 기존 `ui-commonization.test.ts`의 가격 coverage 공통화 계약도 유지.

- [ ] **Step 8: 조직·팀 화면 커밋**

```bash
git add apps/web/lib/legacy-cost-display.test.ts 'apps/web/app/(dashboard)/insights/page.tsx' 'apps/web/app/(dashboard)/org/page.tsx' 'apps/web/app/(dashboard)/org/teams/page.tsx' 'apps/web/app/(dashboard)/org/team/page.tsx'
git commit -m "feat(ui): 비용 출처 안내를 전체 화면에 적용"
```

---

### Task 4: 전체 회귀·로컬 화면 검증

**Files:**
- Verify only: `apps/web/**`
- Verify only: `scripts/seed-dashboard-demo.ts`

**Interfaces:**
- Consumes: Task 1~3의 공통 표시 정책과 대상 화면 구현.
- Produces: 테스트, 타입 검사, 프로덕션 빌드, 로컬 반응형 화면 검증 결과.

- [ ] **Step 1: 웹 전체 테스트 실행**

Run:

```bash
pnpm --filter @toard/web test
```

Expected: `apps/web/lib/*.test.ts` 전체 PASS.

- [ ] **Step 2: 웹 타입 검사 실행**

Run:

```bash
pnpm --filter @toard/web typecheck
```

Expected: exit code 0, TypeScript 오류 없음.

- [ ] **Step 3: 웹 프로덕션 빌드 실행**

Run:

```bash
pnpm --filter @toard/web build
```

Expected: exit code 0, Next.js production build 완료.

- [ ] **Step 4: 로컬 legacy 데이터 준비**

로컬 DB만 사용한다. 프로덕션 DB에는 실행하지 않는다.

```bash
docker compose -f docker-compose.dev.yml up -d
DATABASE_URL=postgresql://toard:toard@localhost:5432/toard pnpm migrate
export TOARD_CONTENT_KEK_B64="$(openssl rand -base64 32)"
DATABASE_URL=postgresql://toard:toard@localhost:5432/toard pnpm seed:dashboard-demo
```

Expected: migration 성공, `dashboard demo seed`와 `usage_events upserted` 출력. 마이그레이션 이후 기본 `cost_status=legacy`인 데모 이벤트가 생성됨.

- [ ] **Step 5: 로컬 앱 실행과 화면 확인**

```bash
AUTH_MODE=open AUTH_OPEN_USER_EMAIL=demo.viewer@toard.local DATABASE_URL=postgresql://toard:toard@localhost:5432/toard TOARD_CONTENT_KEK_B64="$TOARD_CONTENT_KEK_B64" pnpm dev
```

Expected: `http://localhost:3000`에서 로그인 없이 데모 사용자의 화면이 열림.

다음 경로를 데스크톱 폭과 390px 폭에서 확인한다.

- `/`
- `/`에서 상단 `대시보드 뷰` 토글을 `클래식`으로 전환
- `/insights`
- `/org`
- `/org/teams`
- `/org/team`

각 화면의 성공 기준:

- 파란 `legacy` 상단 배너가 없음.
- 대표 비용 값에 `· 기존 저장 비용` 접미사가 없음.
- 대표 비용 KPI 아래에 `{count}건은 이전 가격 기준`이 한 번만 표시됨.
- 모델·기기·사용자·팀 반복 행의 비용에는 legacy 접미사가 없음.
- 390px 폭에서 비용 숫자, 보조 문구, 인접 KPI가 겹치거나 잘리지 않음.

- [ ] **Step 6: 가격 미확정 회귀 상태 확인**

테스트에서 `unpricedEvents > 0` 케이스가 `가격 미확정` 또는 `부분 합계`를 반환하고 `PricingNotice` source 계약이 amber 경고와 `/admin?tab=system` 링크를 유지하는지 다시 확인한다.

Run:

```bash
pnpm --filter @toard/web exec node --import tsx --test lib/pricing.test.ts lib/legacy-cost-display.test.ts
```

Expected: unpriced·partial 회귀 테스트 PASS.

- [ ] **Step 7: diff 위생 확인**

```bash
git diff --check HEAD~3..HEAD
git status --short
```

Expected: 공백 오류 없음. 계획 밖 파일 변경 없음.
