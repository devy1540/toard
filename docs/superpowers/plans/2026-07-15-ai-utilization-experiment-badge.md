# AI 활용 지수 실험 태그 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 개인·조직 AI 활용 지수 카드 제목 옆에 번역된 outline 실험 태그를 표시한다.

**Architecture:** 기존 공용 `Badge` 컴포넌트와 `next-intl` 메시지를 그대로 사용한다. 개인 카드에는 태그를 한 번 추가하고, 조직 카드는 suppressed·insufficient_data·ready 세 상태의 공통 제목 구조에 같은 태그를 추가하며 source contract test로 모든 분기를 고정한다.

**Tech Stack:** Next.js 15, React 19, TypeScript, next-intl, Node.js test runner, Tailwind CSS

## Global Constraints

- 표시 위치는 개인 `AI 활용 지수`와 조직 `조직 AI 활용 지수` 카드 제목 옆으로 한정한다.
- 태그 문구는 한국어 `실험`, 영어 `Experimental`이다.
- 공용 `Badge`의 `outline` variant를 사용한다.
- 개인 카드의 신뢰도 배지는 기존 위치와 `secondary` variant를 유지한다.
- 내비게이션, 페이지 제목, 산식, 캐시, 저장소, 개인정보 보호 정책은 변경하지 않는다.

---

### Task 1: 개인·조직 활용 지수 카드에 실험 태그 표시

**Files:**
- Modify: `apps/web/lib/ai-utilization-ui.test.ts`
- Modify: `apps/web/components/dashboard/utilization-index-card.tsx`
- Modify: `apps/web/components/dashboard/org-utilization-card.tsx`
- Modify: `apps/web/messages/ko/insights.json`
- Modify: `apps/web/messages/en/insights.json`
- Modify: `apps/web/messages/ko/org.json`
- Modify: `apps/web/messages/en/org.json`

**Interfaces:**
- Consumes: `Badge({ variant: "outline" })`, `t("utilization.experiment")`
- Produces: 개인 카드 1개와 조직 카드 3개 상태에 동일한 실험 태그, 한국어·영어 `utilization.experiment` 메시지

- [ ] **Step 1: 실험 태그 UI와 번역 계약을 고정하는 실패 테스트 작성**

`apps/web/lib/ai-utilization-ui.test.ts`에 다음 테스트를 추가한다.

```ts
test("개인과 조직 활용 지수 카드는 제목 옆에 outline 실험 태그를 표시한다", () => {
  const personal = source("components/dashboard/utilization-index-card.tsx");
  const organization = source("components/dashboard/org-utilization-card.tsx");
  const badgePattern = /<Badge variant="outline">\{t\("utilization\.experiment"\)\}<\/Badge>/g;

  assert.equal(personal.match(badgePattern)?.length, 1);
  assert.equal(organization.match(badgePattern)?.length, 3);
  assert.match(personal, /<Badge variant="secondary">\{t\(`utilization\.confidence\./);
});

test("활용 지수 실험 태그는 한국어와 영어 문구를 제공한다", () => {
  const koInsights = JSON.parse(source("messages/ko/insights.json"));
  const enInsights = JSON.parse(source("messages/en/insights.json"));
  const koOrg = JSON.parse(source("messages/ko/org.json"));
  const enOrg = JSON.parse(source("messages/en/org.json"));

  assert.equal(koInsights.utilization.experiment, "실험");
  assert.equal(enInsights.utilization.experiment, "Experimental");
  assert.equal(koOrg.utilization.experiment, "실험");
  assert.equal(enOrg.utilization.experiment, "Experimental");
  assert.deepEqual(messageShape(koOrg.utilization), messageShape(enOrg.utilization));
});
```

- [ ] **Step 2: 집중 테스트를 실행해 기능 부재로 실패하는지 확인**

Run:

```bash
pnpm --filter @toard/web exec node --import tsx --test lib/ai-utilization-ui.test.ts
```

Expected: 새 테스트가 `0 !== 1` 또는 `undefined !== "실험"`으로 실패하며, 문법·파일 로드 오류는 없어야 한다.

- [ ] **Step 3: 개인 카드 제목에 실험 태그 추가**

`apps/web/components/dashboard/utilization-index-card.tsx`의 제목을 다음 구조로 변경한다.

```tsx
<div>
  <div className="flex flex-wrap items-center gap-2">
    <CardTitle>{t("utilization.title")}</CardTitle>
    <Badge variant="outline">{t("utilization.experiment")}</Badge>
  </div>
  <CardDescription>{t("utilization.description")}</CardDescription>
</div>
```

우측의 기존 신뢰도 배지는 그대로 둔다.

- [ ] **Step 4: 조직 카드 세 상태의 제목에 실험 태그 추가**

`apps/web/components/dashboard/org-utilization-card.tsx`에 `Badge` import를 추가한다.

```ts
import { Badge } from "@/components/ui/badge";
```

suppressed·insufficient_data·ready 각 분기의 `CardTitle`을 모두 다음 구조로 변경한다.

```tsx
<CardTitle className="flex flex-wrap items-center gap-2">
  {t("utilization.title")}
  <Badge variant="outline">{t("utilization.experiment")}</Badge>
</CardTitle>
```

- [ ] **Step 5: 개인·조직 한영 번역 추가**

네 메시지 파일의 `utilization.title` 바로 다음에 다음 키를 추가한다.

```json
"experiment": "실험"
```

영어 파일에는 다음 값을 사용한다.

```json
"experiment": "Experimental"
```

- [ ] **Step 6: 집중 테스트와 타입 검사를 실행해 통과 확인**

Run:

```bash
pnpm --filter @toard/web exec node --import tsx --test lib/ai-utilization-ui.test.ts
pnpm --filter @toard/web typecheck
```

Expected: 집중 테스트는 실패 0건, 타입 검사는 exit code 0.

- [ ] **Step 7: 전체 웹 테스트와 diff 검사를 실행**

Run:

```bash
pnpm --filter @toard/web test
git diff --check
```

Expected: 전체 웹 테스트는 실패 0건, `git diff --check`는 출력 없이 exit code 0.

- [ ] **Step 8: 구현 커밋**

```bash
git add apps/web/lib/ai-utilization-ui.test.ts \
  apps/web/components/dashboard/utilization-index-card.tsx \
  apps/web/components/dashboard/org-utilization-card.tsx \
  apps/web/messages/ko/insights.json apps/web/messages/en/insights.json \
  apps/web/messages/ko/org.json apps/web/messages/en/org.json
git commit -m "feat(ui): 활용 지수에 실험 태그를 표시"
```
