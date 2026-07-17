# Production Readiness Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 관리형 KMS 본문 암호화 변경이 Next.js production build와 Docker 이미지에서 실제로 빌드되고, 관리형 본문 활성화 시 앱 DB 연결이 RLS를 우회하지 않도록 fail-closed하여 production 배포 전 검증 게이트를 완성한다.

**Architecture:** Next.js `route.ts`는 허용된 HTTP method/config만 export하고 테스트 dependency injection은 기존 `HTTP_METHOD.withDependencies()` 패턴으로 이동한다. Compose는 migration owner URL과 app/content-admin URL을 분리하며, `/api/ready`는 관리형 본문 활성화 시 현재 PostgreSQL role이 `NOSUPERUSER NOBYPASSRLS`인지 확인한다. PR CI가 실제 production build를 실행하여 unit/typecheck만으로 놓친 Route Module 계약을 차단한다.

**Tech Stack:** Next.js 15.5, TypeScript, Node test runner, PostgreSQL 16, Docker Compose, Docker multi-stage build, GitHub Actions, Helm 3.

## Global Constraints

- `route.ts`의 runtime value export는 `GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS`와 Next.js가 허용하는 route config만 가능하다.
- recovery와 managed migration의 capability-first, no-store, bounded-body, error-redaction 동작을 변경하지 않는다.
- 관리형 본문을 활성화한 앱과 content-admin은 PostgreSQL `NOSUPERUSER NOBYPASSRLS` role을 사용해야 한다.
- migrate와 seed는 migration owner DB URL을 사용하고 KMS 환경변수·secret mount를 받지 않는다.
- app과 content-admin은 같은 app DB URL과 KMS profile을 사용한다.
- 기존 Compose 설치는 관리형 본문을 사용하지 않을 때 기존 DB URL 기본값으로 계속 기동할 수 있다.
- secret, credential, KEK, UCK, DEK, DB password를 테스트 출력·로그·문서 예시에 실제 값으로 기록하지 않는다.
- production 완료 판정에는 `pnpm test`, `pnpm typecheck`, Next production build, Docker 4 target build, Compose/Helm 검증, Rust test, 실제 PG security integration이 모두 필요하다.

---

### Task 1: Next Route Module export 경계와 production build 게이트

**Files:**
- Create: `apps/web/lib/route-module-export-contract.test.ts`
- Modify: `apps/web/app/api/content/recovery/complete/route.ts`
- Modify: `apps/web/app/api/content/recovery/wrapper/route.ts`
- Modify: `apps/web/app/api/content/managed-migration/commit/route.ts`
- Modify: `apps/web/app/api/content/managed-migration/state/route.ts`
- Modify: `apps/web/app/api/content/managed-migration/status/route.ts`
- Modify: `apps/web/app/api/content/managed-migration/page/route.ts`
- Modify: `apps/web/lib/content-api-security.test.ts`
- Modify: `apps/web/app/api/content/managed-migration/routes.test.ts`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: `GET.withDependencies(overrides)` or `POST.withDependencies(overrides)` for route tests.
- Preserves: public HTTP `GET`/`POST` signatures and response contracts.

- [ ] **Step 1: Write the failing Route Module export contract test**

Use the TypeScript compiler API to walk every `apps/web/app/**/route.ts`, ignore type-only exports, and assert that every runtime export is in this exact allowlist:

```ts
const ALLOWED = new Set([
  "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS",
  "dynamic", "dynamicParams", "revalidate", "fetchCache", "runtime",
  "preferredRegion", "maxDuration", "config", "generateStaticParams",
]);
```

The failure must list all eight current invalid helpers, not stop at the first one.

- [ ] **Step 2: Run the contract test and production build to verify RED**

Run:

```bash
pnpm --filter @toard/web exec node --import tsx --test lib/route-module-export-contract.test.ts
pnpm --config.verify-deps-before-run=false --filter @toard/web build
```

Expected: the contract test reports eight invalid helper exports across six route files, and Next build rejects `postManagedMigrationCommit`.

- [ ] **Step 3: Convert each route to the established dependency-injected HTTP export pattern**

Use this shape without exporting helper names:

