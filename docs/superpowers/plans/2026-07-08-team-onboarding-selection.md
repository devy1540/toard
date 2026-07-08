# Team Onboarding Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 신규 member가 첫 설치 전에 팀을 직접 한 번 선택하고, 초대 가입자는 관리자가 지정한 팀으로 생성되게 한다.

**Architecture:** `users.team_onboarding_completed_at`으로 최초 선택 완료 여부를 저장한다. 대시보드 레이아웃은 로그인 member가 팀도 없고 완료 시각도 없으며 팀이 존재할 때 top-level `/onboarding/team`으로 보낸다. 초대는 `invites.team_id`를 저장하고 수락 시 `users.team_id`와 완료 시각을 함께 쓴다.

**Tech Stack:** Next.js App Router, Auth.js/NextAuth, PostgreSQL migrations, server actions, next-intl, existing shadcn-style UI components.

---

## File Structure

- Create `migrations/1700000016_team_onboarding.sql`: user completion timestamp and invite team reference.
- Modify `apps/web/lib/session-user.ts`: expose `teamOnboardingCompletedAt`.
- Create `apps/web/lib/team-onboarding.ts`: small shared helpers for team count/list and pending decision.
- Modify `apps/web/app/(dashboard)/layout.tsx`: redirect pending member users to `/onboarding/team`.
- Create `apps/web/app/onboarding/team/page.tsx`: server-rendered team onboarding page outside the dashboard route group.
- Create `apps/web/app/onboarding/team/team-form.tsx`: client-side select form.
- Create `apps/web/app/onboarding/team/actions.ts`: server action to save the first team selection.
- Modify `apps/web/lib/invites.ts`: carry `team_id` through create/list/accept paths.
- Modify `apps/web/app/(dashboard)/admin/invite-actions.ts`: require and validate invite team.
- Modify `apps/web/app/(dashboard)/admin/invite-panel.tsx`: render team select and pending invite team label.
- Modify `apps/web/app/(dashboard)/admin/page.tsx`: pass team options to invite panel.
- Modify `apps/web/app/invite/[token]/page.tsx` and `accept-form.tsx`: show assigned team on invite accept.
- Modify `apps/web/messages/{ko,en}/{auth,admin,invite}.json`: add labels and errors.
- Update `docs/superpowers/specs/2026-07-08-team-onboarding-selection-design.md`: note the top-level onboarding route implementation.

---

### Task 1: Schema and Session Shape

**Files:**
- Create: `migrations/1700000016_team_onboarding.sql`
- Modify: `apps/web/lib/session-user.ts`
- Create: `apps/web/lib/team-onboarding.ts`

- [x] **Step 1: Add migration**

```sql
-- Up Migration

ALTER TABLE users ADD COLUMN team_onboarding_completed_at TIMESTAMPTZ;

UPDATE users
SET team_onboarding_completed_at = now()
WHERE role = 'admin' OR team_id IS NOT NULL;

ALTER TABLE invites ADD COLUMN team_id UUID REFERENCES teams(id) ON DELETE SET NULL;

-- Down Migration

ALTER TABLE invites DROP COLUMN IF EXISTS team_id;
ALTER TABLE users DROP COLUMN IF EXISTS team_onboarding_completed_at;
```

- [x] **Step 2: Extend session user query**

```ts
export type SessionUser = {
  id: string;
  email: string;
  role: string;
  teamId: string | null;
  teamName: string | null;
  teamOnboardingCompletedAt: Date | null;
};
```

Update the SQL to select `u.team_onboarding_completed_at` and map it to `teamOnboardingCompletedAt`.

- [x] **Step 3: Add onboarding helpers**

```ts
import type { SessionUser } from "@/lib/session-user";
import { getPool } from "./db";

export type TeamOption = { id: string; name: string };

export function isTeamOnboardingPending(user: SessionUser | null): boolean {
  return Boolean(
    user &&
      user.role === "member" &&
      !user.teamId &&
      !user.teamOnboardingCompletedAt,
  );
}

export async function listTeamOptions(): Promise<TeamOption[]> {
  const r = await getPool().query<TeamOption>("SELECT id, name FROM teams ORDER BY name");
  return r.rows;
}

export async function hasTeams(): Promise<boolean> {
  const r = await getPool().query("SELECT 1 FROM teams LIMIT 1");
  return (r.rowCount ?? 0) > 0;
}
```

- [x] **Step 4: Verify typecheck after schema-facing type changes**

Run: `pnpm --filter @toard/web typecheck`

Expected: it may fail until route code is added, but there should be no stale `SessionUser` property errors after Task 2.

---

### Task 2: Team Onboarding Route and Redirect Guard

**Files:**
- Modify: `apps/web/app/(dashboard)/layout.tsx`
- Create: `apps/web/app/onboarding/team/page.tsx`
- Create: `apps/web/app/onboarding/team/team-form.tsx`
- Create: `apps/web/app/onboarding/team/actions.ts`
- Modify: `apps/web/messages/ko/auth.json`
- Modify: `apps/web/messages/en/auth.json`

- [x] **Step 1: Add dashboard guard**

In `apps/web/app/(dashboard)/layout.tsx`, after `sessionUser` is loaded:

