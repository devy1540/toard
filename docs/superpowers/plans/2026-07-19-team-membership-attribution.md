# Team Membership Attribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 최초 팀 배정 때 기존 미배정 사용량을 소급 귀속하고, 이후 팀 변경과 지연 수집은 이벤트 발생 시각의 팀 소속 이력으로 정확히 귀속한다.

**Architecture:** PostgreSQL의 `user_team_assignments`를 시각 단위 소속 원장으로 활성화하고 `users.team_id`는 현재값 캐시로 유지한다. 모든 팀 변경은 공통 서비스가 transaction과 사용자별 advisory lock 안에서 처리하며 최초 배정 작업을 durable queue에 넣는다. 저장 backend는 이벤트 시각으로 소속을 해석하고, 백필 worker는 PostgreSQL raw 행 또는 ClickHouse raw/outbox/rollup을 멱등 보정한다.

**Tech Stack:** TypeScript 5.7, Next.js 15 server actions, PostgreSQL 16, ClickHouse ReplacingMergeTree, node:test, pnpm 9.15.0

## Global Constraints

- 최초 `팀 없음 → 팀`만 기존 미배정 사용량을 자동 소급한다.
- `A → B`, `A → 팀 없음`, 과거 소속이 있는 `팀 없음 → 팀`은 과거를 변경하지 않는다.
- 신규·지연 이벤트는 수집 시각이 아니라 `event.ts`의 `[effective_from, effective_to)` 소속으로 귀속한다.
- 기존 설치의 이미 배정된 사용자는 자동 백필하지 않고 `legacy_adoption`을 명시 실행한다.
- 이미 다른 팀에 귀속된 이벤트는 어떤 백필도 변경하지 않는다.
- PostgreSQL과 ClickHouse 모드가 같은 fixture에서 같은 팀 합계를 반환해야 한다.
- 비밀값, 이메일, 이벤트 본문을 worker 로그에 기록하지 않는다.
- 패키지 명령은 `corepack pnpm`으로 실행한다.

---

## File Map

- `migrations/1700000042_team_membership_attribution.sql`: 소속 원장, 작업 queue, read fence, app role 권한.
- `scripts/team-membership-attribution-migration.integration.test.ts`: migration up/down과 제약·legacy seed 검증.
- `packages/core/src/deployment-release.ts`: 기대 schema version 42.
- `packages/core/src/storage.ts`: backend 공통 preview/backfill 계약.
- `apps/web/lib/team-membership.ts`: 팀 변경 정책과 transaction 경계의 단일 구현.
- `apps/web/lib/team-membership.test.ts`: 최초 배정·이동·해제·재배정 정책 단위 테스트.
- `packages/storage-postgres/src/storage.ts`: 이벤트 시각 귀속, preview, PostgreSQL 백필 batch.
- `packages/storage-postgres/src/storage.test.ts`: PostgreSQL 저장·백필 테스트.
- `packages/storage-clickhouse/src/storage.ts`: 이벤트 시각 outbox 귀속, raw/outbox/rollup 보정.
- `packages/storage-clickhouse/src/storage.test.ts`: ClickHouse 교체·dirty·staging 테스트.
- `apps/web/lib/team-attribution.ts`: 작업 repository, batch runner, 상태 DTO, scheduler.
- `apps/web/lib/team-attribution.test.ts`: 상태 전이·재시도·오류 정제 테스트.
- `apps/web/instrumentation.ts`: self-hosted worker 시작.
- `apps/web/app/api/cron/team-attribution/route.ts`: CRON_SECRET 보호 batch endpoint.
- `apps/web/app/(dashboard)/admin/team-actions.ts`: preview/confirm/change server actions.
- `apps/web/app/(dashboard)/admin/team-select.tsx`: 최초 배정 확인 dialog와 진행 상태.
- `apps/web/app/(dashboard)/admin/page.tsx`: attribution status를 멤버 행에 주입.
- `apps/web/messages/ko/admin.json`, `apps/web/messages/en/admin.json`: 확인·진행·실패 문구.
- `docs/ARCHITECTURE.md`: 이벤트 시각 귀속과 최초 백필 결정 반영.

---

### Task 1: 팀 소속 원장과 durable 작업 스키마

**Files:**
- Create: `migrations/1700000042_team_membership_attribution.sql`
- Create: `scripts/team-membership-attribution-migration.integration.test.ts`
- Modify: `package.json`
- Modify: `packages/core/src/deployment-release.ts`
- Modify: `scripts/bootstrap-app-role.sql`
- Test: `scripts/team-membership-attribution-migration.integration.test.ts`