```ts
function createPost(overrides: Partial<Dependencies> = {}) {
  const dependencies = { ...defaults, ...overrides };
  return async function POST(request: Request): Promise<Response> {
    // existing handler body, unchanged
  };
}

export const POST = Object.assign(createPost(), { withDependencies: createPost });
```

For GET routes use `createGet` and `GET`. Preserve the exact capability checks, status codes, `Cache-Control: no-store`, error codes, body bounds, and downstream-call ordering.

- [ ] **Step 4: Update route tests to inject through the HTTP method property**

Replace direct imports such as `postManagedMigrationCommit` with:

```ts
import { POST } from "./commit/route";
const handler = POST.withDependencies({ ...dependencies });
const response = await handler(request);
```

Security tests must still prove disabled capability returns before body parsing and before any downstream recovery/migration service call.

- [ ] **Step 5: Add production build to PR/main CI**

After typecheck and before/after tests, add an explicit command:

```yaml
- run: pnpm build
```

Do not rely on the main-only Docker publish workflow as the first build gate.

- [ ] **Step 6: Verify GREEN**

Run:

```bash
pnpm --filter @toard/web exec node --import tsx --test lib/route-module-export-contract.test.ts lib/content-api-security.test.ts app/api/content/managed-migration/routes.test.ts
pnpm --config.verify-deps-before-run=false --filter @toard/web build
pnpm --config.verify-deps-before-run=false typecheck
```

Expected: all focused tests and Next build pass; route contract reports zero invalid exports.

- [ ] **Step 7: Commit**

```bash
git add apps/web .github/workflows/ci.yml
git commit -m "fix(web): production route export 계약 복구"
```

---

### Task 2: Compose app DB role 분리와 managed-content RLS readiness

**Files:**
- Create: `apps/web/lib/content-database-role-readiness.ts`
- Create: `apps/web/lib/content-database-role-readiness.test.ts`
- Modify: `apps/web/app/api/ready/route.ts`
- Modify: `apps/web/app/api/ready/route.test.ts`
- Modify: `docker-compose.yml`
- Modify: `scripts/compose-encryption-config.test.ts`
- Modify: `docs/DEPLOY.md`
- Modify: `docs/content-encryption-runbook.md`
- Modify: `docs/examples/content-encryption.env.example`

**Interfaces:**
- Produces: `assertManagedContentDatabaseRoleReady(db, env): Promise<void>`.
- Consumes: `managedContentConfigured(env)` and a DB connection exposing `query`.
- Compose variables: `APP_DATABASE_URL` for app/content-admin, `MIGRATION_DATABASE_URL` for migrate/seed.

- [ ] **Step 1: Write failing unit and Compose contract tests**

Unit cases:

```ts
await assert.rejects(
  () => assertManagedContentDatabaseRoleReady(superuserDb, managedEnv),
  /MANAGED_CONTENT_DATABASE_ROLE_UNSAFE/,
);
await assert.rejects(
  () => assertManagedContentDatabaseRoleReady(bypassRlsDb, managedEnv),
  /MANAGED_CONTENT_DATABASE_ROLE_UNSAFE/,
);
await assert.doesNotReject(
  () => assertManagedContentDatabaseRoleReady(appRoleDb, managedEnv),
);
```

Also prove disabled managed content does not query role metadata, missing/multiple/malformed role rows fail closed when enabled, and error responses do not expose role names or DB details.

Compose cases must assert:

```ts
app.environment.DATABASE_URL === APP_DATABASE_URL
contentAdmin.environment.DATABASE_URL === APP_DATABASE_URL
migrate.environment.DATABASE_URL === MIGRATION_DATABASE_URL
seed.environment.DATABASE_URL === MIGRATION_DATABASE_URL
```

