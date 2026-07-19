# User History Security Managed KMS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the always-visible legacy E2EE user settings card with a managed-KMS status card and show Recovery Kit/device details only when legacy content still exists.

**Architecture:** Add a user-scoped status reader that converts RLS-protected managed key, prompt scheme, migration, account, and device rows into a secret-free DTO. Keep the async server component as the data-loading boundary and extract a pure renderable view for deterministic HTML tests. Preserve provider, key ref, fingerprint, credentials, and cost details exclusively in the existing admin panel.

**Tech Stack:** Next.js App Router, React server components, TypeScript, PostgreSQL RLS, next-intl, Node test runner, `renderToStaticMarkup`.

## Global Constraints

- General users must see server-managed encryption as the primary protection model.
- Provider name, key ref, provider fingerprint, credential source, wrapper bytes, and costs must never enter the user DTO or React props.
- Recovery Kit and approved-device copy must render only for a real non-retired legacy state.
- Korean and English message catalogs must keep identical key structure.
- All database access must run inside `withUserContext(userId, ...)`.

---

### Task 1: User-scoped history security status

**Files:**
- Create: `apps/web/lib/user-history-security.ts`
- Create: `apps/web/lib/user-history-security.test.ts`

**Interfaces:**
- Consumes: `withUserContext(userId, callback)`, `managedContentConfigured(env)`.
- Produces: `UserHistorySecurityStatus` and `getUserHistorySecurityStatus(userId, options?)`.

- [ ] **Step 1: Write the failing status tests**

Create recording DB fixtures that return managed key rows, prompt scheme counts, migration/account rows, and devices. Assert these exact cases:

```ts
const USER_ID = "018f47d0-4d47-7b04-950b-7d18a86e1b43";
const managedEnv = {
  TOARD_KEY_ACTIVE_PROVIDER: "local",
  TOARD_KEY_ACTIVE_LOCAL_KEK_FILE: "/run/secrets/toard-local-kek",
};
const emptyCounts = {
  managed_records: "0",
  e2ee_records: "0",
  server_records: "0",
};
const activeLegacyAccount = {
  state: "active",
  recovery_confirmed_at: new Date("2026-07-14T00:00:00.000Z"),
};
const approvedDevice = {
  id: "018f47d0-4d47-7b04-950b-7d18a86e1b44",
  kind: "shim",
  label: "MacBook",
  platform: "macos",
  last_used_at: new Date("2026-07-18T00:00:00.000Z"),
};

type FixtureInput = {
  keys?: unknown[];
  counts?: typeof emptyCounts;
  account?: Record<string, unknown> | null;
  migration?: Record<string, unknown> | null;
  devices?: unknown[];
};

function recordingContext(input: FixtureInput) {
  const db = {
    async query(sql: string) {
      if (sql.includes("FROM managed_content_keys")) return { rows: input.keys ?? [] };
      if (sql.includes("FROM prompt_records")) return { rows: [input.counts ?? emptyCounts] };
      if (sql.includes("FROM content_accounts")) {
        return { rows: [{ ...(input.account ?? {}), ...(input.migration ?? {}) }] };
      }
      if (sql.includes("FROM content_devices")) return { rows: input.devices ?? [] };
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  return async <T>(_userId: string, action: (tx: typeof db) => Promise<T>) => action(db);
}

test("configured user without a key is ready and exposes no provider material", async () => {
  const status = await getUserHistorySecurityStatus(USER_ID, {
    env: managedEnv,
    runInContext: recordingContext({ keys: [], counts: emptyCounts }),
  });
  assert.equal(status.managed.state, "ready");
  assert.equal(status.managed.activeKeyVersion, null);
  assert.equal("provider" in status.managed, false);
  assert.equal(status.legacy, null);
});

test("active managed key is protected", async () => {
  const status = await getUserHistorySecurityStatus(USER_ID, {
    env: managedEnv,
    runInContext: recordingContext({
      keys: [{ state: "active", key_version: 3 }],
      counts: { managed_records: "4", e2ee_records: "0", server_records: "0" },
    }),
  });
  assert.deepEqual(status.managed, {
    configured: true,
    state: "protected",
    activeKeyVersion: 3,
    managedRecords: 4,
  });
});

test("completed empty E2EE migration hides legacy details", async () => {
  const status = await getUserHistorySecurityStatus(USER_ID, {
    env: managedEnv,
    runInContext: recordingContext({
      account: { state: "migrated" },
      migration: { state: "complete" },
      counts: emptyCounts,
    }),
  });
  assert.equal(status.legacy, null);
});

test("blocked E2EE migration preserves devices without key material", async () => {
  const status = await getUserHistorySecurityStatus(USER_ID, {
    env: managedEnv,
    runInContext: recordingContext({
      account: activeLegacyAccount,
      migration: { state: "blocked" },
      counts: { managed_records: "2", e2ee_records: "1", server_records: "0" },
      devices: [approvedDevice],
    }),
  });
  assert.equal(status.legacy?.state, "blocked");
  assert.equal(status.legacy?.devices.length, 1);
  assert.equal(JSON.stringify(status).includes("wrapped"), false);
});

test("managed records without a configured provider require attention", async () => {
  const status = await getUserHistorySecurityStatus(USER_ID, {
    env: {},
    runInContext: recordingContext({
      counts: { managed_records: "1", e2ee_records: "0", server_records: "0" },
    }),
  });
  assert.equal(status.managed.state, "attention");
});
```

