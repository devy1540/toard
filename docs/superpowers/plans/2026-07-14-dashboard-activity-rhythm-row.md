# Dashboard Activity Rhythm Row Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 내 사용량에서 최근 세션 카드를 제거하고 AI 도구 활동과 시간대 리듬을 55:45 한 줄로 배치한다.

**Architecture:** `OverviewView`의 레거시 세션 조회와 렌더링을 제거하고 기존 `ToolActivityCard`에 grid 배치를 위한 `className`만 추가한다. 레거시 히스토리 reader는 `server_v1`만 조회하도록 방어 조건을 추가해 E2EE 행 혼입을 차단한다.

**Tech Stack:** Next.js 15, React Server Components, Tailwind CSS, Node test runner, TypeScript

## Global Constraints

- 데스크톱 `xl` 이상은 `AI 도구 활동 55% | 시간대 리듬 45%` 한 줄 배치다.
- `xl` 미만은 AI 도구 활동 다음 시간대 리듬 순서로 세로 배치한다.
- 최근 세션 조회·비용 조인·카드·번역을 모두 제거한다.
- 본문 히스토리와 세션 탐색은 `/history`에만 둔다.
- 레거시 히스토리 reader는 `server_v1` 행만 조회한다.

---

### Task 1: 활동·리듬 행과 레거시 조회 경계

**Files:**
- Create: `apps/web/lib/dashboard-activity-layout.test.ts`
- Modify: `apps/web/components/dashboard/overview-view.tsx:1-460`
- Modify: `apps/web/components/dashboard/tool-activity-card.tsx:1-70`
- Modify: `apps/web/lib/prompt-history.ts:95-230`
- Modify: `apps/web/messages/ko/dashboard.json:62-66`
- Modify: `apps/web/messages/en/dashboard.json:62-66`

**Interfaces:**
- Consumes: `ToolActivityCard({ userId, period, className? })`, `getMyHistorySessions()` 레거시 reader
- Produces: 최근 세션 없는 `OverviewView`, `className?: string`을 받는 `ToolActivityCard`

- [ ] **Step 1: 실패하는 레이아웃 회귀 테스트 작성**

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("내 사용량은 최근 세션을 제거하고 AI 활동과 시간대 리듬을 한 줄로 배치한다", () => {
  const overview = source("../components/dashboard/overview-view.tsx");
  const toolCard = source("../components/dashboard/tool-activity-card.tsx");
  assert.doesNotMatch(overview, /getMyHistorySessions|recentSessionsTitle|server_v1/);
  assert.match(overview, /xl:grid-cols-\[minmax\(0,1\.2fr\)_minmax\(0,1fr\)\]/);
  assert.ok(overview.indexOf("<ToolActivityCard") < overview.indexOf('t("rhythmTitle")'));
  assert.match(toolCard, /className\?: string/);
});

test("레거시 히스토리 reader는 server_v1만 조회한다", () => {
  const promptHistory = source("./prompt-history.ts");
  assert.match(promptHistory, /encryption_scheme = 'server_v1'/);
});
```

- [ ] **Step 2: 테스트를 실행해 의도한 실패 확인**

Run: `pnpm --filter web test -- dashboard-activity-layout.test.ts`

Expected: 최근 세션 문자열이 남아 있고 1.2fr:1fr grid가 없어 FAIL

- [ ] **Step 3: 최소 구현으로 최근 세션 제거와 한 줄 배치 적용**

`OverviewView`에서 `getMyHistorySessions`, `RECENT_SESSIONS_SHOWN`, 최근 usage 조인, 최근 세션 section과 관련 imports를 삭제한다. `ToolActivityCard`와 시간대 리듬 section을 아래 grid 안에 순서대로 둔다.

```tsx
<div className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
  <ToolActivityCard userId={userId} period={period} className="h-full" />
  <section className="min-w-0 rounded-lg border p-4">...</section>
</div>
```

`ToolActivityCard`는 선택적 class를 받아 기존 card class와 합친다.

```tsx
export async function ToolActivityCard({ userId, period, className }: {
  userId: string;
  period: DashboardPeriod;
  className?: string;
}) {
  return <Card className={cn("min-w-0", className)}>...</Card>;
}
```

레거시 목록 공통 조건과 상세 조건에 아래 절을 넣는다.

```sql
encryption_scheme = 'server_v1'
```

한국어·영어에서 `recentSessionsTitle`, `recentSessionsDescription`, `recentSessionsUnavailable`, `noRecentSessions`를 삭제한다.

- [ ] **Step 4: 집중 테스트와 타입 검사 실행**

Run: `pnpm --filter web test -- dashboard-activity-layout.test.ts`

Expected: PASS

Run: `pnpm typecheck`

Expected: 전체 workspace PASS

- [ ] **Step 5: 전체 테스트와 프로덕션 빌드 실행**

Run: `pnpm test`

Expected: 실패 0

Run: `pnpm build`

Expected: Next.js production build 성공

- [ ] **Step 6: 구현 커밋**

```bash
git add apps/web/components/dashboard/overview-view.tsx apps/web/components/dashboard/tool-activity-card.tsx apps/web/lib/dashboard-activity-layout.test.ts apps/web/lib/prompt-history.ts apps/web/messages/ko/dashboard.json apps/web/messages/en/dashboard.json
git commit -m "fix(dashboard): E2EE 최근 세션 카드를 제거"
```