**Interfaces:**
- Produces: `user_team_assignments`, `team_attribution_jobs`, `team_attribution_read_fences`와 schema version `1700000042`.

- [ ] **Step 1: migration 실패 테스트 작성**

  격리 PostgreSQL 16에서 migrations 1–41을 적용한 뒤 migration 42를 적용해 다음을 assert한다.

  ```ts
  assert.equal(await columnType("user_team_assignments", "effective_from"), "timestamp with time zone");
  assert.equal(await rowCount("user_team_assignments", "assignment_kind = 'legacy_seed'"), 1);
  await assert.rejects(() => insertOverlappingMemberships(), /conflicting key value violates exclusion constraint/);
  assert.equal(await appRoleCan("team_attribution_jobs", "SELECT"), true);
  assert.equal(await appRoleCan("team_attribution_jobs", "DELETE"), false);
  ```

- [ ] **Step 2: migration 테스트 실패 확인**

  Run: `corepack pnpm exec node --import tsx --test scripts/team-membership-attribution-migration.integration.test.ts`

  Expected: FAIL because migration 42 does not exist.

- [ ] **Step 3: migration 구현**

  최종 제약은 아래 계약을 따른다.

  ```sql
  CREATE EXTENSION IF NOT EXISTS btree_gist;
  ALTER TABLE user_team_assignments
    ALTER COLUMN effective_from TYPE TIMESTAMPTZ USING effective_from::timestamp AT TIME ZONE 'UTC',
    ALTER COLUMN effective_to TYPE TIMESTAMPTZ USING effective_to::timestamp AT TIME ZONE 'UTC';
  ALTER TABLE user_team_assignments
    ADD COLUMN assignment_kind TEXT,
    ADD COLUMN created_by UUID REFERENCES users(id),
    ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now();
  UPDATE user_team_assignments SET assignment_kind = 'legacy_seed' WHERE assignment_kind IS NULL;
  ALTER TABLE user_team_assignments ALTER COLUMN assignment_kind SET NOT NULL;
  ```

  기존 현재 팀 중 열린 이력이 없는 사용자는 `effective_from='-infinity'`, `assignment_kind='legacy_seed'`로 seed한다. `tstzrange(..., '[)')` exclusion constraint와 열린 이력 partial unique index를 추가한다. 작업은 `assignment_id` FK, `kind IN ('initial_backfill','legacy_adoption')`, 상태·진행·오류·재시도 필드를 가진다. read fence는 `job_id`, `from_ts`, `to_ts`를 가진다.

- [ ] **Step 4: schema version과 app role 갱신**

  ```ts
  export const LATEST_SCHEMA_VERSION = 1700000042 as const;
  ```

  `bootstrap-app-role.sql`은 세 테이블에 `SELECT, INSERT, UPDATE`, sequence `USAGE, SELECT`를 부여하고 `DELETE`는 부여하지 않는다.

- [ ] **Step 5: migration 테스트 통과 확인**

  Run: `corepack pnpm exec node --import tsx --test scripts/team-membership-attribution-migration.integration.test.ts scripts/deployment-release-completion.integration.test.ts`

  Expected: PASS.

- [ ] **Step 6: 커밋**

  ```bash
  git add migrations/1700000042_team_membership_attribution.sql scripts/team-membership-attribution-migration.integration.test.ts package.json packages/core/src/deployment-release.ts scripts/bootstrap-app-role.sql
  git commit -m "feat(team): add membership attribution schema"
  ```

### Task 2: 공통 팀 변경 정책 서비스

**Files:**
- Create: `apps/web/lib/team-membership.ts`
- Create: `apps/web/lib/team-membership.test.ts`
- Modify: `apps/web/app/(dashboard)/admin/team-actions.ts`
- Modify: `apps/web/app/onboarding/team/actions.ts`

**Interfaces:**
- Consumes: Task 1 tables.
- Produces:

  ```ts
  export type TeamChangeResult = {
    changed: boolean;
    kind: "noop" | "initial_assignment" | "transfer" | "unassignment" | "reassignment";
    assignmentId: string | null;
    attributionJobId: string | null;
  };
  export async function changeUserTeam(
    pool: Pool,
    input: {
      userId: string;
      teamId: string | null;
      actorId: string;
      now?: Date;
      completeOnboarding?: boolean;
    },
  ): Promise<TeamChangeResult>;
  ```

