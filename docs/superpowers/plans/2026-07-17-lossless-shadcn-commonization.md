# Lossless shadcn Commonization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the current rendered UI while replacing safe custom foundations with official shadcn components and removing repeated product UI implementations.

**Architecture:** Official shadcn `new-york` primitives live in `components/ui`. Thin toard wrappers preserve the existing public APIs and exact visual classes. Page components consume those wrappers, and source/render contracts plus before/after screenshots protect the no-visual-change requirement.

**Tech Stack:** Next.js 15, React 19, Tailwind CSS 4, shadcn/ui `new-york`, Radix UI, Node test runner, TypeScript.

## Global Constraints

- The rendered color, spacing, typography, border, shadow, and responsive layout must not intentionally change.
- Prefer official shadcn primitives when they can preserve the current result.
- Do not redesign status colors, chart colors, provider colors, or dashboard hierarchy.
- Do not force `ButtonGroup`, `Tabs`, `Table`, or `Checkbox` where their behavior or layout changes the current UI.
- Write a failing contract test before each production refactor.

---

### Task 1: Establish the no-visual-change contract

**Files:**
- Create: `apps/web/lib/shadcn-commonization.test.ts`
- Test: `apps/web/lib/shadcn-commonization.test.ts`

**Interfaces:**
- Consumes: repository source files through `readFileSync`.
- Produces: source contracts requiring shadcn primitives and removal of repeated page-local components.

- [ ] **Step 1: Write failing source contracts**

Add tests that require:

```ts
assert.match(source("components/ui/alert.tsx"), /data-slot="alert"/);
assert.match(source("components/ui/toggle-group.tsx"), /ToggleGroupPrimitive/);
assert.match(source("components/ui/field.tsx"), /data-slot="field"/);
assert.match(source("components/ui/segmented-control.tsx"), /@\/components\/ui\/toggle-group/);
assert.match(source("components/dashboard/settings-row.tsx"), /@\/components\/ui\/field/);
assert.doesNotMatch(source("app/(dashboard)/org/page.tsx"), /function SummaryTile/);
assert.doesNotMatch(source("app/(dashboard)/org/team/page.tsx"), /function SupportingMetric/);
```

- [ ] **Step 2: Verify RED**

Run:

```bash
cd apps/web
node --import tsx --test lib/shadcn-commonization.test.ts
```

Expected: FAIL because the official primitives and shared metric files do not exist yet.

### Task 2: Add official shadcn Alert and migrate callouts

**Files:**
- Create: `apps/web/components/ui/alert.tsx`
- Modify: `apps/web/components/dashboard/pricing-notice.tsx`
- Modify: `apps/web/app/(dashboard)/admin/page.tsx`
- Modify: `apps/web/app/(dashboard)/admin/invite-panel.tsx`
- Test: `apps/web/lib/shadcn-commonization.test.ts`

**Interfaces:**
- Produces: `Alert`, `AlertTitle`, and `AlertDescription`.
- Preserves: existing callout children and exact use-site class strings.

- [ ] **Step 1: Extend the failing test**

Require every targeted callout file to import `@/components/ui/alert` and reject the old root
`<div className="...border-amber...">` or `<div className="...border-emerald...">` form.

- [ ] **Step 2: Verify RED**

Run the single contract test and confirm it fails on the missing imports.

- [ ] **Step 3: Add the official component**

Copy the official `new-york-v4` Alert implementation from:

```text
https://ui.shadcn.com/r/styles/new-york-v4/alert.json
```

Change only the repository import path to `@/lib/utils`.

- [ ] **Step 4: Migrate callout roots**

Replace only the root element:

```tsx
<Alert className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
```

and:

```tsx
<Alert className="block rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3 text-sm">
```

Keep all current descendants and classes unchanged.

- [ ] **Step 5: Verify GREEN**

Run the contract test and `./node_modules/.bin/tsc --noEmit`.

### Task 3: Add official Toggle and ToggleGroup beneath current controls

**Files:**
- Create: `apps/web/components/ui/toggle.tsx`
- Create: `apps/web/components/ui/toggle-group.tsx`
- Modify: `apps/web/components/ui/segmented-control.tsx`
- Modify: `apps/web/app/(dashboard)/settings/appearance-form.tsx`
- Test: `apps/web/lib/shadcn-commonization.test.ts`

**Interfaces:**
- Produces: official `Toggle`, `ToggleGroup`, and `ToggleGroupItem`.
- Preserves: `SegmentedControl<T>` props and appearance.

- [ ] **Step 1: Extend the failing test**

Require `SegmentedControl` to render `ToggleGroup type="single"` and the appearance swatches to
import `Toggle`.

- [ ] **Step 2: Verify RED**

Run the contract test and confirm the missing primitives cause the failure.

- [ ] **Step 3: Add official primitives**

Copy `toggle.tsx` and `toggle-group.tsx` from the official `new-york-v4` registry. Change the
registry-relative toggle import to:

```ts
import { toggleVariants } from "@/components/ui/toggle";
```

- [ ] **Step 4: Preserve SegmentedControl styling**

Keep the existing public props. Render:

```tsx
<ToggleGroup
  type="single"
  value={value}
  spacing={1}
  onValueChange={(next) => {
    if (next && next !== value) onValueChange(next as T);
  }}
  className={cn(
    "border-input inline-flex max-w-full items-center gap-0.5 rounded-md border p-0.5",
    className,
  )}
>
```

Each item keeps the current `h-7`, `rounded-sm`, `px-2.5`, `text-xs`, selected background, hover,
focus, disabled, icon, and truncation classes. Add explicit state overrides so the official Toggle
defaults do not introduce a new background or radius.

- [ ] **Step 5: Move color swatches onto Toggle**

Use controlled `pressed={brand === preset}` and preserve the existing `size-6`, rounded-full,
hover-scale, ring, inline background style, icon, and labels.

- [ ] **Step 6: Verify GREEN**

Run the contract test, the existing commonization test, and typecheck.

### Task 4: Base settings rows on official shadcn Field

**Files:**
- Create: `apps/web/components/ui/field.tsx`
- Modify: `apps/web/components/dashboard/settings-row.tsx`
- Modify: `apps/web/app/(dashboard)/settings/appearance-form.tsx`
- Modify: `apps/web/app/(dashboard)/settings/page.tsx`
- Test: `apps/web/lib/shadcn-commonization.test.ts`

**Interfaces:**
- `SettingsRow` adds `layout?: "compact" | "settings"` and `align?: "center" | "start"`.
- `compact` preserves the existing admin `sm:w-52` flex layout.
- `settings` preserves the user settings `lg:grid-cols-[16rem_minmax(0,1fr)]` layout.

- [ ] **Step 1: Extend the failing test**

Require `SettingsRow` to import `Field`, and reject direct `16rem` setting sections from
`appearance-form.tsx` and the login-method section of `settings/page.tsx`.

- [ ] **Step 2: Verify RED**

Run the contract test and confirm it fails on the direct sections.

- [ ] **Step 3: Add the official Field implementation**

Copy `field.tsx` from the official `new-york-v4` registry and change imports to local
`@/components/ui/label`, `@/components/ui/separator`, and `@/lib/utils`.

- [ ] **Step 4: Rebuild SettingsRow without visual changes**

Use `Field` as the root but pass the exact current compact or settings layout classes. Use
`FieldContent`, `FieldTitle`, and `FieldDescription` with explicit classes matching the existing
title and description typography. Keep children in the same responsive alignment container.

- [ ] **Step 5: Replace direct setting sections**

Use `layout="settings"` for appearance, Google login, and password rows. Preserve all existing
child controls and their class names.

- [ ] **Step 6: Verify GREEN**

Run the contract test, commonization test, and typecheck.

### Task 5: Extract repeated organization metrics

**Files:**
- Create: `apps/web/components/dashboard/summary-tile.tsx`
- Create: `apps/web/components/dashboard/supporting-metric.tsx`
- Modify: `apps/web/app/(dashboard)/org/page.tsx`
- Modify: `apps/web/app/(dashboard)/org/team/page.tsx`
- Modify: `apps/web/app/(dashboard)/org/teams/page.tsx`
- Test: `apps/web/lib/shadcn-commonization.test.ts`

**Interfaces:**
- `SummaryTile({ label, value, sub?, icon? })`
- `SupportingMetric({ label, value, sub, icon })`

- [ ] **Step 1: Extend the failing test**

Require the three pages to import the shared components and reject page-local functions.

- [ ] **Step 2: Verify RED**

Run the contract test and confirm the local functions trigger the failure.

- [ ] **Step 3: Move SummaryTile exactly**

Move the existing markup and class strings without alteration into the new shared file.

- [ ] **Step 4: Move SupportingMetric onto Card**

Use:

```tsx
<Card className="border-border/80 bg-card min-w-0 gap-0 rounded-xl border px-4 py-4 shadow-sm">
```

Keep its three child rows and classes unchanged.

- [ ] **Step 5: Replace local functions**

Import shared components and delete only the duplicated declarations.

- [ ] **Step 6: Verify GREEN**

Run the contract test, organization-related tests, and typecheck.

### Task 6: Verify the full repository and rendered result

**Files:**
- Modify only if a visual mismatch requires a class-preserving correction.

**Interfaces:**
- Consumes: all changes from Tasks 1-5.
- Produces: test and screenshot evidence.

- [ ] **Step 1: Run full web tests**

```bash
cd apps/web
node --import tsx --test 'lib/*.test.ts' 'components/**/*.test.ts' 'components/**/*.test.tsx' 'app/**/*.test.ts'
```

Expected: 0 failures.

- [ ] **Step 2: Run typecheck and whitespace validation**

```bash
cd apps/web
./node_modules/.bin/tsc --noEmit
cd ../..
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 3: Capture the same seeded pages**

Use an isolated temporary PostgreSQL instance and `scripts/seed-dashboard-demo.ts`. Start the app
with `AUTH_MODE=open` and the seeded viewer. Capture the same routes, viewport sizes, themes, and
browser build used for the baseline.

- [ ] **Step 4: Compare before and after**

Inspect pixel diffs and the rendered pages. Any layout, color, font, border, shadow, or responsive
difference caused by this refactor must be corrected or the relevant shadcn migration removed.

- [ ] **Step 5: Review the final diff**

Confirm that changes are limited to official primitives, thin wrappers, repeated component
extraction, tests, and these design/plan documents.
