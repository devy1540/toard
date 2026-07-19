# History Security Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace repeated history privacy paragraphs with one compact link to the existing history-security settings card.

**Architecture:** A shared server-renderable `HistorySecurityLink` component owns the destination, icon, and button style. Both history views render it, while the settings card exposes a stable `history-security` anchor and remains the single place for detailed trust-boundary copy.

**Tech Stack:** Next.js App Router, React, TypeScript, next-intl, lucide-react, Node test runner, pnpm 9.15.0

## Global Constraints

- The chosen design is C: history screens expose only a compact `보안 안내` / `Security info` link.
- The destination is exactly `/settings?tab=account#history-security`.
- Detailed DB, backup, KMS, and infrastructure-operator wording remains in `settings.historySecurity.privacyBoundary`.
- Encryption, authorization, storage, and data-query behavior must not change.
- Korean and English dashboard translation keys must remain symmetric.

---

### Task 1: Replace repeated privacy copy with the settings link

**Files:**
- Create: `apps/web/app/(dashboard)/history/history-security-link.tsx`
- Modify: `apps/web/app/(dashboard)/history/managed-history-privacy.test.ts`
- Modify: `apps/web/app/(dashboard)/history/page.tsx`
- Modify: `apps/web/app/(dashboard)/history/session-detail.tsx`
- Modify: `apps/web/app/(dashboard)/settings/history-security-panel.tsx`
- Modify: `apps/web/messages/ko/dashboard.json`
- Modify: `apps/web/messages/en/dashboard.json`

**Interfaces:**
- Consumes: translated link label from `dashboard.history.securityInfo`.
- Produces: `HistorySecurityLink({ label, className? }): ReactElement`, linking to `/settings?tab=account#history-security`.
- Produces: settings anchor `id="history-security"` on the history-security card.

- [ ] **Step 1: Write the failing behavior test**

Update `managed-history-privacy.test.ts` so the desired navigation and copy ownership are explicit:

```ts
const linkSource = readFileSync(new URL("./history-security-link.tsx", import.meta.url), "utf8");
const settingsPanelSource = readFileSync(
  new URL("../settings/history-security-panel.tsx", import.meta.url),
  "utf8",
);

test("history screens link to the detailed security settings instead of repeating privacy copy", () => {
  assert.equal(ko.history.securityInfo, "보안 안내");
  assert.equal(en.history.securityInfo, "Security info");
  assert.match(linkSource, /\/settings\?tab=account#history-security/);
  assert.match(settingsPanelSource, /id=["']history-security["']/);
  assert.match(pageSource, /<HistorySecurityLink/);
  assert.doesNotMatch(pageSource, /history\.(privacyNote|managedPrivacyNote|legacyPrivacyNote)/);
  assert.doesNotMatch(detailSource, /history\.(privacyNote|managedPrivacyNote|legacyPrivacyNote)/);
});
```

Retain the translation-key parity test and the disabled-decryption/not-found ordering test. Remove assertions that require the old repeated paragraphs.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
corepack pnpm --filter @toard/web exec node --import tsx --test 'app/(dashboard)/history/managed-history-privacy.test.ts'
```

Expected: FAIL because `history-security-link.tsx`, `securityInfo`, and the settings anchor do not exist yet.

- [ ] **Step 3: Add the minimal shared link component**

Create `history-security-link.tsx`:

```tsx
import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";

export function HistorySecurityLink({
  label,
  className,
}: {
  label: string;
  className?: string;
}) {
  return (
    <Button asChild size="sm" variant="ghost" className={className}>
      <Link href="/settings?tab=account#history-security">
        <ShieldCheck className="size-4" />
        {label}
      </Link>
    </Button>
  );
}
```

- [ ] **Step 4: Replace list and detail copy**

In `page.tsx`:

- Import `HistorySecurityLink`.
- Render it beside the title on the detail view with `className="ml-auto"`.
- Pass it as the list toolbar `trailing` value.
- Remove `Lock` from the page import if unused.
- Stop destructuring `hasManagedContent` and `hasLegacyContent` from `getMyHistorySessions`.

Use:

```tsx
<HistorySecurityLink label={t("history.securityInfo")} className="ml-auto" />
```

In `session-detail.tsx`, delete the repeated privacy paragraph block and stop destructuring `hasManagedContent` and `hasLegacyContent` from `getMyHistorySession`.

- [ ] **Step 5: Add the anchor and update translations**

Set the settings card root to:

```tsx
<Card id="history-security" className="min-w-0 scroll-mt-6">
```

Replace the three old dashboard history keys in both languages with:

```json
"securityInfo": "보안 안내"
```

and:

```json
"securityInfo": "Security info"
```

- [ ] **Step 6: Run the focused test and verify GREEN**

Run:

```bash
corepack pnpm --filter @toard/web exec node --import tsx --test 'app/(dashboard)/history/managed-history-privacy.test.ts'
```

Expected: all tests in the file PASS.

- [ ] **Step 7: Run related and project-level verification**

Run:

```bash
corepack pnpm --filter @toard/web exec node --import tsx --test \
  'app/(dashboard)/history/managed-history-privacy.test.ts' \
  'app/(dashboard)/settings/history-security-panel.test.tsx'
corepack pnpm --filter @toard/web typecheck
corepack pnpm --filter @toard/web lint
```

Expected: every command exits 0 with no test failures, type errors, or lint errors.

- [ ] **Step 8: Commit the implementation**

```bash
git add \
  'apps/web/app/(dashboard)/history/history-security-link.tsx' \
  'apps/web/app/(dashboard)/history/managed-history-privacy.test.ts' \
  'apps/web/app/(dashboard)/history/page.tsx' \
  'apps/web/app/(dashboard)/history/session-detail.tsx' \
  'apps/web/app/(dashboard)/settings/history-security-panel.tsx' \
  apps/web/messages/ko/dashboard.json \
  apps/web/messages/en/dashboard.json
git commit -m "feat(history): 보안 안내를 설정 링크로 정리"
```
