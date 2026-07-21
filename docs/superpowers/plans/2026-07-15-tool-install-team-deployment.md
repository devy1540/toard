# Tool Install and Team Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 라이브러리의 Skill·MCP·Plugin을 개인 기기에 한 번에 설치하고, 팀 리더가 제외 가능한 팀 기본 도구로 점진 배포할 수 있게 만든다.

**Architecture:** Git 저장소는 원본, toard 서버는 immutable manifest·desired state·비밀값 없는 결과의 source of truth, shim은 로컬 파일·설정·비밀값·last-known-good의 source of truth가 된다. 서버와 shim은 `ToolDeploymentManifestV1` 계약을 공유하고, 개인 선택과 팀 정책을 하나의 resolver로 계산한다. shim은 자신이 관리한 파일과 설정 키만 atomic하게 바꾸며 실패하면 같은 reconcile 안에서 직전 정상 버전으로 복구한다.

**Tech Stack:** TypeScript 5.7, Node.js 20, Next.js 15 App Router, PostgreSQL SQL migrations, React 19, Node test runner, Rust 2021, serde/serde_json/sha2, 기존 `fsx` atomic writer.

## Global Constraints

- MCP 비밀값과 client-native 인증값은 사용자 기기에만 저장하며 서버 요청·DB·감사 로그에 포함하지 않는다.
- 임의 shell string은 허용하지 않고 stdio MCP는 고정된 `command`와 `args[]`만 실행한다.
- shim은 toard managed state에 기록한 파일과 설정 키만 수정하며 같은 이름의 비관리 설정은 `conflict`로 보고한다.
- 팀 기본 정책은 구성원이 `exclude`할 수 있고, 개인 설치는 팀 정책보다 우선한다.
- 팀 리더는 자기 팀 정책만 변경하며 관리자는 리더 지정과 사후 global block만 수행한다.
- 같은 source identity의 권한 불변 업데이트만 자동 배포한다. 환경변수·network host·command·구성요소·repository identity 변화는 승인을 기다린다.
- rollout은 preflight → 최소 1대·10% canary 30분 → 50% 60분 → 100% 순서다.
- 새 버전 실패가 2대 이상 또는 적용 대상의 20% 이상이면 server rollout을 중단하고 last-known-good로 되돌린다.
- daemon manifest 조회 기본 간격은 60초이며 ETag가 같으면 `304 Not Modified`를 사용한다.
- v1 자동 설치는 macOS와 Linux만 지원하고 Windows는 `unsupported`로 보고한다.
- private GitHub source는 Workspace GitHub App의 짧은 수명 download URL만 shim에 전달하며 access token과 artifact를 영구 저장하지 않는다.

---

## File Structure

- `packages/core/src/tool-deployment.ts`: manifest, desired-state, permission diff, rollout 순수 도메인 타입과 함수.
- `packages/core/src/tool-deployment.test.ts`: 우선순위·권한 확대·cohort·rollback 임계값의 계약 테스트.
- `migrations/1700000045_tool_deployment.sql`: 버전, 정책, 개인 선택, 기기 선택, report, audit, GitHub installation metadata 스키마.
- `apps/web/lib/tool-deployment-repository.ts`: PostgreSQL 저장소와 transaction 경계.
- `apps/web/lib/tool-deployment-service.ts`: 권한 검사, desired manifest 조립, 개인/팀 mutation 서비스.
- `apps/web/lib/tool-source.ts`: 공개 GitHub ref 고정, manifest 검증, canonical tree digest 계산.
- `apps/web/lib/github-app-source.ts`: GitHub App installation token을 메모리에서만 사용해 짧은 download URL을 발급.
- `apps/web/app/api/v1/tool-deployment/manifest/route.ts`: shim용 ETag manifest API.
- `apps/web/app/api/v1/tool-deployment/reports/route.ts`: 비밀값 없는 상태 report API.
- `apps/web/app/(dashboard)/library/[slug]/tool-install-panel.tsx`: 개인 설치·기기 선택·설정 필요 상태 UI.
- `apps/web/app/(dashboard)/library/[slug]/tool-install-actions.ts`: 개인 설치, 제외, 권한 승인 server action.
- `apps/web/app/(dashboard)/library/[slug]/team-deployment-panel.tsx`: 팀 리더용 영향도 확인·기본 배포·rollout UI.
- `apps/web/app/(dashboard)/admin/team-role-select.tsx`: 관리자용 팀 리더 지정 UI.
- `shim/rust/src/tool_deployment/protocol.rs`: 서버 JSON 계약.
- `shim/rust/src/tool_deployment/state.rs`: `~/.toard/tools/state.json`과 로컬 secret/LKG 모델.
- `shim/rust/src/tool_deployment/plan.rs`: desired/current 비교와 install/update/remove/no-op 계획.
- `shim/rust/src/tool_deployment/source.rs`: archive 제한·경로 검증·canonical digest.
- `shim/rust/src/tool_deployment/adapters.rs`: Claude Code/Codex 설정의 managed-key 병합.
- `shim/rust/src/tool_deployment/reconcile.rs`: staging, atomic apply, health check, rollback, report 생성.
- `shim/rust/src/tool_deployment/client.rs`: ETag 조회와 report POST.
- `shim/rust/src/tool_deployment/mod.rs`: daemon·wrapper·CLI 진입점.

### Task 1: Shared Deployment Contract and Pure Policy Engine

**Files:**
- Create: `packages/core/src/tool-deployment.ts`
- Create: `packages/core/src/tool-deployment.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: 기존 `ToolCatalogKind`, `ToolCatalogClient`.
- Produces: `ToolDeploymentManifestV1`, `resolveDesiredTools()`, `diffToolPermissions()`, `rolloutCohortPercent()`, `evaluateRollout()`.

- [ ] **Step 1: Write failing policy tests**

```ts
test("exclude > personal install > team default 순서로 원하는 상태를 계산한다", () => {
  const desired = resolveDesiredTools({
    userId: "u1",
    deviceFingerprint: "d1",
    preferences: [
      { catalogItemId: "excluded", mode: "exclude", scope: "all_devices", versionId: null, deviceFingerprints: [] },
      { catalogItemId: "personal", mode: "install", scope: "selected_devices", versionId: "v2", deviceFingerprints: ["d1"] },
    ],
    teamPolicies: [
      { catalogItemId: "excluded", versionId: "v1", rolloutPercent: 100 },
      { catalogItemId: "personal", versionId: "v1", rolloutPercent: 100 },
      { catalogItemId: "team", versionId: "v1", rolloutPercent: 100 },
    ],
  });
  assert.deepEqual(desired.map(({ catalogItemId, versionId, origin }) => ({ catalogItemId, versionId, origin })), [
    { catalogItemId: "personal", versionId: "v2", origin: "personal" },
    { catalogItemId: "team", versionId: "v1", origin: "team" },
  ]);
});