```ts
if (sessionUser && isTeamOnboardingPending(sessionUser) && (await hasTeams())) {
  redirect("/onboarding/team");
}
```

Import `hasTeams` and `isTeamOnboardingPending` from `@/lib/team-onboarding`.

- [x] **Step 2: Add server action**

Create `apps/web/app/onboarding/team/actions.ts` with `chooseTeamAction`. The action must:

```ts
const user = await getSessionUser();
if (!user) redirect("/login");
if (!isTeamOnboardingPending(user)) redirect("/settings?tab=install");
const teamId = String(formData.get("teamId") ?? "");
```

It validates `teamId`, locks the user row, checks the team still exists, updates `users.team_id` and `team_onboarding_completed_at = now()`, then redirects to `/settings?tab=install`.

- [x] **Step 3: Add form component**

Create `apps/web/app/onboarding/team/team-form.tsx` with a controlled Radix `Select`, a hidden `teamId` input, pending submit state, and error rendering from the server action state.

- [x] **Step 4: Add page**

Create `apps/web/app/onboarding/team/page.tsx`. It must:

```ts
const user = await getSessionUser();
if (!user) redirect("/login");
const teams = await listTeamOptions();
if (!isTeamOnboardingPending(user) || teams.length === 0) redirect("/settings?tab=install");
```

Render a centered card with logo, title, description, and `TeamOnboardingForm`.

- [x] **Step 5: Add auth messages**

Add `teamOnboarding` labels and `errors.teamRequired`, `errors.teamNotFound`, `errors.teamSaveFailed` in both Korean and English auth catalogs.

- [x] **Step 6: Run typecheck**

Run: `pnpm --filter @toard/web typecheck`

Expected: PASS or only failures from later invite changes not yet implemented.

---

### Task 3: Invite Team Assignment

**Files:**
- Modify: `apps/web/lib/invites.ts`
- Modify: `apps/web/app/(dashboard)/admin/invite-actions.ts`
- Modify: `apps/web/app/(dashboard)/admin/invite-panel.tsx`
- Modify: `apps/web/app/(dashboard)/admin/page.tsx`
- Modify: `apps/web/app/invite/[token]/page.tsx`
- Modify: `apps/web/app/invite/[token]/accept-form.tsx`
- Modify: `apps/web/messages/ko/admin.json`
- Modify: `apps/web/messages/en/admin.json`
- Modify: `apps/web/messages/ko/invite.json`
- Modify: `apps/web/messages/en/invite.json`

- [x] **Step 1: Extend invite domain types**

`Invite` includes `teamId` and `teamName`; `PendingInvite` includes `teamName`.

- [x] **Step 2: Make invite creation require a valid team**

Change `createInvite` signature to:

```ts
export type CreateInviteResult =
  | { ok: true; token: string }
  | { ok: false; reason: "existing-user" | "team-not-found" };

export async function createInvite(
  email: string,
  role: string,
  teamId: string,
  createdBy: string,
): Promise<CreateInviteResult>
```

Inside the transaction, validate `teams.id = teamId` before inserting `invites.team_id`.

- [x] **Step 3: Persist invite team on accept**

When accepting an invite, select `team_id` and insert:

```sql
INSERT INTO users (email, name, password_hash, role, team_id, team_onboarding_completed_at)
VALUES ($1, $2, $3, $4, $5, CASE WHEN $5::uuid IS NOT NULL OR $4 = 'admin' THEN now() ELSE NULL END)
```

- [x] **Step 4: Update admin invite action**

Read `teamId` from form data, return `errors.teamRequired` if absent, call the new `createInvite`, and map `team-not-found` to `errors.teamNotFound`.

- [x] **Step 5: Update admin invite UI**

Pass `teams` to `InvitePanel`. Add a required team select. Disable invite generation when no teams exist and show `invites.noTeams`.

- [x] **Step 6: Show assigned team in invite accept UI**

Pass `teamName` into `AcceptForm` and show a read-only row when present.

- [x] **Step 7: Add admin and invite messages**

Add `invites.teamLabel`, `invites.noTeams`, `invites.pendingTeam`, and invite `teamLabel` in both locales.

- [x] **Step 8: Run typecheck**

Run: `pnpm --filter @toard/web typecheck`

Expected: PASS.

---

### Task 4: Verification and Preview

**Files:**
- Modify: `docs/superpowers/specs/2026-07-08-team-onboarding-selection-design.md`

- [x] **Step 1: Update spec route note**

Clarify that `/onboarding/team` is a top-level route outside the dashboard route group, while the dashboard layout performs the redirect.

- [x] **Step 2: Run full checks**

Run:

```bash
pnpm --filter @toard/web typecheck
pnpm -r test
```

Expected: PASS.

- [x] **Step 3: Run local app preview**

Use the existing local env if available. Apply migrations, start `pnpm dev`, and open a browser preview.

- [x] **Step 4: Capture screenshots**

Create or reuse a local DB state with at least one team and one member requiring onboarding. Capture:

- `/onboarding/team`
- `/admin?tab=invites`
- `/invite/<token>` for a team-assigned invite when feasible

- [x] **Step 5: Commit implementation**

Run:

```bash
git add migrations apps/web docs/superpowers
git commit -m "feat(auth): 최초 팀 선택 온보딩 추가"
```
