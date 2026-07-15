# shadcn Date Range Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dashboard's two native date inputs with one localized shadcn range calendar while preserving the existing custom-period URL and server behavior.

**Architecture:** Keep dashboard query state as `YYYY-MM-DD` strings and isolate Calendar `Date` conversion in a pure adapter that never calls `toISOString()`. Compose a focused `DateRangePicker` from shadcn `Popover` and `Calendar`, then let `DashboardFilters` translate between the picker draft and the existing `from`/`to` state.

**Tech Stack:** Next.js 15, React 19, TypeScript, Tailwind CSS 4, shadcn/ui new-york, Radix UI, React DayPicker, next-intl, Node test runner

## Global Constraints

- Preserve `period=custom&from=YYYY-MM-DD&to=YYYY-MM-DD` and all server-side timezone interpretation.
- Support same-day ranges, Korean and English locale, keyboard navigation, dark mode, and narrow screens.
- Keep the explicit Apply action; do not mutate the URL while the draft range is incomplete.
- Render one month at a time; do not add a two-month desktop variant.
- Do not use `Date.prototype.toISOString()` in date-key conversion.
- Release the merged change as `v0.15.26` and verify both tag workflows and release artifacts.

---

## File Map

- Create `apps/web/lib/date-range.ts`: validated date-key and Calendar `Date` adapter.
- Create `apps/web/lib/date-range.test.ts`: date conversion and completion contracts.
- Create `apps/web/components/dashboard/date-range-picker.tsx`: reusable shadcn range picker.
- Create `apps/web/components/dashboard/date-range-picker.test.tsx`: server-rendered component contract.
- Create `apps/web/components/dashboard/dashboard-filters.test.ts`: regression contract for removal of native date inputs.
- Create `apps/web/components/ui/calendar.tsx`: shadcn Calendar component generated for this project.
- Create `apps/web/components/ui/popover.tsx`: shadcn Popover component generated for this project.
- Modify `apps/web/components/dashboard/dashboard-filters.tsx`: replace native inputs and bridge string state.
- Modify `apps/web/messages/ko/dashboard.json`: Korean range labels.
- Modify `apps/web/messages/en/dashboard.json`: English range labels.
- Modify `apps/web/package.json`: component-test glob and Calendar dependencies.
- Modify `pnpm-lock.yaml`: locked dependency graph.

---

### Task 1: Add the timezone-safe date-key adapter

**Files:**
- Create: `apps/web/lib/date-range.test.ts`
- Create: `apps/web/lib/date-range.ts`

**Interfaces:**
- Produces: `CalendarRange = { from?: Date; to?: Date }`
- Produces: `dateKeyToCalendarDate(value: string): Date | undefined`
- Produces: `calendarDateToDateKey(value: Date): string`
- Produces: `dateKeysToCalendarRange(from: string, to: string): CalendarRange | undefined`
- Produces: `calendarRangeToDateKeys(range: CalendarRange | undefined): { from: string; to: string } | undefined`
- Produces: `isCompleteCalendarRange(range: CalendarRange | undefined): boolean`

- [ ] **Step 1: Write the failing adapter tests**

Create `apps/web/lib/date-range.test.ts` with Node `test` and `assert` cases for:

```ts
assert.equal(calendarDateToDateKey(new Date(2026, 6, 15, 12)), "2026-07-15");
assert.equal(dateKeyToCalendarDate("2024-02-29")?.getDate(), 29);
assert.equal(dateKeyToCalendarDate("2025-02-29"), undefined);
assert.equal(dateKeyToCalendarDate("2026-13-01"), undefined);
assert.deepEqual(
  calendarRangeToDateKeys({ from: new Date(2026, 6, 31, 12), to: new Date(2026, 7, 1, 12) }),
  { from: "2026-07-31", to: "2026-08-01" },
);
assert.equal(isCompleteCalendarRange({ from: new Date(2026, 6, 15, 12) }), false);
assert.equal(
  isCompleteCalendarRange({ from: new Date(2026, 6, 15, 12), to: new Date(2026, 6, 15, 12) }),
  true,
);
```