test("권한 확대와 source identity 변경은 자동 업데이트를 중단한다", () => {
  const diff = diffToolPermissions(baseManifest, {
    ...baseManifest,
    source: { ...baseManifest.source, repository: "other/repo" },
    permissions: { env: ["TOKEN", "NEW_TOKEN"], networkHosts: ["api.example.com"], executables: ["node"] },
  });
  assert.deepEqual(diff, { approvalRequired: true, addedEnv: ["NEW_TOKEN"], addedHosts: [], sourceChanged: true, commandChanged: false, componentsAdded: [] });
});

test("rollout cohort는 같은 rollout/device에서 결정적이고 실패 임계값을 적용한다", () => {
  assert.equal(rolloutCohortPercent("rollout-1", "device-1"), rolloutCohortPercent("rollout-1", "device-1"));
  assert.deepEqual(evaluateRollout({ phase: "canary", eligible: 10, attempted: 2, failed: 2, phaseStartedAt: new Date(0) }, new Date(31 * 60_000)), { action: "rollback", reason: "failure_threshold" });
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `pnpm --filter @toard/core test`

Expected: FAIL with `Cannot find module './tool-deployment'`.

- [ ] **Step 3: Implement the complete shared contract**

```ts
export type ToolDeploymentStatus = "queued" | "applying" | "settings_required" | "installed" | "conflict" | "failed" | "rolled_back" | "excluded" | "unsupported";
export type ToolDeploymentOrigin = "personal" | "team";
export type ToolRolloutPhase = "preflight" | "canary" | "expand" | "active" | "paused" | "rollback";
export type ToolDeploymentManifestV1 = {
  schemaVersion: 1;
  catalogItemId: string;
  versionId: string;
  slug: string;
  kind: "skill" | "mcp" | "plugin";
  source: { provider: "github"; repository: string; exactRef: string; path: string; treeDigest: string; downloadUrl: string };
  clients: ("codex" | "claude_code")[];
  minProtocolVersion: 1;
  permissions: { env: string[]; networkHosts: string[]; executables: string[] };
  payload:
    | { type: "skill"; files: string[]; targetKey: string }
    | { type: "mcp_stdio"; command: string; args: string[]; requiredEnvNames: string[]; managedKey: string }
    | { type: "mcp_http"; url: string; auth: "none" | "oauth" | "manual_secret_header"; managedKey: string }
    | { type: "plugin"; components: { type: "skill" | "mcp_stdio" | "mcp_http"; key: string }[] };
};

export function resolveDesiredTools(input: ResolveDesiredInput): DesiredTool[] {
  const excluded = new Set(input.preferences.filter((p) => p.mode === "exclude").map((p) => p.catalogItemId));
  const personal = new Map(input.preferences.filter((p) => p.mode === "install" && (p.scope === "all_devices" || p.deviceFingerprints.includes(input.deviceFingerprint))).map((p) => [p.catalogItemId, p]));
  const ids = [...new Set([...personal.keys(), ...input.teamPolicies.map((p) => p.catalogItemId)])].sort();
  return ids.flatMap((catalogItemId) => {
    if (excluded.has(catalogItemId)) return [];
    const own = personal.get(catalogItemId);
    if (own?.versionId) return [{ catalogItemId, versionId: own.versionId, origin: "personal" as const }];
    const team = input.teamPolicies.find((p) => p.catalogItemId === catalogItemId);
    if (!team || rolloutCohortPercent(catalogItemId, input.deviceFingerprint) >= team.rolloutPercent) return [];
    return [{ catalogItemId, versionId: team.versionId, origin: "team" as const }];
  });
}

export function rolloutCohortPercent(seed: string, fingerprint: string): number {
  let hash = 2166136261;
  for (const byte of new TextEncoder().encode(`${seed}:${fingerprint}`)) hash = Math.imul(hash ^ byte, 16777619);
  return (hash >>> 0) % 100;
}

export function evaluateRollout(state: RolloutEvaluation, now: Date): RolloutDecision {
  if (state.failed >= 2 || (state.attempted > 0 && state.failed / state.attempted >= 0.2)) return { action: "rollback", reason: "failure_threshold" };
  const elapsed = now.getTime() - state.phaseStartedAt.getTime();
  if (state.phase === "canary" && elapsed >= 30 * 60_000 && state.attempted >= Math.max(1, Math.ceil(state.eligible * 0.1))) return { action: "advance", nextPhase: "expand", percent: 50 };
  if (state.phase === "expand" && elapsed >= 60 * 60_000) return { action: "advance", nextPhase: "active", percent: 100 };
  return { action: "hold" };
}
```

- [ ] **Step 4: Export and verify GREEN**

Add `export * from "./tool-deployment";` to `packages/core/src/index.ts`.

Run: `pnpm --filter @toard/core test && pnpm --filter @toard/core typecheck`

Expected: all core tests PASS and TypeScript exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tool-deployment.ts packages/core/src/tool-deployment.test.ts packages/core/src/index.ts
git commit -m "feat(core): 도구 배포 정책 계약 추가"
```

### Task 2: PostgreSQL Deployment Repository and Team Roles

**Files:**
- Create: `migrations/1700000045_tool_deployment.sql`
- Create: `apps/web/lib/tool-deployment-repository.ts`
- Create: `apps/web/lib/tool-deployment-repository.test.ts`
- Modify: `apps/web/lib/session-user.ts`

**Interfaces:**
- Consumes: Task 1 types and `getPool()`.
- Produces: `ToolDeploymentRepository`, `getDeviceContext()`, `savePersonalPreference()`, `saveTeamPolicy()`, `saveDeploymentReport()`.

- [ ] **Step 1: Write failing schema and repository tests**

```ts
test("migration은 immutable version과 정책/report/audit 관계를 만든다", () => {
  const sql = readFileSync(resolve(process.cwd(), "../../migrations/1700000045_tool_deployment.sql"), "utf8");
  for (const table of ["tool_versions", "team_tool_policies", "user_tool_preferences", "user_tool_preference_devices", "tool_deployment_reports", "tool_deployment_audit", "github_app_installations"]) assert.match(sql, new RegExp(`CREATE TABLE ${table}`));
  assert.match(sql, /UNIQUE \(catalog_item_id, source_identity, exact_ref, tree_digest\)/);
  assert.match(sql, /CHECK \(status IN \('queued'.*'unsupported'\)\)/s);
});

test("개인 선택 저장은 actor 소유권과 audit을 한 transaction에서 기록한다", async () => {
  const db = fakeTransactionDb();
  const repo = createToolDeploymentRepository(db);
  await repo.savePersonalPreference({ actorUserId: "u1", catalogItemId: "c1", mode: "install", scope: "selected_devices", versionId: "v1", deviceFingerprints: ["d1"] });
  assert.equal(db.commits, 1);
  assert.match(db.queries.join("\n"), /INSERT INTO user_tool_preferences/);
  assert.match(db.queries.join("\n"), /INSERT INTO user_tool_preference_devices/);
  assert.match(db.queries.join("\n"), /INSERT INTO tool_deployment_audit/);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `pnpm --filter @toard/web test -- tool-deployment-repository.test.ts`

Expected: FAIL because the migration and repository do not exist.

- [ ] **Step 3: Add the migration with strict checks and cascade rules**

```sql
ALTER TABLE users ADD COLUMN team_role TEXT NOT NULL DEFAULT 'member' CHECK (team_role IN ('member', 'leader'));

CREATE TABLE tool_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  catalog_item_id UUID NOT NULL REFERENCES tool_catalog_items(id) ON DELETE CASCADE,
  source_identity TEXT NOT NULL,
  exact_ref TEXT NOT NULL,
  source_path TEXT NOT NULL DEFAULT '',
  tree_digest TEXT NOT NULL CHECK (tree_digest ~ '^sha256:[a-f0-9]{64}$'),
  manifest JSONB NOT NULL,
  permission_fingerprint TEXT NOT NULL CHECK (permission_fingerprint ~ '^sha256:[a-f0-9]{64}$'),
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (catalog_item_id, source_identity, exact_ref, tree_digest)
);

CREATE TABLE team_tool_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  catalog_item_id UUID NOT NULL REFERENCES tool_catalog_items(id) ON DELETE CASCADE,
  target_version_id UUID NOT NULL REFERENCES tool_versions(id), last_known_good_version_id UUID REFERENCES tool_versions(id),
  tracking_mode TEXT NOT NULL DEFAULT 'auto' CHECK (tracking_mode IN ('auto','pinned')),
  rollout_phase TEXT NOT NULL DEFAULT 'preflight' CHECK (rollout_phase IN ('preflight','canary','expand','active','paused','rollback')),
  rollout_percent INTEGER NOT NULL DEFAULT 0 CHECK (rollout_percent BETWEEN 0 AND 100), rollout_seed UUID NOT NULL DEFAULT gen_random_uuid(),
  phase_started_at TIMESTAMPTZ NOT NULL DEFAULT now(), enabled BOOLEAN NOT NULL DEFAULT true,
  created_by UUID NOT NULL REFERENCES users(id), updated_by UUID NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (team_id, catalog_item_id)
);
```

Append these exact normalized tables and the reverse-order Down Migration:

```sql
CREATE TABLE user_tool_preferences (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  catalog_item_id UUID NOT NULL REFERENCES tool_catalog_items(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('install','exclude')),
  install_scope TEXT NOT NULL DEFAULT 'all_devices' CHECK (install_scope IN ('all_devices','selected_devices')),
  target_version_id UUID REFERENCES tool_versions(id),
  tracking_mode TEXT NOT NULL DEFAULT 'auto' CHECK (tracking_mode IN ('auto','pinned')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, catalog_item_id),
  CHECK ((mode = 'exclude' AND target_version_id IS NULL) OR mode = 'install')
);
CREATE TABLE user_tool_preference_devices (
  user_id UUID NOT NULL, catalog_item_id UUID NOT NULL,
  device_fingerprint TEXT NOT NULL CHECK (device_fingerprint ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (user_id, catalog_item_id, device_fingerprint),
  FOREIGN KEY (user_id, catalog_item_id) REFERENCES user_tool_preferences(user_id, catalog_item_id) ON DELETE CASCADE
);
CREATE TABLE tool_deployment_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES users(id),
  ingest_token_id UUID NOT NULL REFERENCES ingest_tokens(id), device_fingerprint TEXT NOT NULL CHECK (device_fingerprint ~ '^[a-f0-9]{64}$'),
  catalog_item_id UUID NOT NULL REFERENCES tool_catalog_items(id), desired_version_id UUID REFERENCES tool_versions(id), applied_version_id UUID REFERENCES tool_versions(id),
  status TEXT NOT NULL CHECK (status IN ('queued','applying','settings_required','installed','conflict','failed','rolled_back','excluded','unsupported')),
  error_code TEXT, attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0), rollout_id UUID,
  first_attempted_at TIMESTAMPTZ, last_attempted_at TIMESTAMPTZ, applied_at TIMESTAMPTZ, rolled_back_at TIMESTAMPTZ,
  UNIQUE (ingest_token_id, device_fingerprint, catalog_item_id)
);
CREATE TABLE tool_deployment_audit (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, actor_user_id UUID NOT NULL REFERENCES users(id),
  action TEXT NOT NULL, team_id UUID REFERENCES teams(id), catalog_item_id UUID REFERENCES tool_catalog_items(id),
  before_value JSONB, after_value JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE github_app_installations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), installation_id BIGINT NOT NULL UNIQUE,
  account_login TEXT NOT NULL, account_id BIGINT NOT NULL, created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Down Migration
DROP TABLE IF EXISTS github_app_installations;
DROP TABLE IF EXISTS tool_deployment_audit;
DROP TABLE IF EXISTS tool_deployment_reports;
DROP TABLE IF EXISTS user_tool_preference_devices;
DROP TABLE IF EXISTS user_tool_preferences;
DROP TABLE IF EXISTS team_tool_policies;
DROP TABLE IF EXISTS tool_versions;
ALTER TABLE users DROP COLUMN IF EXISTS team_role;
```

- [ ] **Step 4: Implement transaction-backed repository methods**

```ts
export function createToolDeploymentRepository(db: TransactionalDb): ToolDeploymentRepository {
  return {
    async savePersonalPreference(input) {
      await db.transaction(async (tx) => {
        await tx.query(`INSERT INTO user_tool_preferences (user_id,catalog_item_id,mode,install_scope,target_version_id,tracking_mode)
          VALUES ($1,$2,$3,$4,$5,'auto') ON CONFLICT (user_id,catalog_item_id) DO UPDATE SET mode=EXCLUDED.mode,install_scope=EXCLUDED.install_scope,target_version_id=EXCLUDED.target_version_id,updated_at=now()`, [input.actorUserId,input.catalogItemId,input.mode,input.scope,input.versionId]);
        await tx.query("DELETE FROM user_tool_preference_devices WHERE user_id=$1 AND catalog_item_id=$2", [input.actorUserId,input.catalogItemId]);
        for (const fingerprint of [...new Set(input.deviceFingerprints)].sort()) await tx.query("INSERT INTO user_tool_preference_devices (user_id,catalog_item_id,device_fingerprint) VALUES ($1,$2,$3)", [input.actorUserId,input.catalogItemId,fingerprint]);
        await tx.query("INSERT INTO tool_deployment_audit (actor_user_id,action,catalog_item_id,after_value) VALUES ($1,'personal_preference_changed',$2,$3::jsonb)", [input.actorUserId,input.catalogItemId,JSON.stringify({ mode: input.mode, scope: input.scope, versionId: input.versionId, deviceFingerprints: input.deviceFingerprints })]);
      });
    },
    async saveDeploymentReport(owner, report) {
      await db.query(`INSERT INTO tool_deployment_reports (user_id,ingest_token_id,device_fingerprint,catalog_item_id,desired_version_id,applied_version_id,status,error_code,attempt,rollout_id,last_attempted_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now()) ON CONFLICT (ingest_token_id,device_fingerprint,catalog_item_id) DO UPDATE SET desired_version_id=EXCLUDED.desired_version_id,applied_version_id=EXCLUDED.applied_version_id,status=EXCLUDED.status,error_code=EXCLUDED.error_code,attempt=EXCLUDED.attempt,rollout_id=EXCLUDED.rollout_id,last_attempted_at=now()`, [owner.userId,owner.tokenId,report.deviceFingerprint,report.catalogItemId,report.desiredVersionId,report.appliedVersionId,report.status,report.errorCode,report.attempt,report.rolloutId]);
    },
  };
}
```

- [ ] **Step 5: Add `teamRole` to session lookup and verify GREEN**

Extend `SessionUser` with `teamRole: "member" | "leader"`, select `u.team_role`, and normalize teamless users to `member`.

Run: `pnpm --filter @toard/web test -- tool-deployment-repository.test.ts && pnpm --filter @toard/web typecheck`

Expected: repository tests PASS and TypeScript exits 0.

- [ ] **Step 6: Commit**

```bash
git add migrations/1700000045_tool_deployment.sql apps/web/lib/tool-deployment-repository.ts apps/web/lib/tool-deployment-repository.test.ts apps/web/lib/session-user.ts
git commit -m "feat(web): 도구 배포 상태 저장소 추가"
```

### Task 3: Immutable Source Import and GitHub App Boundary

**Files:**
- Create: `apps/web/lib/tool-source.ts`
- Create: `apps/web/lib/tool-source.test.ts`
- Create: `apps/web/lib/github-app-source.ts`
- Create: `apps/web/lib/github-app-source.test.ts`
- Modify: `apps/web/lib/tool-deployment-repository.ts`

**Interfaces:**
- Consumes: `ToolDeploymentManifestV1`, `tool_versions` repository.
- Produces: `canonicalTreeDigest(files)`, `validateInstallManifest()`, `resolveGitHubSource()`, `createPrivateDownloadUrl()`.

- [ ] **Step 1: Write failing digest, validation, and token-retention tests**

```ts
test("canonical digest는 archive metadata와 입력 순서에 무관하다", () => {
  const a = canonicalTreeDigest([{ path: "SKILL.md", bytes: bytes("a") }, { path: "ref/x.md", bytes: bytes("b") }]);
  const b = canonicalTreeDigest([{ path: "ref/x.md", bytes: bytes("b") }, { path: "SKILL.md", bytes: bytes("a") }]);
  assert.equal(a, b);
});

test("manifest는 shell string, traversal, unpinned package를 거부한다", () => {
  assert.throws(() => validateInstallManifest({ ...valid, payload: { type: "mcp_stdio", command: "sh -c curl bad", args: [], requiredEnvNames: [], managedKey: "x" } }), /command/);
  assert.throws(() => validateInstallManifest({ ...validSkill, payload: { ...validSkill.payload, files: ["../secret"] } }), /path/);
  assert.throws(() => validateInstallManifest({ ...valid, payload: { type: "mcp_stdio", command: "npx", args: ["pkg@latest"], requiredEnvNames: [], managedKey: "x" } }), /pinned/);
});

test("GitHub installation token은 callback 밖으로 반환하거나 DB에 기록하지 않는다", async () => {
  const seen: string[] = [];
  const url = await createPrivateDownloadUrl({ installationId: 7, owner: "acme", repo: "private", ref: "a".repeat(40) }, { issueToken: async () => "secret-token", requestArchive: async (_input, token) => { seen.push(token); return "https://provider.example/short"; } });
  assert.equal(url, "https://provider.example/short");
  assert.deepEqual(seen, ["secret-token"]);
  assert.equal(JSON.stringify(url).includes("secret-token"), false);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `pnpm --filter @toard/web test -- tool-source.test.ts github-app-source.test.ts`

Expected: FAIL because source modules do not exist.

- [ ] **Step 3: Implement canonical digest and restricted manifest validation**

```ts
export function canonicalTreeDigest(files: readonly SourceFile[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const path = normalizeSafeRelativePath(file.path);
    hash.update(String(Buffer.byteLength(path))).update(":").update(path).update(":").update(String(file.bytes.byteLength)).update(":").update(file.bytes);
  }
  return `sha256:${hash.digest("hex")}`;
}

export function validateInstallManifest(value: ToolDeploymentManifestV1): ToolDeploymentManifestV1 {
  if (value.schemaVersion !== 1 || value.minProtocolVersion !== 1) throw new Error("unsupported schema");
  if (!/^sha256:[a-f0-9]{64}$/.test(value.source.treeDigest)) throw new Error("invalid digest");
  if (value.payload.type === "mcp_stdio") {
    if (!/^[A-Za-z0-9._+-]+$/.test(value.payload.command)) throw new Error("invalid command");
    if (value.payload.command === "npx" && !value.payload.args.some((arg) => /@\d+\.\d+\.\d+/.test(arg))) throw new Error("package must be pinned");
  }
  if (value.payload.type === "skill") value.payload.files.forEach(normalizeSafeRelativePath);
  return value;
}
```

- [ ] **Step 4: Implement short-lived GitHub URL issuance without persistence**

```ts
export async function createPrivateDownloadUrl(input: PrivateGitHubSource, github: GitHubAppClient): Promise<string> {
  const token = await github.issueToken(input.installationId);
  try {
    const url = await github.requestArchive(input, token);
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") throw new Error("GitHub archive URL must use HTTPS");
    return parsed.toString();
  } finally {
    // token은 이 stack frame 밖으로 노출하거나 저장하지 않는다.
  }
}
```

- [ ] **Step 5: Verify GREEN and commit**

Run: `pnpm --filter @toard/web test -- tool-source.test.ts github-app-source.test.ts && pnpm --filter @toard/web typecheck`

Expected: source tests PASS and TypeScript exits 0.

```bash
git add apps/web/lib/tool-source.ts apps/web/lib/tool-source.test.ts apps/web/lib/github-app-source.ts apps/web/lib/github-app-source.test.ts apps/web/lib/tool-deployment-repository.ts
git commit -m "feat(web): 변경 불가 도구 원본 등록 추가"
```

### Task 4: Desired Manifest and Report APIs

**Files:**
- Create: `apps/web/lib/tool-deployment-service.ts`
- Create: `apps/web/lib/tool-deployment-service.test.ts`
- Create: `apps/web/app/api/v1/tool-deployment/manifest/route.ts`
- Create: `apps/web/app/api/v1/tool-deployment/reports/route.ts`
- Create: `apps/web/lib/tool-deployment-api.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3 repository, resolver, immutable versions.
- Produces: authenticated `GET manifest`, `POST reports`, `mutatePersonalPreference()`, `mutateTeamPolicy()`.

- [ ] **Step 1: Write failing API and authorization tests**

```ts
test("manifest API는 토큰 소유 기기만 계산하고 ETag가 같으면 304를 준다", async () => {
  const first = await getManifest(request({ fingerprint: DEVICE, protocol: "1" }), deps);
  assert.equal(first.status, 200);
  const etag = first.headers.get("etag");
  const second = await getManifest(request({ fingerprint: DEVICE, protocol: "1", etag }), deps);
  assert.equal(second.status, 304);
});

test("report API는 비밀값처럼 보이는 필드와 등록되지 않은 기기를 거부한다", async () => {
  assert.equal((await postReports(requestBody({ ...validReport, env: { TOKEN: "secret" } }), deps)).status, 400);
  assert.equal((await postReports(requestBody({ ...validReport, deviceFingerprint: UNKNOWN }), deps)).status, 403);
});

test("leader는 자기 팀만 바꾸고 admin은 승인 gate가 아니다", async () => {
  assert.deepEqual(await mutateTeamPolicy(leaderOf("team-a"), policy("team-b"), deps), { ok: false, reason: "forbidden" });
  assert.deepEqual(await mutateTeamPolicy(leaderOf("team-a"), policy("team-a"), deps), { ok: true });
});
```

- [ ] **Step 2: Run and verify RED**

Run: `pnpm --filter @toard/web test -- tool-deployment-service.test.ts tool-deployment-api.test.ts`

Expected: FAIL because service and routes do not exist.

- [ ] **Step 3: Implement service authorization and manifest assembly**

```ts
export async function buildDeviceManifest(owner: IngestAuthResult, input: ManifestRequest, repo: ToolDeploymentRepository): Promise<DeviceManifestV1> {
  if (input.protocol !== 1) throw new DeploymentClientError(426, "protocol_unsupported");
  const context = await repo.getDeviceContext(owner, input.deviceFingerprint);
  if (!context) throw new DeploymentClientError(403, "device_not_owned");
  const desired = resolveDesiredTools(context);
  const items = await Promise.all(desired.map(async (entry) => ({ ...entry, manifest: await repo.getManifestVersion(entry.versionId) })));
  return { schemaVersion: 1, generatedAt: new Date(), reconcileAfterSeconds: 60, items };
}

export async function mutateTeamPolicy(actor: SessionUser, input: TeamPolicyInput, repo: ToolDeploymentRepository): Promise<MutationResult> {
  if (actor.teamRole !== "leader" || actor.teamId !== input.teamId) return { ok: false, reason: "forbidden" };
  const diff = await repo.permissionDiffFromLastKnownGood(input.catalogItemId, input.versionId);
  await repo.saveTeamPolicy({ ...input, actorUserId: actor.id, rolloutPhase: diff.approvalRequired ? "paused" : "preflight", rolloutPercent: 0 });
  return { ok: true };
}
```

- [ ] **Step 4: Implement thin routes with bounded JSON and ETag**

```ts
export async function GET(req: Request): Promise<Response> {
  const owner = await authenticateIngestToken(req.headers.get("authorization"));
  if (!owner) return new Response("unauthorized", { status: 401 });
  const fingerprint = new URL(req.url).searchParams.get("fingerprint") ?? "";
  const manifest = await buildDeviceManifest(owner, { fingerprint, protocol: Number(req.headers.get("x-toard-tool-protocol")) }, repository());
  const body = JSON.stringify(manifest);
  const etag = `\"${createHash("sha256").update(body).digest("hex")}\"`;
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { etag } });
  return new Response(body, { status: 200, headers: { "content-type": "application/json", etag, "cache-control": "private, no-cache" } });
}
```

Implement the report route with the exact 256 KiB bound and closed field parser:

```ts
const MAX_REPORT_BYTES = 256 * 1024;
const REPORT_KEYS = new Set(["deviceFingerprint","catalogItemId","desiredVersionId","appliedVersionId","status","errorCode","attempt","rolloutId"]);
export async function POST(req: Request): Promise<Response> {
  const owner = await authenticateIngestToken(req.headers.get("authorization"));
  if (!owner) return new Response("unauthorized", { status: 401 });
  const raw = await readBoundedJson(req, MAX_REPORT_BYTES);
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some((key) => !REPORT_KEYS.has(key))) return Response.json({ error: "invalid_report" }, { status: 400 });
  const report = parseDeploymentReport(raw);
  if (!(await repository().deviceBelongsToToken(owner, report.deviceFingerprint))) return Response.json({ error: "device_not_owned" }, { status: 403 });
  await repository().saveDeploymentReport(owner, report);
  return Response.json({ accepted: true }, { status: 202 });
}
```

- [ ] **Step 5: Verify GREEN and commit**

Run: `pnpm --filter @toard/web test -- tool-deployment-service.test.ts tool-deployment-api.test.ts && pnpm --filter @toard/web typecheck`

Expected: service/API tests PASS and TypeScript exits 0.

```bash
git add apps/web/lib/tool-deployment-service.ts apps/web/lib/tool-deployment-service.test.ts apps/web/app/api/v1/tool-deployment apps/web/lib/tool-deployment-api.test.ts
git commit -m "feat(api): 기기별 도구 배포 API 추가"
```

### Task 5: Shim Planner, Safe Source Extraction, and Managed Adapters

**Files:**
- Create: `shim/rust/src/tool_deployment/protocol.rs`
- Create: `shim/rust/src/tool_deployment/state.rs`
- Create: `shim/rust/src/tool_deployment/plan.rs`
- Create: `shim/rust/src/tool_deployment/source.rs`
- Create: `shim/rust/src/tool_deployment/adapters.rs`
- Create: `shim/rust/src/tool_deployment/mod.rs`
- Modify: `shim/rust/src/main.rs`
- Modify: `shim/rust/Cargo.toml`

**Interfaces:**
- Consumes: Task 1 JSON contract and existing `fsx::write_atomic()`.
- Produces: `PlanAction`, `validate_archive_entry()`, `canonical_tree_digest()`, `merge_managed_entry()`.

- [ ] **Step 1: Write failing Rust unit tests**

```rust
#[test]
fn unmanaged_same_key_is_a_conflict() {
    let current = ManagedState::default();
    let config = json!({"mcpServers":{"github":{"command":"user-owned"}}});
    let err = merge_managed_entry(&config, &current, "github", json!({"command":"toard-shim"})).unwrap_err();
    assert_eq!(err.code(), "unmanaged_conflict");
}

