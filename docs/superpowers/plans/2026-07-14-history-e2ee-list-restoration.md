# E2EE History List Restoration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/history` 새로고침 오류와 중복 목록을 제거하고 E2EE 목록을 기존 히스토리의 필터·날짜 그룹·메타데이터·페이지네이션 디자인으로 복원한다.

**Architecture:** 서버 페이지가 계정의 E2EE 상태에 따라 E2EE와 레거시 화면 중 하나만 선택한다. E2EE 세션 API는 암호문 대표 레코드와 비민감 사용량 메타데이터만 반환하고, 브라우저가 현재 페이지의 미리보기만 복호화한다. 공용 목록 컴포넌트가 레거시와 E2EE 데이터를 같은 행 구조로 렌더링한다.

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript, PostgreSQL, Tailwind CSS, node:test, next-intl

## Global Constraints

- 프롬프트·응답 평문은 브라우저에서만 복호화한다.
- 한 페이지에 20건을 표시한다.
- nonce 기반 CSP는 유지하고 Trusted Types 강제만 제거한다.
- E2EE 키·복구키·승인 기기 구조는 변경하지 않는다.
- 데스크톱과 좁은 화면에서 긴 URL·Markdown이 가로 스크롤을 만들지 않아야 한다.

---

### Task 1: `/history` 응답 보안 정책 호환성 수정

**Files:**
- Create: `apps/web/lib/history-response-policy.ts`
- Create: `apps/web/lib/history-response-policy.test.ts`
- Modify: `apps/web/middleware.ts`

**Interfaces:**
- Produces: `createHistoryCsp(nonce: string): string`
- Produces: `HISTORY_CACHE_CONTROL = "no-store, no-transform"`

- [ ] **Step 1: Write the failing policy test**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { createHistoryCsp, HISTORY_CACHE_CONTROL } from "./history-response-policy";