- [ ] **Step 2: Run the adapter test and verify RED**

Run: `pnpm --filter @toard/web exec node --import tsx --test lib/date-range.test.ts`

Expected: FAIL because `./date-range` does not exist. The missing module is the unimplemented feature, not a path typo.

- [ ] **Step 3: Implement the minimal adapter**

Create `apps/web/lib/date-range.ts` with strict `YYYY-MM-DD` parsing. Construct valid values with `new Date(year, month - 1, day, 12)` and reject overflow by comparing local getters back to the parsed values. Format with zero-padded local getters. Preserve `{ from }` when the end key is empty so the first range click remains selected; reject a non-empty invalid end key. Return date keys only for complete ranges.

The implementation must not reference `toISOString`.

- [ ] **Step 4: Run the adapter test and verify GREEN**

Run: `pnpm --filter @toard/web exec node --import tsx --test lib/date-range.test.ts`

Expected: PASS with all adapter cases green.

- [ ] **Step 5: Commit the adapter**

```bash
git add apps/web/lib/date-range.ts apps/web/lib/date-range.test.ts
git commit -m "feat(ui): 날짜 범위 변환기를 추가"
```

---

### Task 2: Add shadcn Calendar, Popover, and the reusable range picker

**Files:**
- Create: `apps/web/components/ui/calendar.tsx`
- Create: `apps/web/components/ui/popover.tsx`
- Create: `apps/web/components/dashboard/date-range-picker.test.tsx`
- Create: `apps/web/components/dashboard/date-range-picker.tsx`
- Modify: `apps/web/package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: `CalendarRange` from `@/lib/date-range`
- Produces: `DateRangePicker({ range, onSelect, locale, ariaLabel, placeholder })`
- Produces: a `data-slot="date-range-picker"` outline trigger and one-month range Calendar

- [ ] **Step 1: Install locked Calendar dependencies without adding product components**

Run:

```bash
pnpm --filter @toard/web add react-day-picker date-fns
```

Expected: `apps/web/package.json` and `pnpm-lock.yaml` add only the runtime dependencies required by the official shadcn Calendar.

- [ ] **Step 2: Extend the web test glob and write the failing component test**

Change the web test script to:

```json
"test": "node --import tsx --test 'lib/*.test.ts' 'components/**/*.test.ts' 'components/**/*.test.tsx' 'app/**/*.test.ts'"
```

Create `date-range-picker.test.tsx` using `renderToStaticMarkup` and assert that a completed range renders:

```ts
assert.match(html, /data-slot="date-range-picker"/);
assert.match(html, /2026\. 7\. 12\./);
assert.match(html, /2026\. 7\. 15\./);
assert.match(html, /aria-label="날짜 범위"/);
assert.doesNotMatch(html, /type="date"/);
```

- [ ] **Step 3: Run the component test and verify RED**

Run: `pnpm --filter @toard/web exec node --import tsx --test components/dashboard/date-range-picker.test.tsx`

Expected: FAIL because `date-range-picker.tsx` does not exist.

- [ ] **Step 4: Generate the project-matched shadcn components**

Run from `apps/web`:

```bash
pnpm dlx shadcn@latest add calendar popover --yes
```

Expected: creates `components/ui/calendar.tsx` and `components/ui/popover.tsx` using `components.json`; it must not overwrite unrelated UI files. Inspect the diff before continuing.

- [ ] **Step 5: Implement the minimal DateRangePicker**

Create a client component that:

```tsx
<Popover>
  <PopoverTrigger asChild>
    <Button data-slot="date-range-picker" variant="outline" aria-label={ariaLabel}>
      <CalendarIcon />
      {formattedRangeOrPlaceholder}
    </Button>
  </PopoverTrigger>
  <PopoverContent align="start" className="w-auto max-w-[calc(100vw-2rem)] p-0">
    <Calendar
      mode="range"
      numberOfMonths={1}
      selected={range}
      onSelect={onSelect}
      locale={locale === "ko" ? ko : enUS}
      initialFocus
    />
  </PopoverContent>