#[test]
fn archive_rejects_traversal_symlink_and_limits() {
    assert!(validate_archive_entry("../secret", EntryKind::File, 1).is_err());
    assert!(validate_archive_entry("skill/link", EntryKind::Symlink, 1).is_err());
    assert!(validate_archive_entry("skill/big", EntryKind::File, MAX_ARCHIVE_BYTES + 1).is_err());
}

#[test]
fn planner_keeps_lkg_when_server_is_empty_or_invalid() {
    let current = state_with_installed("tool", "v1");
    assert_eq!(plan(&current, &[]), vec![PlanAction::Remove { slug: "tool".into(), version_id: "v1".into() }]);
    assert_eq!(plan_after_fetch_error(&current), vec![PlanAction::Noop { slug: "tool".into() }]);
}
```

- [ ] **Step 2: Run and verify RED**

Run: `cargo test --manifest-path shim/rust/Cargo.toml tool_deployment --quiet`

Expected: compilation FAIL because `tool_deployment` does not exist.

- [ ] **Step 3: Implement protocol/state/planner as pure Rust**

```rust
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceManifestV1 { pub schema_version: u8, pub reconcile_after_seconds: u64, pub items: Vec<DesiredItem> }

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlanAction { Install { slug: String, version_id: String }, Update { slug: String, from: String, to: String }, Remove { slug: String, version_id: String }, Noop { slug: String } }

