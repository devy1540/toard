# AI Tool Activity Beta Badge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 개요 화면의 AI 도구 활동 카드 제목 옆에 기존 공용 베타 태그를 표시한다.

**Architecture:** `ToolActivityCard` 서버 컴포넌트가 공용 `FeatureStatusBadge`와 기존 `nav.badge.beta` 번역을 직접 사용한다. 새 컴포넌트나 상태 API는 만들지 않고 소스 회귀 테스트로 배치 계약을 고정한다.

**Tech Stack:** Next.js 15, React 19, next-intl, Node test runner

## Global Constraints

- 카드는 개요 화면에만 유지한다.
- 태그는 제목 바로 오른쪽에 표시한다.
- 기존 `FeatureStatusBadge`의 `beta` 상태와 `nav.badge.beta` 번역을 재사용한다.
- 상세 페이지, 클래식 화면, 사이드바에는 새 태그를 추가하지 않는다.

---

### Task 1: AI 도구 활동 베타 태그

**Files:**
- Modify: `apps/web/lib/ui-commonization.test.ts`
- Modify: `apps/web/components/dashboard/tool-activity-card.tsx`

**Interfaces:**
- Consumes: `FeatureStatusBadge({ status: "beta", children })`, `getTranslations("nav")`
- Produces: 제목과 베타 태그가 같은 행에 렌더링되는 `ToolActivityCard`

- [ ] **Step 1: 실패하는 소스 회귀 테스트 작성**

`apps/web/lib/ui-commonization.test.ts`에 다음 테스트를 추가한다.

```ts
test("tool activity card marks the feature as beta", () => {
  const card = source("components/dashboard/tool-activity-card.tsx");
  assert.match(card, /FeatureStatusBadge/);
  assert.match(card, /status="beta"/);
  assert.match(card, /navT\("badge\.beta"\)/);
});
```

- [ ] **Step 2: 테스트가 올바른 이유로 실패하는지 확인**

Run: `pnpm --filter @toard/web test`

Expected: `tool activity card marks the feature as beta`가 `FeatureStatusBadge`를 찾지 못해 FAIL한다.

- [ ] **Step 3: 최소 구현 추가**

`apps/web/components/dashboard/tool-activity-card.tsx`에서 공용 배지를 import하고, nav 번역을 읽어 제목 옆에 배치한다.

```tsx
import { FeatureStatusBadge } from "@/components/dashboard/feature-status-badge";

const navT = await getTranslations("nav");

<div className="flex items-center gap-2">
  <CardTitle>{t("title")}</CardTitle>
  <FeatureStatusBadge status="beta">{navT("badge.beta")}</FeatureStatusBadge>
</div>
```

- [ ] **Step 4: 테스트와 타입 검사 실행**

Run: `pnpm --filter @toard/web test && pnpm --filter @toard/web typecheck`

Expected: web 테스트 전부 PASS, TypeScript 오류 0건.

- [ ] **Step 5: 로컬 화면 검증**

`http://localhost:3001/`의 개요 화면에서 `AI 도구 활동` 제목 오른쪽에 `베타` 태그가 보이는지 확인한다. 클래식 화면에는 AI 도구 활동 카드가 없는 기존 동작을 유지한다.

- [ ] **Step 6: 커밋**

```bash
git add apps/web/lib/ui-commonization.test.ts apps/web/components/dashboard/tool-activity-card.tsx
git commit -m "feat(dashboard): AI 도구 활동 베타 태그 추가"
```