and retain KMS env/mount isolation.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
pnpm --filter @toard/web exec node --import tsx --test lib/content-database-role-readiness.test.ts app/api/ready/route.test.ts
node --import tsx --test scripts/compose-encryption-config.test.ts
```

Expected: missing readiness module and unsplit Compose URLs fail.

- [ ] **Step 3: Implement fail-closed role readiness**

When `managedContentConfigured(env)` is false, return without a query. When true, query current session identity only:

```sql
SELECT rolname, rolsuper, rolbypassrls
FROM pg_roles
WHERE rolname = current_user
```

Require exactly one plain row with `rolsuper=false` and `rolbypassrls=false`; otherwise throw only `MANAGED_CONTENT_DATABASE_ROLE_UNSAFE`. Do not return the role name in readiness JSON or logs.

- [ ] **Step 4: Wire readiness before provider health and traffic acceptance**

Add the dependency to `apps/web/app/api/ready/route.ts` after the DB ping and deployment marker checks but before returning 200. A failure must use the existing generic `{status:"not-ready"}` 503 response.

- [ ] **Step 5: Split Compose database URL anchors**

Use owner and app anchors:

```yaml
x-migration-db-url: &migration-db-url
  DATABASE_URL: ${MIGRATION_DATABASE_URL:-postgres://...}
x-app-db-url: &app-db-url
  DATABASE_URL: ${APP_DATABASE_URL:-postgres://...}
```

Apply `migration-db-url` only to migrate/seed and `app-db-url` only to app/content-admin. Do not inject KMS env or mounts into migrate/seed.

- [ ] **Step 6: Document a secure Compose bootstrap sequence**

Document: start postgres+migrate with owner URL, run `scripts/bootstrap-app-role.sql` using the owner connection without printing the password, set `APP_DATABASE_URL` to `toard_app`, keep `MIGRATION_DATABASE_URL` as owner, then start/restart app. State that managed content readiness remains 503 if app uses superuser/BYPASSRLS.

- [ ] **Step 7: Verify GREEN including actual PostgreSQL roles**

Run the unit/Compose tests plus `scripts/bootstrap-app-role.integration.test.ts`. The PG integration must demonstrate the app role passes readiness while owner and BYPASSRLS roles fail.

- [ ] **Step 8: Commit**

```bash
git add apps/web docker-compose.yml scripts/compose-encryption-config.test.ts docs
git commit -m "fix(security): managed content DB role을 fail-closed"
```

---

### Task 3: Production artifact and deployment completion gate

**Files:**
- Modify only if a verification failure identifies a concrete defect.

**Interfaces:**
- Consumes the complete branch at HEAD.
- Produces fresh evidence for production readiness.

- [ ] **Step 1: Run all code gates**

```bash
pnpm --config.verify-deps-before-run=false test
pnpm --config.verify-deps-before-run=false typecheck
pnpm --config.verify-deps-before-run=false build
```

Expected: zero failures. `pnpm lint` remains unavailable only if no workspace package defines a lint script; report this as tooling absence, not a pass.

- [ ] **Step 2: Build all production Docker targets**

```bash
docker build --target runner -t toard:verify .
docker build --target migrator -t toard-migrate:verify .
docker build --target updater -t toard-updater:verify .
docker build --target content-admin -t toard-content-admin:verify .
```

Inspect each image config and run non-secret, non-destructive smoke commands where applicable. `content-admin` must remain non-root and one-shot.

- [ ] **Step 3: Verify Compose and Helm deployment boundaries**

```bash
AUTH_SECRET=dummy APP_DATABASE_URL=postgres://toard_app:dummy@postgres:5432/toard \
MIGRATION_DATABASE_URL=postgres://owner:dummy@postgres:5432/toard \
docker compose --profile '*' config
pnpm validate:helm-encryption -- --set secrets.authSecret=dummy
```

Confirm app/content-admin versus migrate/seed DB and KMS identity separation, release schema version 39, deterministic release completion, and no secret material in ConfigMap/image layers.

- [ ] **Step 4: Run Rust and actual PostgreSQL security gates**

```bash
docker run --rm -v "$PWD:/work" -w /work/shim/rust rust:1.88 cargo test
pnpm test:migrations
pnpm test:content-security
```

Expected: zero failures; the release benchmark-only Rust test may remain explicitly ignored.

- [ ] **Step 5: Run final diff and independent review**

```bash
git diff --check 30a907660e38e4649d82cd3f1a709d34f7aa4e70..HEAD
git status --short --branch
```

Dispatch an independent reviewer over the production-hardening diff, resolve every Critical/Important finding, and repeat review until Clean.

- [ ] **Step 6: Record operational residuals without weakening completion**

External AWS/GCP/Azure/Vault/OpenBao credentials are deployment-specific and are not fabricated. Require each deployment to observe the real admin health wrap/unwrap canary before enabling content collection. Production readiness may be declared only after the repository gates are green and this deployment-specific activation step is explicitly documented.