pub fn plan(current: &ManagedState, desired: &[DesiredItem]) -> Vec<PlanAction> {
    let desired_by_slug: BTreeMap<_, _> = desired.iter().map(|item| (item.manifest.slug.as_str(), item)).collect();
    let mut actions = Vec::new();
    for item in desired { match current.items.get(&item.manifest.slug) { None => actions.push(PlanAction::Install { slug: item.manifest.slug.clone(), version_id: item.manifest.version_id.clone() }), Some(cur) if cur.version_id != item.manifest.version_id => actions.push(PlanAction::Update { slug: item.manifest.slug.clone(), from: cur.version_id.clone(), to: item.manifest.version_id.clone() }), Some(_) => actions.push(PlanAction::Noop { slug: item.manifest.slug.clone() }) } }
    for (slug, cur) in &current.items { if !desired_by_slug.contains_key(slug.as_str()) { actions.push(PlanAction::Remove { slug: slug.clone(), version_id: cur.version_id.clone() }); } }
    actions
}
```

- [ ] **Step 4: Implement bounded source validation and managed-key merge**

Implement the fixed archive limits and managed-key conflict boundary:

```rust
pub const MAX_ARCHIVE_BYTES: u64 = 50 * 1024 * 1024;
pub const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;
pub const MAX_FILE_COUNT: usize = 2_000;

