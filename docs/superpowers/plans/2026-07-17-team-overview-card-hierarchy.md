# Team Overview Card Hierarchy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `팀별 현황`을 `팀 현황`과 같은 대표 카드·분석 카드 위계로 정리하고 변경을 `v0.15.34`로 릴리스한다.

**Architecture:** 데이터 조회와 순위 계산은 기존 `AllTeamsOverview`에 유지하고, 상단 표시만 전용 `TeamRankingHero` 표현 컴포넌트로 분리한다. 페이지 콘텐츠 래퍼를 명시적인 수직 스택으로 바꾸고 기존 순위·차트 컴포넌트는 그대로 재사용한다.

**Tech Stack:** Next.js App Router, React Server Components, TypeScript, Tailwind CSS, Node test runner, GitHub Actions

## Global Constraints

- 기존 리더보드 조회, 비용·토큰·세션 합산 및 순위 계산을 변경하지 않는다.
- 기간, 프로바이더, 자동 새로고침 필터를 변경하지 않는다.
- 번역 문구, 메뉴 명칭, 차트 데이터, 전역 색상 토큰을 변경하지 않는다.
- `팀 현황`, `전체 현황`, 공통 `Card` 컴포넌트를 변경하지 않는다.
- 상단 네 지표의 값과 설명 문구를 모두 보존한다.
- 좁은 화면에서 가로 스크롤이 생기지 않아야 한다.
- 프로덕션 데이터베이스를 직접 변경하지 않는다.

---

### Task 1: 팀별 현황 카드 위계 계약 테스트

**Files:**
- Modify: `apps/web/lib/ui-commonization.test.ts`
- Test: `apps/web/lib/ui-commonization.test.ts`

**Interfaces:**
- Consumes: `app/(dashboard)/org/teams/page.tsx` 소스
- Produces: `TeamRankingHero`와 `space-y-6` 페이지 스택을 요구하는 회귀 계약

- [ ] **Step 1: 실패하는 계약 테스트를 추가한다**

```ts
test("team overview uses a bounded hero and separated analysis sections", () => {
  const page = source("app/(dashboard)/org/teams/page.tsx");

  assert.match(page, /function TeamRankingHero/);
  assert.match(page, /<section className="border-border\/80 bg-card rounded-xl border px-5 py-5">/);
  assert.match(page, /<TeamRankingHero[\s\S]*totalCost=\{rankedCost\}[\s\S]*rankCount=\{rows\.length\}[\s\S]*totalSessions=\{rankedSessions\}/);
  assert.match(page, /data-dashboard-ready="team-overview" className="space-y-6"/);
  assert.doesNotMatch(page, /data-dashboard-ready="team-overview" className="contents"/);
});
```

- [ ] **Step 2: 테스트가 기능 부재 때문에 실패하는지 확인한다**

Run:

```bash
node --import tsx --test apps/web/lib/ui-commonization.test.ts
```

Expected: 새 테스트가 `function TeamRankingHero`를 찾지 못해 FAIL하고 기존 테스트는 PASS한다.

---

### Task 2: 대표 카드와 분석 섹션 간격 구현

**Files:**
- Modify: `apps/web/app/(dashboard)/org/teams/page.tsx`
- Test: `apps/web/lib/ui-commonization.test.ts`

**Interfaces:**
- Consumes: 기존 `SummaryTile`, `rankedCost`, `rows.length`, `rankedSessions`, 1위 비용 점유율
- Produces: `TeamRankingHero`와 명시적인 `space-y-6` 팀별 현황 콘텐츠 스택

- [ ] **Step 1: `TeamRankingHero` 표현 컴포넌트를 추가한다**

```tsx
function TeamRankingHero({
  totalCost,
  coverage,
  costLabels,
  rankCount,
  totalSessions,
  topShare,
  totalCostLabel,
  totalCostSub,
  rankCountLabel,
  rankCountSub,
  totalSessionsLabel,
  totalSessionsSub,
  topShareLabel,
  topShareSub,
}: {
  totalCost: number;
  coverage: LeaderRow["costCoverage"];
  costLabels: CostLabels;
  rankCount: number;
  totalSessions: number;
  topShare: string;
  totalCostLabel: string;
  totalCostSub: string;
  rankCountLabel: string;
  rankCountSub: string;
  totalSessionsLabel: string;
  totalSessionsSub: string;
  topShareLabel: string;
  topShareSub: string;
}) {
  return (
    <section className="border-border/80 bg-card rounded-xl border px-5 py-5">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div className="min-w-0">
          <div className="text-muted-foreground text-xs tracking-wide uppercase">{totalCostLabel}</div>
          <div className="mt-2 text-4xl font-semibold tracking-tight tabular-nums">
            {formatCostForCoverage(fmtUsd(totalCost), coverage, costLabels)}
          </div>
          <div className="text-muted-foreground mt-1 text-xs">{totalCostSub}</div>
        </div>
        <div className="grid w-full gap-4 sm:grid-cols-3 xl:w-auto xl:min-w-[520px]">
          <SummaryTile label={rankCountLabel} value={fmtNum(rankCount)} sub={rankCountSub} icon={<Trophy className="size-3.5" />} />
          <SummaryTile label={totalSessionsLabel} value={fmtNum(totalSessions)} sub={totalSessionsSub} icon={<Activity className="size-3.5" />} />
          <SummaryTile label={topShareLabel} value={topShare} sub={topShareSub} icon={<TrendingUp className="size-3.5" />} />
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 2: 기존 상단 네 칸 그리드를 대표 카드 호출로 교체한다**

```tsx
<TeamRankingHero
  totalCost={rankedCost}
  coverage={coverage}
  costLabels={costLabels}
  rankCount={rows.length}
  totalSessions={rankedSessions}
  topShare={rows[0] && coverage.unpricedEvents === 0 ? shareText(rows[0].costUsd, rankedCost) : "—"}
  totalCostLabel={t("ranking.totalCost")}
  totalCostSub={rankedCostSub}
  rankCountLabel={t("ranking.rankCount")}
  rankCountSub={t("ranking.rankCountSub", { scope: scopeLabel })}
  totalSessionsLabel={t("ranking.totalSessions")}
  totalSessionsSub={t("ranking.totalSessionsSub")}
  topShareLabel={t("ranking.topShare")}
  topShareSub={rows[0] ? t("ranking.topShareSub", { name: rows[0].label }) : t("ranking.noLeader")}