- [ ] **Step 1: 정책 테스트 작성**

  fake client query sequence로 다음을 검증한다.

  ```ts
  assert.equal(first.kind, "initial_assignment");
  assert.ok(first.attributionJobId);
  assert.equal(transfer.kind, "transfer");
  assert.equal(transfer.attributionJobId, null);
  assert.equal(reassignment.kind, "reassignment");
  assert.equal(reassignment.attributionJobId, null);
  ```

  동일 팀은 no-op, 존재하지 않는 팀은 `TEAM_NOT_FOUND`, 잘못된 시각은 `INVALID_TEAM_CHANGE_TIME`을 던져야 한다.

- [ ] **Step 2: 테스트 실패 확인**

  Run: `corepack pnpm --filter @toard/web test -- lib/team-membership.test.ts`

  Expected: FAIL because module is missing.

- [ ] **Step 3: `changeUserTeam` 최소 구현**

  transaction 안에서 사용자별 `pg_advisory_xact_lock(hashtextextended($1, 1540))`, user row `FOR UPDATE`, 팀 검증, 열린 이력 종료, 새 이력 생성, `users.team_id` 갱신을 실행한다. 과거 이력 0건인 최초 배정만 `-infinity`와 `initial_backfill` job을 생성한다.

- [ ] **Step 4: 두 server action을 공통 서비스로 전환**

  관리자 action과 onboarding action은 직접 `UPDATE users SET team_id`를 하지 않고 `changeUserTeam`을 호출한다. onboarding 성공 시 `team_onboarding_completed_at=now()`만 같은 transaction helper에 옵션으로 전달한다.

  팀 삭제 검증에는 `EXISTS(SELECT 1 FROM user_team_assignments WHERE team_id=$1)`를 추가해 과거 소속 이력이 있는 팀도 삭제하지 않는다.

- [ ] **Step 5: 테스트 통과 확인**

  Run: `corepack pnpm --filter @toard/web test -- lib/team-membership.test.ts`

  Expected: PASS.

- [ ] **Step 6: 커밋**

  ```bash
  git add apps/web/lib/team-membership.ts apps/web/lib/team-membership.test.ts 'apps/web/app/(dashboard)/admin/team-actions.ts' apps/web/app/onboarding/team/actions.ts
  git commit -m "feat(team): record effective membership history"
  ```

### Task 3: 이벤트 발생 시각 기반 신규 수집 귀속

**Files:**
- Modify: `packages/storage-postgres/src/storage.ts`
- Modify: `packages/storage-postgres/src/storage.test.ts`
- Modify: `packages/storage-clickhouse/src/storage.ts`
- Modify: `packages/storage-clickhouse/src/storage.test.ts`

**Interfaces:**
- Consumes: `user_team_assignments` 기간 원장.
- Produces: backend 내부 `teamMapAt(client, events)`가 `Map<dedupKey, teamId>`를 반환한다.

- [ ] **Step 1: PostgreSQL 경계 테스트 작성**

  같은 사용자의 이벤트가 A 소속 기간, 팀 없음 gap, B 소속 기간에 있을 때 각각 A/null/B가 INSERT parameter에 들어가는지 검증한다. 정확히 B의 `effective_from`인 이벤트는 B여야 한다.

- [ ] **Step 2: ClickHouse outbox 경계 테스트 작성**

  PostgreSQL과 동일 fixture가 `clickhouse_usage_outbox.team_id`에 A/null/B를 기록하는지 검증한다.

- [ ] **Step 3: 테스트 실패 확인**

  Run: `corepack pnpm --filter @toard/storage-postgres test && corepack pnpm --filter @toard/storage-clickhouse test`

  Expected: new tests FAIL because current code reads `users.team_id`.

- [ ] **Step 4: backend 귀속 조회 구현**

  dedup key, user id, event ts의 `VALUES` relation을 `user_team_assignments`에 lateral join해 `[from,to)` row를 찾는다. 수집 transaction은 사용자 ID 정렬 후 Task 2와 같은 advisory lock을 잡는다. 일치하지 않으면 null/빈 문자열을 쓴다.

- [ ] **Step 5: backend 테스트 통과 확인**

  Run: `corepack pnpm --filter @toard/storage-postgres test && corepack pnpm --filter @toard/storage-clickhouse test`

  Expected: PASS.