pub fn validate_archive_entry(path: &str, kind: EntryKind, size: u64) -> Result<PathBuf, DeployError> {
    if size > MAX_FILE_BYTES || matches!(kind, EntryKind::Symlink | EntryKind::Hardlink | EntryKind::Device) {
        return Err(DeployError::unsafe_archive());
    }
    if path.contains('\0') { return Err(DeployError::unsafe_archive()); }
    let candidate = Path::new(path);
    if candidate.is_absolute() || candidate.components().any(|part| matches!(part, Component::ParentDir | Component::RootDir | Component::Prefix(_))) {
        return Err(DeployError::unsafe_archive());
    }
    Ok(candidate.to_path_buf())
}

pub fn merge_managed_entry(root: &Value, state: &ManagedState, key: &str, entry: Value) -> Result<Value, DeployError> {
    let exists = root.get("mcpServers").and_then(Value::as_object).is_some_and(|map| map.contains_key(key));
    if exists && !state.managed_keys.contains(key) { return Err(DeployError::unmanaged_conflict()); }
    let mut next = root.clone();
    next.as_object_mut().unwrap().entry("mcpServers").or_insert_with(|| json!({})).as_object_mut().unwrap().insert(key.to_owned(), entry);
    Ok(next)
}
```

- [ ] **Step 5: Register the module and verify GREEN**

Add `mod tool_deployment;` to `main.rs`. Add only the archive/HTTP dependencies selected by the implementation with exact versions to `Cargo.toml`; disable unnecessary default TLS features and use rustls.

Run: `cargo test --manifest-path shim/rust/Cargo.toml tool_deployment --quiet`

Expected: all `tool_deployment` tests PASS.

- [ ] **Step 6: Commit**

```bash
git add shim/rust/src/tool_deployment shim/rust/src/main.rs shim/rust/Cargo.toml shim/rust/Cargo.lock
git commit -m "feat(shim): 안전한 도구 배포 계획 엔진 추가"
```

### Task 6: Shim Reconcile, Local Secrets, Launcher, and Daemon Integration

**Files:**
- Create: `shim/rust/src/tool_deployment/client.rs`
- Create: `shim/rust/src/tool_deployment/reconcile.rs`
- Modify: `shim/rust/src/tool_deployment/mod.rs`
- Modify: `shim/rust/src/cli.rs`
- Modify: `shim/rust/src/daemon.rs`
- Modify: `shim/rust/src/main.rs`

**Interfaces:**
- Consumes: Task 5 planner/source/adapters and existing credentials.
- Produces: `reconcile_once()`, `configure_secret()`, `run_mcp()`, 60-second background reconcile.

- [ ] **Step 1: Write failing transaction, redaction, and CLI tests**

```rust
#[test]
fn failed_health_check_restores_files_config_and_lkg() {
    let fixture = Fixture::installed("tool", "v1");
    let result = fixture.reconcile_with_health_failure(manifest("v2"));
    assert_eq!(result.report.status, Status::RolledBack);
    assert_eq!(fixture.read_active_version("tool"), "v1");
    assert_eq!(fixture.read_client_config(), fixture.original_config());
}