- [ ] **Step 2: Run the new test and verify RED**

Run:

```bash
corepack pnpm --filter @toard/web exec node --import tsx --test lib/user-history-security.test.ts
```

Expected: failure because `user-history-security.ts` does not exist.

- [ ] **Step 3: Implement the secret-free DTO and reader**

Define these public types exactly:

```ts
export type ManagedHistorySecurityState =
  | "disabled"
  | "ready"
  | "protected"
  | "transitioning"
  | "attention";

export type UserHistorySecurityStatus = {
  managed: {
    configured: boolean;
    state: ManagedHistorySecurityState;
    activeKeyVersion: number | null;
    managedRecords: number;
  };
  legacy: null | {
    state: "pending" | "active" | "migrating" | "blocked" | "complete";
    e2eeRecords: number;
    serverRecords: number;
    recoveryConfirmedAt: Date | null;
    devices: Array<{
      id: string;
      kind: "shim" | "browser";
      label: string;
      platform: string;
      lastUsedAt: Date | null;
    }>;
  };
};
```

The reader must execute only these bounded user-scoped query groups: managed key state/version, prompt scheme counts, migration plus account metadata, and approved non-revoked devices. Compute managed state with precedence `attention` for managed records without configuration, `transitioning` for pending/retiring keys, `protected` for active key, `ready` for configured empty state, otherwise `disabled`. Return `legacy: null` for migrated/complete/zero-record state.

- [ ] **Step 4: Run the status tests and verify GREEN**

Run the Step 2 command. Expected: all tests pass with no warning.

- [ ] **Step 5: Commit Task 1**

```bash
git add apps/web/lib/user-history-security.ts apps/web/lib/user-history-security.test.ts
git commit -m "feat(settings): derive managed history security status"
```

### Task 2: Managed-first settings card

**Files:**
- Modify: `apps/web/app/(dashboard)/settings/history-security-panel.tsx`
- Modify: `apps/web/messages/ko/settings.json`
- Modify: `apps/web/messages/en/settings.json`
- Create: `apps/web/app/(dashboard)/settings/history-security-panel.test.tsx`
- Modify: `apps/web/lib/ui-commonization.test.ts`

**Interfaces:**
- Consumes: `getUserHistorySecurityStatus()` and `UserHistorySecurityStatus` from Task 1.
- Produces: `HistorySecurityPanelView({ status, t, formatDate })` and the async `HistorySecurityPanel({ userId })` wrapper.

- [ ] **Step 1: Write failing render tests**

Use `renderToStaticMarkup` with a deterministic translator. Assert:

```ts
test("managed protection is primary and legacy E2EE copy is absent", () => {
  const html = renderToStaticMarkup(
    <HistorySecurityPanelView status={protectedStatus} t={translator} formatDate={String} />,
  );
  assert.match(html, /서버 관리형 암호화/);
  assert.match(html, /보호됨/);
  assert.match(html, /v3/);
  assert.doesNotMatch(html, /Recovery Kit|승인된 기기|AWS|fingerprint|key ref/i);
});

test("legacy recovery and approved devices render only for blocked legacy state", () => {
  const html = renderToStaticMarkup(
    <HistorySecurityPanelView status={blockedLegacyStatus} t={translator} formatDate={String} />,
  );
  assert.match(html, /기존 암호화 기록/);
  assert.match(html, /Recovery Kit 확인/);
  assert.match(html, /승인된 기기/);
  assert.match(html, /데이터는 삭제되지 않았습니다/);
});
```

- [ ] **Step 2: Run the panel test and verify RED**

```bash
corepack pnpm --filter @toard/web exec node --import tsx --test 'app/(dashboard)/settings/history-security-panel.test.tsx'
```

Expected: failure because `HistorySecurityPanelView` and the new message keys do not exist.

- [ ] **Step 3: Implement the managed-first card**

Replace direct SQL in the component with the Task 1 reader. The card must show protection method and user key only. Derive the badge with precedence: blocked/attention, transitioning, protected, ready, disabled. Catch reader failures and render `statusUnavailable` without provider detail. Put Recovery Kit timestamp, approved devices, and destructive-action warning inside a conditional legacy section.

