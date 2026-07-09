# Device-Scoped Token Issuance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Issuing a token for a new machine must not revoke tokens already installed on other machines.

**Architecture:** Keep ingest tokens additive by default. Preserve the existing explicit revoke-all helper for destructive actions, but remove implicit revocation from normal token issuance and update the settings UI copy to match.

**Tech Stack:** Next.js server actions, PostgreSQL via `pg`, Node test runner with `tsx`, next-intl message JSON.

## Global Constraints

- Do not expose token plaintext or hashes in UI, logs, or test output.
- Do not run destructive database commands.
- Follow TDD: add a failing regression test before production code changes.
- Keep the change scoped to token issuance and onboarding copy.

---

### Task 1: Make Token Issuance Additive

**Files:**
- Modify: `apps/web/lib/tokens.ts`
- Create: `apps/web/lib/tokens.test.ts`
- Modify: `apps/web/package.json`

**Interfaces:**
- Produces: `issueToken(userId: string): Promise<string>` still returns one plaintext token.
- Produces: `issueTokenWithPool(userId: string, pool: { query(sql, params): Promise<unknown> }): Promise<string>` for focused tests.

- [ ] **Step 1: Write failing test**

Add a test that calls `issueTokenWithPool` with a fake pool and asserts no `UPDATE ingest_tokens SET revoked_at` query runs.

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @toard/web test`

Expected: fail because `issueTokenWithPool` does not exist yet.

- [ ] **Step 3: Implement minimal code**

Change `issueToken` to insert a new token hash without revoking existing active tokens.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm --filter @toard/web test`

Expected: pass.

### Task 2: Align Settings UX With Additive Tokens

**Files:**
- Modify: `apps/web/app/(dashboard)/settings/onboarding-panel.tsx`
- Modify: `apps/web/messages/ko/settings.json`
- Modify: `apps/web/messages/en/settings.json`

**Interfaces:**
- Consumes: `issueTokenAction` behavior from Task 1.
- Produces: Settings install tab that says issuing a new token keeps existing machine tokens valid.

- [ ] **Step 1: Remove destructive reissue dialog**

The default button should submit directly. If a token already exists, label it as issuing an additional/new-machine token, not destructive reissue.

- [ ] **Step 2: Update copy**

Remove or stop using copy that says previous tokens are immediately revoked. New token notice should state existing machine tokens remain valid.

- [ ] **Step 3: Verify typecheck**

Run: `pnpm --filter @toard/web typecheck`

Expected: pass.

### Task 3: Final Verification

**Files:**
- Verify only.

- [ ] **Step 1: Run focused tests**

Run: `pnpm --filter @toard/web test`

- [ ] **Step 2: Run package typecheck**

Run: `pnpm --filter @toard/web typecheck`

- [ ] **Step 3: Inspect diff**

Run: `git diff -- apps/web/lib/tokens.ts apps/web/lib/tokens.test.ts apps/web/package.json 'apps/web/app/(dashboard)/settings/onboarding-panel.tsx' apps/web/messages/ko/settings.json apps/web/messages/en/settings.json`