#[test]
fn report_serialization_never_contains_secret_values() {
    let secret = SecretValue::new("never-send-me".into());
    let report = settings_required_report(&["TOKEN"], &secret);
    assert!(!serde_json::to_string(&report).unwrap().contains("never-send-me"));
}

#[test]
fn run_mcp_injects_local_secret_without_writing_client_config() {
    let launch = build_mcp_launch(&manifest(), &secret_store([("TOKEN", "local-value")]));
    assert_eq!(launch.env.get("TOKEN").map(String::as_str), Some("local-value"));
    assert!(!serde_json::to_string(&launch.managed_client_entry).unwrap().contains("local-value"));
}
```

- [ ] **Step 2: Run and verify RED**

Run: `cargo test --manifest-path shim/rust/Cargo.toml tool_deployment --quiet`

Expected: FAIL because reconcile/client/secret functions do not exist.

- [ ] **Step 3: Implement atomic reconcile and local rollback**

```rust
pub fn reconcile_item(ctx: &Context, desired: &DesiredItem) -> DeploymentReport {
    let transaction = match Transaction::stage(ctx, desired) { Ok(tx) => tx, Err(err) => return DeploymentReport::failed(desired, err.code()) };
    if let Err(err) = transaction.verify_digest().and_then(|_| transaction.preflight()).and_then(|_| transaction.apply()).and_then(|_| transaction.health_check()) {
        let restored = transaction.rollback();
        return if restored.is_ok() { DeploymentReport::rolled_back(desired, err.code()) } else { DeploymentReport::failed(desired, "rollback_failed") };
    }
    transaction.commit_lkg();
    if transaction.missing_secret_names().is_empty() { DeploymentReport::installed(desired) } else { DeploymentReport::settings_required(desired, "local_secret_missing") }
}
```

- [ ] **Step 4: Implement secret storage and fixed MCP launcher**

`toard-shim tool configure <slug>` reads required names, prompts with terminal echo disabled, and stores values through OS keyring with a `0600` JSON fallback under `~/.toard/tools/secrets/`. `toard-shim tool run-mcp <deployment-id>` loads the immutable command/args from managed state, injects only declared environment names, and replaces itself with that command. Neither command prints values.

- [ ] **Step 5: Integrate ETag client and 60-second daemon cadence**

Store ETag and next-attempt timestamp in `~/.toard/tools/client-state.json`. A `304` schedules the next lookup; transport/JSON/protocol failures preserve current LKG and use bounded exponential backoff of 60, 120, 240, 480, then 900 seconds. Add a non-blocking background reconcile when the claude/codex wrapper starts; never wait for network before launching the real binary.

- [ ] **Step 6: Verify GREEN and commit**

Run: `cargo test --manifest-path shim/rust/Cargo.toml --quiet`

Expected: all Rust suites PASS, including rollback and secret redaction tests.

```bash
git add shim/rust/src/tool_deployment shim/rust/src/cli.rs shim/rust/src/daemon.rs shim/rust/src/main.rs shim/rust/Cargo.toml shim/rust/Cargo.lock
git commit -m "feat(shim): 도구 설치와 로컬 롤백 연결"
```

### Task 7: Individual Install, Team Default, Status, and Leader Administration UI

**Files:**
- Create: `apps/web/app/(dashboard)/library/[slug]/tool-install-actions.ts`
- Create: `apps/web/app/(dashboard)/library/[slug]/tool-install-panel.tsx`
- Create: `apps/web/app/(dashboard)/library/[slug]/team-deployment-panel.tsx`
- Create: `apps/web/app/(dashboard)/admin/team-role-select.tsx`
- Modify: `apps/web/app/(dashboard)/library/[slug]/page.tsx`
- Modify: `apps/web/app/(dashboard)/admin/page.tsx`
- Modify: `apps/web/app/(dashboard)/admin/team-actions.ts`
- Modify: `apps/web/messages/ko/library.json`
- Modify: `apps/web/messages/en/library.json`
- Modify: `apps/web/messages/ko/admin.json`
- Modify: `apps/web/messages/en/admin.json`
- Create: `apps/web/lib/tool-deployment-ui.test.ts`

**Interfaces:**
- Consumes: Task 4 service mutations and report summaries.
- Produces: one-click personal install, device advanced selection, team impact preview/default deployment, exclusion, status guidance, team leader selector.

- [ ] **Step 1: Write failing UI source and action tests**

```ts
test("상세 화면은 개인 설치를 기본 CTA로 두고 leader에게만 팀 기본 배포를 보인다", () => {
  const page = source("app/(dashboard)/library/[slug]/page.tsx");
  assert.match(page, /ToolInstallPanel/);
  assert.match(page, /viewer\.teamRole === "leader"/);
  assert.match(page, /TeamDeploymentPanel/);
});