- [ ] **Step 6: 커밋**

  ```bash
  git add packages/storage-postgres/src/storage.ts packages/storage-postgres/src/storage.test.ts packages/storage-clickhouse/src/storage.ts packages/storage-clickhouse/src/storage.test.ts
  git commit -m "fix(team): attribute events by effective membership"
  ```

### Task 4: backend 공통 preview와 PostgreSQL 백필

**Files:**
- Modify: `packages/core/src/storage.ts`
- Modify: `packages/storage-postgres/src/storage.ts`
- Modify: `packages/storage-postgres/src/storage.test.ts`

**Interfaces:**
- Produces:

  ```ts
  export type TeamAttributionPreview = {
    events: number;
    from: Date | null;
    to: Date | null;
    totalTokens: number;
    costUsd: number;
  };
  export type TeamAttributionBatchResult = {
    processed: number;
    updated: number;
    affectedBuckets: Date[];
    hasMore: boolean;
  };
  previewUnassignedTeamAttribution(input: { userId: string; from: Date | null; to: Date | null }): Promise<TeamAttributionPreview>;
  backfillUnassignedTeamAttribution(input: { userId: string; teamId: string; from: Date | null; to: Date | null; limit: number; jobId: string }): Promise<TeamAttributionBatchResult>;
  ```

- [ ] **Step 1: preview와 batch 실패 테스트 작성**

  preview는 `team_id IS NULL`만 합산하고, batch는 `id` 순서 제한과 최종 UPDATE의 `team_id IS NULL` 재검증을 포함해야 한다.

- [ ] **Step 2: 테스트 실패 확인**

  Run: `corepack pnpm --filter @toard/storage-postgres test`

  Expected: FAIL because interface methods are absent.

- [ ] **Step 3: core 계약과 PostgreSQL 구현 추가**

  batch는 CTE로 후보 ID를 제한하고 `UPDATE ... FROM candidates`로 갱신한다. `hasMore`는 limit+1 probe로 계산하고 영향 날짜를 반환한다.

- [ ] **Step 4: 테스트 통과 확인**

  Run: `corepack pnpm --filter @toard/core typecheck && corepack pnpm --filter @toard/storage-postgres test`

  Expected: PASS.

- [ ] **Step 5: 커밋**

  ```bash
  git add packages/core/src/storage.ts packages/storage-postgres/src/storage.ts packages/storage-postgres/src/storage.test.ts
  git commit -m "feat(team): backfill postgres attribution"
  ```

### Task 5: ClickHouse raw·outbox·rollup 백필

**Files:**
- Modify: `packages/storage-clickhouse/src/storage.ts`
- Modify: `packages/storage-clickhouse/src/storage.test.ts`

**Interfaces:**
- Consumes: Task 4 `StorageBackend` methods.
- Produces: ClickHouse implementation with raw replacement, rollup staging, dirty propagation.

- [ ] **Step 1: pending outbox와 raw replacement 테스트 작성**

  outbox `team_id IS NULL` update가 먼저 실행되고, delivered raw는 `FINAL`에서 빈 team만 선택해 같은 dedup key로 새 team을 insert하는지 검증한다.

- [ ] **Step 2: rollup-only staging 테스트 작성**

  raw coverage가 없는 bucket은 staging insert → old empty-team mutation delete → replacement insert → 검증 순서이며, 실패 시 fence/staging이 유지돼야 한다.

- [ ] **Step 3: 테스트 실패 확인**

  Run: `corepack pnpm --filter @toard/storage-clickhouse test`

  Expected: FAIL because methods are absent.

- [ ] **Step 4: ClickHouse preview와 raw/outbox batch 구현**

  preview는 outbox pending과 `usage_events FINAL` delivered를 dedup key로 중복 제거한다. raw replacement는 가격 복구의 교체 insert와 `mark15mRollupDirty` 패턴을 재사용한다.

- [ ] **Step 5: rollup-only staging과 read fence 구현**

  runtime schema에 `team_attribution_rollup_staging`을 만들고, 전체 raw coverage가 없는 bucket에만 활성 rollup row를 staging한다. old empty-team key 동기 삭제, replacement insert, row-count 검증 후 PostgreSQL fence를 제거한다. fence 삭제는 app role DELETE를 피하도록 `complete_team_attribution_fence(job_id)` SECURITY DEFINER 함수로 한정한다.

- [ ] **Step 6: 테스트 통과 확인**

  Run: `corepack pnpm --filter @toard/storage-clickhouse test`

  Expected: PASS.