- [ ] **Step 4: Replace Korean and English message keys**

Add matching keys for `protected`, `ready`, `transitioning`, `attention`, `disabled`, `protectionMethod`, `managedEncryption`, `historyKey`, `keyAutoCreate`, `privacyBoundary`, `statusUnavailable`, `legacyTitle`, `legacyServerRecords`, `legacyE2eeRecords`, and the existing recovery/device messages. Remove E2EE-primary wording from `description`.

- [ ] **Step 5: Run panel and catalog tests and verify GREEN**

```bash
corepack pnpm --filter @toard/web exec node --import tsx --test \
  'app/(dashboard)/settings/history-security-panel.test.tsx' \
  lib/ui-commonization.test.ts
```

Expected: all tests pass and Korean/English catalog shapes match.

- [ ] **Step 6: Commit Task 2**

```bash
git add apps/web/app/'(dashboard)'/settings/history-security-panel.tsx \
  apps/web/app/'(dashboard)'/settings/history-security-panel.test.tsx \
  apps/web/messages/ko/settings.json apps/web/messages/en/settings.json \
  apps/web/lib/ui-commonization.test.ts
git commit -m "fix(settings): show managed history encryption"
```

### Task 3: Onboarding copy and complete verification

**Files:**
- Modify: `apps/web/messages/ko/settings.json`
- Modify: `apps/web/messages/en/settings.json`
- Modify: `apps/web/lib/onboarding-install.test.ts`

**Interfaces:**
- Consumes: existing `settings.install.contentWithPrompts` message key.
- Produces: accurate server-managed onboarding copy in both locales.

- [ ] **Step 1: Add a failing onboarding copy assertion**

Assert that Korean and English copy say the server encrypts before storage and do not claim device-side E2EE or that the server cannot decrypt.

```ts
assert.match(ko.install.contentWithPrompts, /서버가 저장 전에 암호화/);
assert.doesNotMatch(ko.install.contentWithPrompts, /이 컴퓨터에서 암호화|서버 키로 복호화할 수 없습니다/);
assert.match(en.install.contentWithPrompts, /server encrypts.*before stor/i);
```

- [ ] **Step 2: Run the onboarding test and verify RED**

```bash
corepack pnpm --filter @toard/web exec node --import tsx --test lib/onboarding-install.test.ts
```

Expected: failure on the old E2EE copy.

- [ ] **Step 3: Update both locale messages and verify GREEN**

Use wording that states transport is protected and the server encrypts before storage. Run the Step 2 command and expect all tests to pass.

- [ ] **Step 4: Run full verification**

```bash
corepack pnpm --filter @toard/web test
corepack pnpm --filter @toard/web typecheck
corepack pnpm test:content-security
git diff --check
```

Expected: zero failures and no whitespace errors.

- [ ] **Step 5: Commit Task 3**

```bash
git add apps/web/messages/ko/settings.json apps/web/messages/en/settings.json \
  apps/web/lib/onboarding-install.test.ts
git commit -m "fix(onboarding): describe server managed encryption"
```

### Task 4: Publish and merge

**Files:**
- No production file changes.

**Interfaces:**
- Consumes: clean verified `codex/managed-kms-encryption` branch.
- Produces: a merged pull request targeting `main`.

- [ ] **Step 1: Verify GitHub access and branch scope**

```bash
gh --version
gh auth status
git status --short --branch
git log --oneline origin/main..HEAD
```

Expected: authenticated GitHub CLI, clean worktree, and only managed-KMS/settings commits in scope.

- [ ] **Step 2: Push the branch and open a ready PR**

```bash
git push -u origin codex/managed-kms-encryption
gh pr create --base main --head codex/managed-kms-encryption --title "feat: add server-managed KMS history encryption" --body-file /tmp/toard-managed-kms-pr.md
```

The PR body must summarize managed KMS, user settings correction, legacy migration behavior, security boundary, and verification commands.

- [ ] **Step 3: Wait for required checks and merge**

```bash
PR_NUMBER=$(gh pr view --json number --jq .number)
gh pr checks "$PR_NUMBER" --watch
gh pr merge "$PR_NUMBER" --merge --delete-branch=false
```

Expected: required checks pass and the PR reports `MERGED`.

- [ ] **Step 4: Verify remote main contains the merge**

```bash
git fetch origin main
git merge-base --is-ancestor HEAD origin/main
PR_NUMBER=$(gh pr view --json number --jq .number)
gh pr view "$PR_NUMBER" --json state,mergedAt,mergeCommit,url
```

Expected: branch HEAD is an ancestor of `origin/main` and PR state is `MERGED`.