test("설치 panel은 모든 기기 기본값, 고급 기기 선택, 제외와 상태별 다음 행동을 제공한다", () => {
  const panel = source("app/(dashboard)/library/[slug]/tool-install-panel.tsx");
  for (const text of ["installAllDevices", "advancedDeviceSelection", "excludeTeamDefault", "settingsRequiredCommand", "nextShimRun"]) assert.match(panel, new RegExp(text));
});

test("team role 변경은 admin만 수행하고 teamless leader를 거부한다", async () => {
  assert.deepEqual(await changeTeamRole(member, { userId: "u2", teamRole: "leader" }, deps), { ok: false, reason: "forbidden" });
  assert.deepEqual(await changeTeamRole(admin, { userId: "teamless", teamRole: "leader" }, deps), { ok: false, reason: "team-required" });
});
```

- [ ] **Step 2: Run and verify RED**

Run: `pnpm --filter @toard/web test -- tool-deployment-ui.test.ts`

Expected: FAIL because panels/actions do not exist.

- [ ] **Step 3: Implement server actions with explicit authorization**

```ts
export async function installToolAction(input: InstallToolInput): Promise<ActionResult> {
  const viewer = await getSessionUser();
  if (!viewer) return { ok: false, reason: "unauthorized" };
  const version = await repository().getInstallableVersion(input.catalogItemId, input.versionId);
  if (!version) return { ok: false, reason: "unavailable" };
  const owned = await repository().ownedDeviceFingerprints(viewer.id);
  if (input.scope === "selected_devices" && input.deviceFingerprints.some((value) => !owned.includes(value))) return { ok: false, reason: "device-not-owned" };
  await repository().savePersonalPreference({ actorUserId: viewer.id, catalogItemId: input.catalogItemId, mode: "install", scope: input.scope, versionId: version.id, deviceFingerprints: input.scope === "selected_devices" ? input.deviceFingerprints : [] });
  revalidatePath(`/library/${input.slug}`);
  return { ok: true };
}
```

- [ ] **Step 4: Implement progressive-disclosure panels and status language**

Render the progressive-disclosure panel from explicit state:

```tsx
export function ToolInstallPanel({ item, devices, reports, inherited }: Props) {
  const [advanced, setAdvanced] = useState(false);
  return <section aria-labelledby="install-heading">
    <PermissionSummary source={item.sourceUrl} version={item.sourceRef} clients={item.supportedClients} env={item.requiredEnv} hosts={item.networkHosts} />
    <form action={installToolAction}>
      <input type="hidden" name="catalogItemId" value={item.id} />
      <RadioGroup name="scope" defaultValue="all_devices">
        <RadioGroupItem value="all_devices" id="all-devices" /><Label htmlFor="all-devices">{t("installAllDevices")}</Label>
        <button type="button" onClick={() => setAdvanced((value) => !value)}>{t("advancedDeviceSelection")}</button>
        {advanced && devices.map((device) => <DeviceCheckbox key={device.fingerprint} device={device} />)}
      </RadioGroup>
      <SubmitButton>{t("install")}</SubmitButton>
    </form>
    <DeviceDeploymentStatuses reports={reports} settingsCommand={`toard-shim tool configure ${item.slug}`} />
    {inherited && <form action={excludeTeamDefaultAction}><input type="hidden" name="catalogItemId" value={item.id} /><SubmitButton variant="ghost">{t("excludeTeamDefault")}</SubmitButton></form>}
  </section>;
}
```

- [ ] **Step 5: Add admin-only team leader selection and translations**

Add `team_role` to the admin member query. The selector is disabled for teamless users and calls an admin action that locks the target user, verifies `team_id IS NOT NULL` for `leader`, updates `team_role`, and appends `team_leader_changed` audit data without user secrets.

- [ ] **Step 6: Verify GREEN and commit**

Run: `pnpm --filter @toard/web test -- tool-deployment-ui.test.ts tool-library-ui.test.ts && pnpm --filter @toard/web typecheck`

Expected: UI/action tests PASS and TypeScript exits 0.

```bash
git add 'apps/web/app/(dashboard)/library/[slug]' 'apps/web/app/(dashboard)/admin' apps/web/messages apps/web/lib/tool-deployment-ui.test.ts
git commit -m "feat(library): 개인 설치와 팀 기본 배포 UI 추가"
```

### Task 8: Rollout Coordinator, Auto-Rollback, and End-to-End Verification

**Files:**
- Create: `apps/web/lib/tool-rollout-coordinator.ts`
- Create: `apps/web/lib/tool-rollout-coordinator.test.ts`
- Modify: `apps/web/instrumentation.ts`
- Create: `scripts/tool-deployment-migration.integration.test.ts`
- Modify: `package.json`
- Modify: `README.md`

**Interfaces:**
- Consumes: Task 1 `evaluateRollout()`, Task 2 reports/policies, existing single-process instrumentation scheduler pattern.
- Produces: leased rollout advancement, auto-rollback, operational docs, full migration integration test.

- [ ] **Step 1: Write failing coordinator tests**

```ts
test("coordinator는 advisory lease 보유자만 phase를 전진한다", async () => {
  const repo = fakeRolloutRepo({ lease: false });
  await runToolRolloutCoordinator(repo, now);
  assert.deepEqual(repo.updates, []);
});