- [ ] **Step 7: 커밋**

  ```bash
  git add packages/storage-clickhouse/src/storage.ts packages/storage-clickhouse/src/storage.test.ts migrations/1700000042_team_membership_attribution.sql scripts/team-membership-attribution-migration.integration.test.ts
  git commit -m "feat(team): backfill clickhouse attribution"
  ```

### Task 6: durable worker와 cron 실행 경로

**Files:**
- Create: `apps/web/lib/team-attribution.ts`
- Create: `apps/web/lib/team-attribution.test.ts`
- Create: `apps/web/app/api/cron/team-attribution/route.ts`
- Modify: `apps/web/instrumentation.ts`

**Interfaces:**
- Produces:

  ```ts
  export async function runTeamAttributionBatch(now?: Date): Promise<"idle" | "progress" | "complete" | "failed">;
  export function startTeamAttributionWorker(): void;
  export function teamAttributionSchedulerEligible(env: NodeJS.ProcessEnv): boolean;
  export async function getTeamAttributionStatus(userIds: string[]): Promise<Map<string, TeamAttributionStatus>>;
  export async function findTeamAttributionFence(from: Date, to: Date): Promise<boolean>;
  ```

- [ ] **Step 1: repository 상태 전이 테스트 작성**

  `FOR UPDATE SKIP LOCKED`, pending→running, batch progress 누적, hasMore 재queue, 성공, sanitized failure/backoff를 검증한다.

- [ ] **Step 2: 테스트 실패 확인**

  Run: `corepack pnpm --filter @toard/web test -- lib/team-attribution.test.ts`

  Expected: FAIL because module is missing.

- [ ] **Step 3: worker 구현**

  worker는 한 tick에 한 job·한 bounded batch만 처리한다. assignment의 최신 `effective_to`를 다시 읽고 storage backend method를 호출한다. 오류는 고정 메시지와 지수 backoff로 저장하고 secret·SQL·stack을 DTO에 포함하지 않는다.

- [ ] **Step 4: scheduler와 cron route 연결**

  self-hosted Node runtime은 startup 15초 후, 이후 10초마다 tick한다. cron route는 `CRON_SECRET`가 있으면 Bearer를 필수로 검사하고 한 batch 결과만 JSON으로 반환한다.

- [ ] **Step 5: 테스트 통과 확인**

  Run: `corepack pnpm --filter @toard/web test -- lib/team-attribution.test.ts`

  Expected: PASS.

- [ ] **Step 6: 커밋**

  ```bash
  git add apps/web/lib/team-attribution.ts apps/web/lib/team-attribution.test.ts apps/web/app/api/cron/team-attribution/route.ts apps/web/instrumentation.ts
  git commit -m "feat(team): run durable attribution worker"
  ```

### Task 7: 관리자 preview·확인·진행 UI

**Files:**
- Modify: `apps/web/app/(dashboard)/admin/team-actions.ts`
- Modify: `apps/web/app/(dashboard)/admin/team-select.tsx`
- Modify: `apps/web/app/(dashboard)/admin/page.tsx`
- Modify: `apps/web/app/(dashboard)/org/page.tsx`
- Modify: `apps/web/app/(dashboard)/org/teams/page.tsx`
- Modify: `apps/web/app/(dashboard)/org/team/page.tsx`
- Modify: `apps/web/messages/ko/admin.json`
- Modify: `apps/web/messages/en/admin.json`
- Modify: `apps/web/lib/ui-commonization.test.ts`

**Interfaces:**
- Consumes: Task 2 `changeUserTeam`, Task 4 preview, Task 6 status.
- Produces: `previewTeamAssignmentAction(userId, teamId)`, `requestLegacyTeamAttributionAction(userId)`, 확인 dialog와 read-fence 화면.

- [ ] **Step 1: UI source-contract 실패 테스트 작성**

  첫 배정 dialog가 팀명·이벤트 수·기간·토큰·비용·다른 팀 불변 문구를 포함하고, 진행·실패 상태가 노출되는지 source contract를 추가한다.

- [ ] **Step 2: 테스트 실패 확인**

  Run: `corepack pnpm --filter @toard/web test -- lib/ui-commonization.test.ts`

  Expected: FAIL because dialog/status copy is absent.

- [ ] **Step 3: preview server action 구현**

  관리 권한, 대상 사용자, 대상 팀을 검증하고 기존 소속 이력 유무로 자동 소급 여부를 판정한다. 최초 배정일 때만 storage preview를 반환한다.

  현재 팀이 있고 `legacy_seed`만 있는 사용자는 `requestLegacyTeamAttributionAction`이 preview를 다시 검증하고 `legacy_adoption` job을 등록한다. 이 action은 확인 dialog의 명시적 제출 없이는 호출하지 않는다.