test("history CSP keeps nonce protection without unsupported Trusted Types enforcement", () => {
  const csp = createHistoryCsp("nonce-value");
  assert.match(csp, /script-src 'self' 'nonce-nonce-value'/);
  assert.doesNotMatch(csp, /require-trusted-types-for/);
  assert.equal(HISTORY_CACHE_CONTROL, "no-store, no-transform");
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `pnpm --filter @toard/web exec node --import tsx --test lib/history-response-policy.test.ts`

Expected: FAIL because `history-response-policy.ts` does not exist.

- [ ] **Step 3: Extract the policy and update middleware**

```ts
export const HISTORY_CACHE_CONTROL = "no-store, no-transform";

export function createHistoryCsp(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join("; ");
}
```

`middleware.ts`는 위 함수를 사용하고 응답 `Cache-Control`을 `HISTORY_CACHE_CONTROL`로 설정한다.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `pnpm --filter @toard/web exec node --import tsx --test lib/history-response-policy.test.ts`

Expected: 1 test passed, 0 failed.

- [ ] **Step 5: Commit**

```bash
git add apps/web/middleware.ts apps/web/lib/history-response-policy.ts apps/web/lib/history-response-policy.test.ts
git commit -m "fix(history): 새로고침 CSP 호환성 복구"
```

### Task 2: E2EE 필터·페이지·사용량 메타데이터 API

**Files:**
- Modify: `apps/web/lib/e2ee-history.ts`
- Modify: `apps/web/lib/e2ee-history.test.ts`
- Modify: `apps/web/app/api/content/history/sessions/route.ts`
- Create: `apps/web/app/api/content/history/sessions/route.test.ts`

**Interfaces:**
- Consumes: `parseFilters(searchParams, timezone, "all")`
- Produces: `E2eeHistorySessionSummary.isSession: boolean`
- Produces: `E2eeHistorySessionSummary.usage: SessionUsageSummary | null`
- Produces: `HistoryOptions.filter?: { from: Date; to: Date; providerKey?: string }`

- [ ] **Step 1: Add failing query tests**

Extend the fake DB to capture parameters and verify:

```ts
const page = await getE2eeHistorySessions("user-1", {
  limit: 20,
  offset: 20,
  filter: {
    from: new Date("2026-07-01T00:00:00Z"),
    to: new Date("2026-08-01T00:00:00Z"),
    providerKey: "codex",
  },
}, db);

assert.equal(page.sessions[0]?.isSession, true);
assert.match(db.sql[0]!, /ts >=/);
assert.match(db.sql[0]!, /provider_key =/);
assert.deepEqual(db.params[0]?.slice(-3), ["codex", 20, 20]);
```

- [ ] **Step 2: Run the library test and verify RED**

Run: `pnpm --filter @toard/web exec node --import tsx --test lib/e2ee-history.test.ts`

Expected: FAIL because filters and `isSession` are not implemented.

- [ ] **Step 3: Implement filtered encrypted-session query**

Build SQL conditions and parameters without adding any decrypt operation:

```ts
const conditions = ["user_id = $1", "encryption_scheme = 'e2ee_v1'"];
if (filter) {
  params.push(filter.from, filter.to);
  conditions.push(`ts >= $${params.length - 1}`, `ts < $${params.length}`);
  if (filter.providerKey) {
    params.push(filter.providerKey);
    conditions.push(`provider_key = $${params.length}`);
  }
}
```

The grouped CTE adds `BOOL_OR(session_id IS NOT NULL) AS is_session`; the returned session maps it to `isSession`.

- [ ] **Step 4: Add failing route response test for usage joining**

Extract a pure helper with dependencies:

```ts
export async function loadE2eeHistoryPage(args: {
  userId: string;
  searchParams: URLSearchParams;
  timezone: string;
  loadSessions: typeof getE2eeHistorySessions;
  loadUsage: (userId: string, sessionIds: string[]) => Promise<SessionUsageSummary[]>;
}): Promise<E2eeHistoryPage>
```

The test supplies one session and one usage summary, then asserts `sessions[0].usage.models` and that only `isSession` keys are passed to `loadUsage`.

- [ ] **Step 5: Run route test and verify RED**

Run: `pnpm --filter @toard/web exec node --import tsx --test app/api/content/history/sessions/route.test.ts`

Expected: FAIL because `loadE2eeHistoryPage` is not exported.

- [ ] **Step 6: Implement route parsing and usage joining**

Use viewer timezone plus `parseFilters` with default `all`, clamp page to at least 1, request 20 rows, and join `getStorage().getSessionUsageSummaries` by session id. Never add plaintext fields to the response.

- [ ] **Step 7: Run focused tests and verify GREEN**

Run: `pnpm --filter @toard/web exec node --import tsx --test lib/e2ee-history.test.ts app/api/content/history/sessions/route.test.ts`

Expected: all tests passed, 0 failed.

- [ ] **Step 8: Commit**

```bash
git add apps/web/lib/e2ee-history.ts apps/web/lib/e2ee-history.test.ts apps/web/app/api/content/history/sessions/route.ts apps/web/app/api/content/history/sessions/route.test.ts
git commit -m "feat(history): E2EE 목록 필터와 사용량 메타데이터 추가"
```

### Task 3: 공용 히스토리 목록 UI 추출

**Files:**
- Create: `apps/web/app/(dashboard)/history/history-session-list.tsx`
- Create: `apps/web/app/(dashboard)/history/history-list-view.ts`
- Create: `apps/web/app/(dashboard)/history/history-list-view.test.ts`
- Modify: `apps/web/app/(dashboard)/history/page.tsx`

**Interfaces:**
- Produces: `HistoryListItem`
- Produces: `HistorySessionList(props)`
- Produces: `historyDayKey(timestamp: string, timezone: string): string`

- [ ] **Step 1: Write failing view-helper tests**

```ts
test("history day keys respect viewer timezone", () => {
  assert.equal(historyDayKey("2026-07-14T15:30:00Z", "Asia/Seoul"), "2026-07-15");
});

test("history pagination uses twenty rows", () => {
  assert.deepEqual(historyPagination(2, 45), { page: 2, totalPages: 3, hasPrev: true, hasNext: true });
});
```

- [ ] **Step 2: Run helper test and verify RED**

Run: `pnpm --filter @toard/web exec node --import tsx --test 'app/(dashboard)/history/history-list-view.test.ts'`

Expected: FAIL because helper module does not exist.

- [ ] **Step 3: Implement helpers and shared list component**

`HistoryListItem` contains serializable display data:

```ts
export interface HistoryListItem {
  key: string;
  href: string;
  providerKey: string;
  providerLabel: string;
  models: string[];
  preview: string;
  turnCount: number;
  totalTokens: number | null;
  hosts: string[];
  costLabel: string | null;
  latestTs: string;
}
```

`HistorySessionList` renders date headers, provider/model badges, a two-line `break-words` preview, metadata, cost/time, total count, and previous/next links. It uses the existing Tailwind classes from the legacy list so the visual result remains unchanged.

- [ ] **Step 4: Replace legacy inline list with shared component**

Map existing server sessions and usage summaries into `HistoryListItem[]`; preserve existing URLs, labels, cost coverage formatting, empty states, and filter toolbar.

- [ ] **Step 5: Run helper test and typecheck**

Run: `pnpm --filter @toard/web exec node --import tsx --test 'app/(dashboard)/history/history-list-view.test.ts'`

Run: `pnpm --filter @toard/web typecheck`

Expected: helper tests passed and TypeScript exits 0.

- [ ] **Step 6: Commit**

```bash
git add 'apps/web/app/(dashboard)/history/history-session-list.tsx' 'apps/web/app/(dashboard)/history/history-list-view.ts' 'apps/web/app/(dashboard)/history/history-list-view.test.ts' 'apps/web/app/(dashboard)/history/page.tsx'
git commit -m "refactor(history): 목록 UI를 공용 컴포넌트로 통합"
```

### Task 4: E2EE 화면을 기존 히스토리 디자인으로 전환

**Files:**
- Modify: `apps/web/app/(dashboard)/history/page.tsx`
- Modify: `apps/web/app/(dashboard)/history/e2ee-history-client.tsx`
- Modify: `apps/web/messages/ko/dashboard.json`
- Modify: `apps/web/messages/en/dashboard.json`

**Interfaces:**
- Consumes: `HistorySessionList`, `DashboardFilters`, `E2eeHistoryPage`
- Produces: active E2EE accounts render only `E2eeHistoryClient`

- [ ] **Step 1: Write a failing source contract test**

Add a node test that reads `page.tsx` and asserts the active E2EE branch returns before legacy `getMyHistorySessions`, and reads `e2ee-history-client.tsx` to assert it uses `DashboardFilters` and `HistorySessionList`. This test protects the duplicate-list regression without a browser DOM harness.

- [ ] **Step 2: Run the contract test and verify RED**

Run: `pnpm --filter @toard/web exec node --import tsx --test 'app/(dashboard)/history/e2ee-history-layout.test.ts'`

Expected: FAIL because the active branch and shared components are absent.

- [ ] **Step 3: Add server-side E2EE state branch**

Call `getE2eeContentStatus(userId)`. For `active` or `pending`, return a page containing only `E2eeHistoryClient` with providers, locale, timezone, title/status labels, and filter labels. For `off`, continue to the legacy code path.

- [ ] **Step 4: Rebuild E2EE list state and fetch flow**

Use `useSearchParams()` to forward `period`, `provider`, `from`, `to`, and `page` to the API. Fetch 20 rows, decrypt only `previewRecord`, format usage metadata, and map results to `HistoryListItem`. Preserve locking, migration, approval, recovery, and detail decryption effects.

- [ ] **Step 5: Render approved A layout**

Render one `DashboardFilters` toolbar. Place compact E2EE status and `지금 잠그기` in its trailing area. Render `HistorySessionList` under it, with the same empty-state distinction as legacy. Remove the separate `종단간 암호화 히스토리` heading and the old plain `<button>` row list.

- [ ] **Step 6: Run contract test and focused web tests**

Run: `pnpm --filter @toard/web exec node --import tsx --test 'app/(dashboard)/history/e2ee-history-layout.test.ts' lib/e2ee-history.test.ts app/api/content/history/sessions/route.test.ts lib/history-response-policy.test.ts`

Expected: all tests passed, 0 failed.

- [ ] **Step 7: Commit**

```bash
git add 'apps/web/app/(dashboard)/history/page.tsx' 'apps/web/app/(dashboard)/history/e2ee-history-client.tsx' 'apps/web/app/(dashboard)/history/e2ee-history-layout.test.ts' apps/web/messages/ko/dashboard.json apps/web/messages/en/dashboard.json
git commit -m "feat(history): E2EE 목록을 기존 디자인으로 복원"
```

### Task 5: 전체 검증과 실제 화면 확인

**Files:**
- Modify only if verification reveals a defect.

**Interfaces:**
- Consumes: completed Tasks 1-4
- Produces: evidence that all design requirements are met

- [ ] **Step 1: Run all web tests**

Run: `pnpm --filter @toard/web test`

Expected: 0 failed.

- [ ] **Step 2: Run static verification**

Run: `pnpm --filter @toard/web typecheck`

Run: `pnpm --filter @toard/web build`

Run: `git diff --check`

Expected: every command exits 0.

- [ ] **Step 3: Run local production-like app and inspect**

Start the existing local stack without deleting volumes. Open `/history` authenticated with a test account that has E2EE active. Verify direct load, browser refresh, period filter, provider filter, page navigation, session detail, lock/unlock, and that only one list is present.

- [ ] **Step 4: Check desktop and narrow widths**

Capture desktop and narrow-width screenshots. Confirm date groups, badges, two-line previews, metadata, cost/time, and pagination; confirm no horizontal overflow for long URL, Markdown, or XML previews.

- [ ] **Step 5: Audit plaintext boundary**

Inspect `/api/content/history/sessions` and server-rendered HTML in browser network tools. Confirm the response contains encrypted `previewRecord` plus metadata but no decrypted preview or turn text.

- [ ] **Step 6: Final commit if verification required fixes**

```bash
git add <only files changed by verification fixes>
git commit -m "fix(history): E2EE 목록 검증 오류 수정"
```