test("canary 성공은 50%로, 임계 실패는 LKG rollback으로 원자 전환한다", async () => {
  const success = fakeRolloutRepo(canary({ eligible: 10, attempted: 1, failed: 0, ageMinutes: 31 }));
  await runToolRolloutCoordinator(success, now);
  assert.deepEqual(success.updates[0], { phase: "expand", percent: 50 });
  const failed = fakeRolloutRepo(canary({ eligible: 10, attempted: 2, failed: 2, ageMinutes: 5 }));
  await runToolRolloutCoordinator(failed, now);
  assert.deepEqual(failed.updates[0], { phase: "rollback", target: "last-known-good", percent: 100 });
});
```

- [ ] **Step 2: Run and verify RED**

Run: `pnpm --filter @toard/web test -- tool-rollout-coordinator.test.ts`

Expected: FAIL because coordinator does not exist.

- [ ] **Step 3: Implement lease-protected rollout decisions**

```ts
export async function runToolRolloutCoordinator(repo: ToolRolloutRepository, now: Date): Promise<void> {
  if (!(await repo.tryLease())) return;
  try {
    for (const rollout of await repo.listOpenRollouts()) {
      const decision = evaluateRollout(rollout, now);
      if (decision.action === "advance") await repo.advance(rollout.id, decision.nextPhase, decision.percent, now);
      if (decision.action === "rollback") await repo.rollbackToLastKnownGood(rollout.id, now, decision.reason);
    }
  } finally {
    await repo.releaseLease();
  }
}
```

- [ ] **Step 4: Wire scheduler and migration integration test**

Wire the coordinator in the Node runtime and extend the migration test command:

```ts
if (process.env.NEXT_RUNTIME === "nodejs" && process.env.TOARD_TOOL_ROLLOUT_COORDINATOR !== "0") {
  const timer = setInterval(() => void runToolRolloutCoordinator(createToolRolloutRepository(getPool()), new Date()), 60_000);
  timer.unref();
}
```

```json
"test:migrations": "TSX_TSCONFIG_PATH=apps/web/tsconfig.json node --import tsx --test scripts/pricing-revisions-migration.integration.test.ts scripts/pricing-auto-recovery-migration.integration.test.ts scripts/historical-pricing-migration.integration.test.ts scripts/rollup-coordinator-migration.integration.test.ts scripts/e2ee-content-migration.integration.test.ts scripts/e2ee-legacy-migration.integration.test.ts scripts/e2ee-legacy-retirement-migration.integration.test.ts scripts/tool-deployment-migration.integration.test.ts"
```

The migration integration test uses the existing isolated-PostgreSQL helper, applies all migrations, inserts one valid version/policy/preference/report chain, asserts an invalid status fails with SQLSTATE `23514`, rolls all migrations down, and asserts `to_regclass('public.tool_versions') IS NULL` plus `information_schema.columns` has no `users.team_role` row.

- [ ] **Step 5: Document operation and privacy boundaries**

Add this operational matrix to README, followed by the exact CLI command `toard-shim tool configure <slug>` and rollout thresholds from Global Constraints:

```markdown
| 보관 위치 | 저장하는 정보 | 저장하지 않는 정보 |
|---|---|---|
| Git 저장소 | Skill/MCP/Plugin 원본과 tag/commit | 사용자 비밀값 |
| toard 서버 | immutable manifest, tree digest, 개인·팀 desired state, 상태 report | 원본 파일 영구 복사, MCP 비밀값, GitHub installation token |
| 사용자 기기 | 설치 파일, managed client config, local secret, last-known-good | 다른 사용자의 정책·비밀값 |
```

- [ ] **Step 6: Run focused and full verification**

Run:

```bash
pnpm --filter @toard/core test
pnpm --filter @toard/web test
pnpm -r typecheck
pnpm test
cargo test --manifest-path shim/rust/Cargo.toml --quiet
pnpm build
git diff --check origin/main...HEAD
```

Expected: every command exits 0; migration integration includes `tool-deployment-migration.integration.test.ts`; Rust has no failing suites; Next.js production build succeeds; diff check prints nothing.

- [ ] **Step 7: Commit**

```bash
git add apps/web/lib/tool-rollout-coordinator.ts apps/web/lib/tool-rollout-coordinator.test.ts apps/web/instrumentation.ts scripts/tool-deployment-migration.integration.test.ts package.json README.md
git commit -m "feat(library): 도구 점진 배포와 자동 롤백 완성"
```

## Completion Review

- `git log --oneline origin/main..HEAD`에서 계획·도메인·저장소·API·shim·UI·rollout 커밋이 분리돼 보여야 한다.
- `git status --short`가 비어 있어야 한다.
- 최종 보고에는 실제 실행한 테스트만 적고, 서버가 보관하지 않는 값(비밀값·GitHub token·artifact)을 명시한다.
- 구현이 manifest protocol 또는 DB schema를 바꿨다면 설계 문서와 README의 필드·상태 이름이 실제 코드와 일치하는지 `rg`로 대조한다.