- [ ] **Step 4: TeamSelect 확인 dialog 구현**

  최초 배정과 대상 1건 이상이면 dialog 확인 전 저장하지 않는다. 그 외 변경은 기존처럼 즉시 저장한다. pending 동안 select를 비활성화하고 완료 후 `router.refresh()`를 호출한다.

- [ ] **Step 5: 상태 표시와 다국어 문구 추가**

  `page.tsx`가 멤버별 attribution status를 읽어 `귀속 중 n건`, `귀속 완료 n건`, `귀속 실패—재시도 예정`을 전달한다. raw 오류는 표시하지 않는다.

  현재 팀이 있는 legacy 사용자에게 미배정 preview가 1건 이상이면 `기존 미배정 사용량 귀속` 버튼을 표시한다. 팀 변경 selector 자체는 legacy adoption을 암묵 실행하지 않는다.

  세 조직 화면은 조회 기간과 겹치는 read fence가 있으면 집계 query를 실행하지 않고 `과거 사용량 귀속 중` 안내와 새로고침 control을 표시한다.

- [ ] **Step 6: 테스트 통과 확인**

  Run: `corepack pnpm --filter @toard/web test -- lib/ui-commonization.test.ts`

  Expected: PASS.

- [ ] **Step 7: 커밋**

  ```bash
  git add 'apps/web/app/(dashboard)/admin/team-actions.ts' 'apps/web/app/(dashboard)/admin/team-select.tsx' 'apps/web/app/(dashboard)/admin/page.tsx' 'apps/web/app/(dashboard)/org/page.tsx' 'apps/web/app/(dashboard)/org/teams/page.tsx' 'apps/web/app/(dashboard)/org/team/page.tsx' apps/web/messages/ko/admin.json apps/web/messages/en/admin.json apps/web/lib/ui-commonization.test.ts
  git commit -m "feat(team): confirm historical attribution"
  ```

### Task 8: 문서·전체 회귀·실제 PostgreSQL 검증

**Files:**
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/superpowers/specs/2026-07-19-team-membership-attribution-design.md` only if implementation-discovered constraints require clarification.

**Interfaces:**
- Consumes: Tasks 1–7.
- Produces: release-ready evidence.

- [ ] **Step 1: 문서의 기존 수집시점·백필 없음 설명 교체**

  `ARCHITECTURE.md`는 소속 이력, 이벤트 발생 시각 귀속, 최초 배정만 소급, legacy adoption을 권위 정책으로 설명한다.

- [ ] **Step 2: 집중 테스트 실행**

  Run:

  ```bash
  corepack pnpm exec node --import tsx --test scripts/team-membership-attribution-migration.integration.test.ts
  corepack pnpm --filter @toard/storage-postgres test
  corepack pnpm --filter @toard/storage-clickhouse test
  corepack pnpm --filter @toard/web test -- lib/team-membership.test.ts lib/team-attribution.test.ts lib/ui-commonization.test.ts
  ```

  Expected: all PASS.

- [ ] **Step 3: 전체 정적 검증과 회귀 테스트 실행**

  Run:

  ```bash
  corepack pnpm typecheck
  corepack pnpm lint
  corepack pnpm test
  corepack pnpm build
  ```

  Expected: all commands exit 0.

- [ ] **Step 4: 격리 PostgreSQL 시나리오 검증**

  migration integration fixture에서 사용자 생성 → 과거 미배정 이벤트 생성 → 최초 팀 배정 → worker drain → 팀 합계를 조회해 미배정 수 0, 팀 수가 기존 이벤트 수와 같은지 확인한다. 이어 A→B 이동 경계 전후 이벤트가 각각 A/B에 남는지 확인한다.

- [ ] **Step 5: 최종 diff와 비밀값 검사**

  Run:

  ```bash
  git diff --check origin/main...HEAD
  rg -n "(AUTH_SECRET|CRON_SECRET|PASSWORD|TOKEN)=.+" migrations apps packages scripts docs
  git status --short
  ```

  Expected: diff check clean, 새 비밀값 없음, 의도한 파일만 변경.

- [ ] **Step 6: 커밋**

  ```bash
  git add docs/ARCHITECTURE.md
  git commit -m "docs: document effective team attribution"
  ```