/>
```

- [ ] **Step 3: 콘텐츠 래퍼와 분석 카드 열 비율을 조정한다**

```tsx
<div data-dashboard-ready="team-overview" className="space-y-6">
```

```tsx
<div className="grid min-w-0 gap-4 2xl:grid-cols-[minmax(0,1fr)_minmax(0,1.08fr)]">
```

- [ ] **Step 4: 계약 테스트가 통과하는지 확인한다**

Run:

```bash
node --import tsx --test apps/web/lib/ui-commonization.test.ts
```

Expected: 51 tests PASS, 0 FAIL.

- [ ] **Step 5: 구현을 커밋한다**

```bash
git add apps/web/app/'(dashboard)'/org/teams/page.tsx apps/web/lib/ui-commonization.test.ts
git commit -m "style(team): 팀별 현황 카드 위계 통일"
```

---

### Task 3: 정적·시각 검증

**Files:**
- Verify: `apps/web/app/(dashboard)/org/teams/page.tsx`
- Verify: `apps/web/lib/ui-commonization.test.ts`

**Interfaces:**
- Consumes: Task 2의 최종 구현
- Produces: PR과 릴리스에 사용할 검증 근거

- [ ] **Step 1: 웹 전체 테스트를 직접 실행한다**

```bash
node --import tsx --test apps/web/lib/*.test.ts apps/web/components/**/*.test.ts apps/web/components/**/*.test.tsx apps/web/app/**/*.test.ts
```

Expected: 0 FAIL.

- [ ] **Step 2: 웹 TypeScript 검사를 실행한다**

```bash
./node_modules/.bin/tsc -p apps/web/tsconfig.json --noEmit
```

Expected: exit 0, TypeScript errors 없음.

- [ ] **Step 3: 공백과 변경 범위를 확인한다**

```bash
git diff --check
git status --short
git diff origin/main...HEAD --stat
```

Expected: 공백 오류 없음. 설계·계획·팀별 현황 페이지·계약 테스트만 변경됨.

- [ ] **Step 4: 실제 브라우저에서 데스크톱과 390px 화면을 확인한다**

확인 항목:

- 상단 네 지표가 하나의 대표 카드 안에 표시된다.
- `상위 팀`, `비용 분포`, `팀 상세 순위` 사이에 독립적인 카드 간격이 보인다.
- `팀 현황`의 카드 배경, 테두리, 라운드와 시각 문법이 일치한다.
- 390px에서 겹침, 잘림, 가로 스크롤이 없다.

---

### Task 4: PR 병합과 v0.15.34 릴리스

**Files:**
- No production source changes expected
- Produces: merged PR, `v0.15.34` tag, GitHub Release, tag workflow evidence

**Interfaces:**
- Consumes: 검증 완료된 feature branch
- Produces: `main` 병합 커밋과 공개 릴리스

- [ ] **Step 1: detached HEAD에서 기능 브랜치를 만들고 푸시한다**

```bash
git switch -c codex/team-overview-card-hierarchy
git push -u origin codex/team-overview-card-hierarchy
```

- [ ] **Step 2: ready PR을 생성하고 검증 내용을 기록한다**

PR title:

```text
팀별 현황 카드 위계 통일
```

PR 본문에는 대표 카드 도입, 분석 카드 간격 정리, 기존 데이터 로직 보존, 실행한 테스트·타입 검사를 기록한다.

- [ ] **Step 3: 필수 PR 체크가 성공할 때까지 확인하고 PR을 병합한다**

```bash
gh pr checks --watch --interval 10
gh pr merge --merge --delete-branch
```

Expected: 필수 체크 0 failures, PR state `MERGED`.

- [ ] **Step 4: 최신 `origin/main` 병합 커밋에 v0.15.34 태그를 생성한다**

```bash
git fetch origin main --tags
git tag -a v0.15.34 origin/main -m "v0.15.34"
git push origin v0.15.34
```

- [ ] **Step 5: 태그 기반 워크플로와 릴리스 자산을 검증한다**

```bash
gh run list --branch v0.15.34 --limit 10
gh run watch <shim-release-run-id>
gh run watch <docker-publish-run-id>
gh release view v0.15.34 --json tagName,isLatest,isDraft,url,assets
```

Expected: `shim-release`와 `docker-publish` 성공, GitHub Release가 draft가 아니며 `v0.15.34` 자산을 포함함.

## Plan Self-Review

- 설계의 대표 카드, 분석 카드 간격, 반응형, 비범위 요구사항이 Task 1–3에 대응한다.
- 테스트가 먼저 실패한 뒤 최소 구현으로 통과하도록 Task 1–2 순서를 고정했다.
- 데이터 계산, 번역, 차트, 다른 페이지를 변경하는 단계가 없다.
- 배포는 PR 체크 성공과 병합 확인 뒤에만 태그를 생성한다.
- 최신 릴리스 `v0.15.33`의 다음 patch 버전인 `v0.15.34`를 사용한다.