</Popover>
```

Format the button with `Intl.DateTimeFormat(locale, { year: "numeric", month: "numeric", day: "numeric" })`. Use the existing outline Button classes and `cn`; do not add a parallel design system.

- [ ] **Step 6: Run the component test and verify GREEN**

Run: `pnpm --filter @toard/web exec node --import tsx --test components/dashboard/date-range-picker.test.tsx`

Expected: PASS and no native date input in the rendered trigger contract.

- [ ] **Step 7: Run typecheck and commit the reusable picker**

Run: `pnpm --filter @toard/web typecheck`

Expected: exit 0.

```bash
git add apps/web/package.json pnpm-lock.yaml apps/web/components/ui/calendar.tsx apps/web/components/ui/popover.tsx apps/web/components/dashboard/date-range-picker.tsx apps/web/components/dashboard/date-range-picker.test.tsx
git commit -m "feat(ui): shadcn 날짜 범위 선택기를 추가"
```

---

### Task 3: Replace DashboardFilters native date inputs

**Files:**
- Create: `apps/web/components/dashboard/dashboard-filters.test.ts`
- Modify: `apps/web/components/dashboard/dashboard-filters.tsx`
- Modify: `apps/web/messages/ko/dashboard.json`
- Modify: `apps/web/messages/en/dashboard.json`

**Interfaces:**
- Consumes: `dateKeysToCalendarRange`, `calendarRangeToDateKeys`, and `DateRangePicker`
- Preserves: `applyCustom()` URL output and the existing `from`/`to` string state

- [ ] **Step 1: Write the failing regression test against the current source**

Create `dashboard-filters.test.ts` that reads `dashboard-filters.tsx` through `new URL(..., import.meta.url)` and asserts:

```ts
assert.doesNotMatch(source, /type=["']date["']/);
assert.match(source, /<DateRangePicker/);
assert.match(source, /calendarRangeToDateKeys/);
```

This intentionally protects the exact regression visible in the original screenshot.

- [ ] **Step 2: Run the regression test and verify RED**

Run: `pnpm --filter @toard/web exec node --import tsx --test components/dashboard/dashboard-filters.test.ts`

Expected: FAIL because the source still contains two `type="date"` inputs.

- [ ] **Step 3: Add localized copy**

Add under `dashboard.filters`:

```json
// ko
"dateRange": "날짜 범위",
"selectDateRange": "날짜 범위 선택"

// en
"dateRange": "Date range",
"selectDateRange": "Select date range"
```

- [ ] **Step 4: Integrate the picker with existing draft state**

Remove the `Input` import and both native inputs. Derive `draftRange` with `useMemo(() => dateKeysToCalendarRange(from, to), [from, to])`. On selection, convert the selected range back to keys; set the selected start key immediately and set the end key to an empty string until the range completes. Render:

```tsx
<DateRangePicker
  range={draftRange}
  onSelect={selectCustomRange}
  locale={locale}
  ariaLabel={t("filters.dateRange")}
  placeholder={t("filters.selectDateRange")}
/>
<Button size="sm" onClick={applyCustom} disabled={!from || !to}>
  {t("filters.apply")}
</Button>
```

Keep the existing flex-wrap container, explicit Apply action, and `applyCustom` URL logic unchanged.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
pnpm --filter @toard/web exec node --import tsx --test lib/date-range.test.ts components/dashboard/date-range-picker.test.tsx components/dashboard/dashboard-filters.test.ts
```

Expected: all focused tests PASS.

- [ ] **Step 6: Run web typecheck and commit the integration**

Run: `pnpm --filter @toard/web typecheck`

Expected: exit 0.

```bash
git add apps/web/components/dashboard/dashboard-filters.tsx apps/web/components/dashboard/dashboard-filters.test.ts apps/web/messages/ko/dashboard.json apps/web/messages/en/dashboard.json
git commit -m "fix(ui): 네이티브 날짜 입력을 범위 달력으로 교체"
```

---

### Task 4: Verify behavior, visuals, and repository gates

**Files:**
- Modify only if a failing verification reveals an in-scope defect.

- [ ] **Step 1: Run fresh focused web verification**

```bash
pnpm --filter @toard/web test
pnpm --filter @toard/web typecheck
pnpm --filter @toard/web build
```

Expected: every command exits 0 with no failed tests or TypeScript/build errors.

- [ ] **Step 2: Run full repository CI-equivalent verification**

```bash
pnpm typecheck
pnpm test
git diff --check origin/main...HEAD
```

Expected: all workspaces and migration integration tests pass; diff check is empty.

- [ ] **Step 3: Verify the real browser surface**

Start the existing local app or isolated preview without printing secrets. Verify:

- Korean and English month/day labels.
- Light and dark mode tokens.
- Desktop width and a narrow viewport.
- Same-day range and a range crossing a month boundary.
- Apply remains disabled for an incomplete range.
- Apply produces the original `period=custom&from=...&to=...` URL.
- The browser-native date picker never appears.

Capture screenshots for the handoff evidence.

- [ ] **Step 4: Review the final diff and commit verification-only fixes if needed**

Run: `git status --short && git diff origin/main...HEAD --stat && git diff --check origin/main...HEAD`

If verification required a code fix, repeat its focused red-green test and commit with a Korean Conventional Commit message. Otherwise leave the three implementation commits unchanged.

---

### Task 5: Publish, merge, tag, and verify v0.15.26

**Files:**
- No source changes expected.

- [ ] **Step 1: Push the feature branch**

Run: `git push -u origin feat/shadcn-date-range-picker`

Expected: remote branch points to the fully verified local HEAD.

- [ ] **Step 2: Create the pull request**

Use title `fix(ui): 네이티브 날짜 입력을 범위 달력으로 교체` and the required body sections:

```markdown
## 목적
브라우저별 네이티브 날짜 팝업을 toard 디자인과 일치하는 shadcn 범위 선택기로 교체합니다.

## 내용(의도 포함)
- 단일 Popover + Calendar 범위 선택기 적용
- 날짜 키 변환 시 UTC 이동 방지
- 기존 custom period URL 및 명시적 적용 동작 유지

## 성공기준
- focused web test, web typecheck/build, 전체 typecheck/test 통과
- 한국어·영어, 라이트·다크, 좁은 폭 및 실제 URL 적용 확인
```

- [ ] **Step 3: Wait for PR checks and merge**

Run `gh pr checks <number> --watch`, require `ci` and `shim-ci` success, then merge with the repository's allowed merge method. Verify `origin/main` contains the merge commit before tagging.

- [ ] **Step 4: Create and push the release tag**

```bash
git fetch origin main --tags
git tag -a v0.15.26 origin/main -m "v0.15.26"
git push origin v0.15.26
```

Expected: tag points exactly to the merged `origin/main` commit.

- [ ] **Step 5: Monitor tag workflows to completion**

Find the tag-triggered `shim-release` and `docker-publish` runs with `gh run list`, then watch both. Require successful completion of release asset publishing and all three amd64/arm64 image manifests.

- [ ] **Step 6: Verify published artifacts**

```bash
gh release view v0.15.26 --json tagName,isLatest,isDraft,url,assets
docker buildx imagetools inspect ghcr.io/devy1540/toard:0.15.26
docker buildx imagetools inspect ghcr.io/devy1540/toard-migrate:0.15.26
docker buildx imagetools inspect ghcr.io/devy1540/toard-updater:0.15.26
```

Expected: immutable GitHub Release is published/latest and each image manifest contains `linux/amd64` and `linux/arm64`.
