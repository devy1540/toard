# Device Token Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users issue, identify, and revoke ingest tokens per machine without invalidating unrelated machine tokens.

**Architecture:** Store token management metadata on `ingest_tokens`: an optional user-facing label and the last sanitized host observed for that token. Keep usage/device tables as observation data, but perform destructive actions against a specific token id owned by the current user.

**Tech Stack:** Next.js server actions, PostgreSQL migrations, `pg`, Node test runner with `tsx`, next-intl message JSON, existing shadcn-style UI components.

## Global Constraints

- Never expose plaintext tokens or token hashes after the one-time issue response.
- Revoke actions must be scoped by both `user_id` and token `id`.
- Existing tokens must keep working after the migration.
- UI copy must distinguish local uninstall from server-side token revocation.
- Follow TDD for token service behavior before production changes.

---

### Task 1: Extend Token Model

**Files:**
- Create: `migrations/1700000017_ingest_token_devices.sql`
- Modify: `apps/web/lib/tokens.ts`
- Modify: `apps/web/lib/tokens.test.ts`

**Interfaces:**
- Produces: `type IngestTokenRow = { id: string; label: string | null; lastHost: string | null; createdAt: Date; lastUsedAt: Date | null; expiresAt: Date | null; revokedAt: Date | null }`
- Produces: `issueToken(userId: string, label?: string | null): Promise<string>`
- Produces: `listActiveTokens(userId: string): Promise<IngestTokenRow[]>`
- Produces: `revokeToken(userId: string, tokenId: string): Promise<boolean>`
- Produces: `recordTokenHost(tokenId: string, hosts: Array<string | null | undefined>): Promise<void>`

- [ ] **Step 1: Write failing tests**

Add tests that assert:
- issuing inserts `device_label` and does not revoke old tokens
- token listing maps DB rows to `IngestTokenRow`
- revoking a token scopes the update by `user_id` and `id`
- recording a token host stores the first non-empty host and skips empty host batches

- [ ] **Step 2: Verify RED**

Run: `/opt/homebrew/bin/pnpm --filter @toard/web test`

Expected: fail because the new exports/SQL are not implemented yet.

- [ ] **Step 3: Implement model and migration**

Add nullable columns:

```sql
ALTER TABLE ingest_tokens ADD COLUMN device_label TEXT;
ALTER TABLE ingest_tokens ADD COLUMN last_host TEXT;
CREATE INDEX idx_ingest_tokens_user_active_created
  ON ingest_tokens (user_id, revoked_at, created_at DESC);
```

Implement token functions using parameterized SQL only. `revokeToken` must update only rows matching both `user_id` and `id`.

- [ ] **Step 4: Verify GREEN**

Run: `/opt/homebrew/bin/pnpm --filter @toard/web test`

Expected: pass.

### Task 2: Attach Last Host To The Authenticating Token

**Files:**
- Modify: `apps/web/lib/ingest-auth.ts`
- Modify: `apps/web/app/api/v1/events/route.ts`
- Modify: `apps/web/app/api/v1/logs/route.ts`

**Interfaces:**
- Consumes: `recordTokenHost(tokenId, hosts)` from Task 1.
- Produces: `authenticateIngestToken(authHeader): Promise<{ userId: string; tokenId: string } | null>`.

- [ ] **Step 1: Return token id from auth**

Change the auth query to `RETURNING id, user_id` while preserving `last_used_at = now()` and revoked/expired checks.

- [ ] **Step 2: Update ingest routes**

Use `auth.userId` where routes previously used `userId`. After host sanitization/extraction, call `recordTokenHost(auth.tokenId, hosts)`.

- [ ] **Step 3: Verify typecheck**

Run: `/opt/homebrew/bin/pnpm --filter @toard/web typecheck`

Expected: pass.

### Task 3: Add Settings Token Management UI

**Files:**
- Modify: `apps/web/app/(dashboard)/settings/page.tsx`
- Modify: `apps/web/app/(dashboard)/settings/onboarding-panel.tsx`
- Modify: `apps/web/app/(dashboard)/settings/token-actions.ts`
- Create: `apps/web/app/(dashboard)/settings/token-management-panel.tsx`
- Modify: `apps/web/messages/ko/settings.json`
- Modify: `apps/web/messages/en/settings.json`

**Interfaces:**
- Consumes: `listActiveTokens(userId)` from Task 1.
- Consumes: `revokeTokenAction(formData)` server action.
- Produces: A token table with label, last host, created time, last used time, and per-token revoke action.

- [ ] **Step 1: Add label input to issuance**

Add an optional `label` input to the install panel. `issueTokenAction` reads it and passes it to `issueToken`.

- [ ] **Step 2: Add token management table**

Render active tokens below the install/check cards. Each row shows label fallback, last host fallback, created time, last used time, and a destructive revoke button behind an alert dialog.

- [ ] **Step 3: Add copy**

Add Korean and English messages for token label, active token table, revocation warning, and success/failure states.

- [ ] **Step 4: Verify typecheck**

Run: `/opt/homebrew/bin/pnpm --filter @toard/web typecheck`

Expected: pass.

### Task 4: Final Verification

**Files:**
- Verify only.

- [ ] **Step 1: Run focused web tests**

Run: `/opt/homebrew/bin/pnpm --filter @toard/web test`

- [ ] **Step 2: Run all workspace tests**

Run: `/opt/homebrew/bin/pnpm -r test`

- [ ] **Step 3: Run all workspace typechecks**

Run: `/opt/homebrew/bin/pnpm -r typecheck`

- [ ] **Step 4: Inspect diff**

Run: `git diff --check && git status --short`
