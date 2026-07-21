# Tool Library Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 로그인 사용자가 공개·워크스페이스 MCP/스킬/플러그인을 탐색하고 Git 원본 기반 도구를 즉시 공유하며, 관리자가 게시 후 검증·차단할 수 있는 도구 라이브러리를 만든다.

**Architecture:** `@toard/core`가 카탈로그 타입·입력 검증·인벤토리 상태 계산을 소유하고, web repository가 Postgres의 워크스페이스 항목과 코드 내장 공개 항목을 합친다. Next.js 서버 페이지와 server action은 세션 권한을 강제하고, 브라우저는 원본 링크와 설치 안내만 제공하며 로컬 파일·비밀값·명령을 서버로 전송하거나 자동 실행하지 않는다.

**Tech Stack:** TypeScript 5.7, Next.js 15 App Router, React 19 server actions, PostgreSQL/node-pg-migrate, next-intl, Tailwind CSS, Node test runner

## Global Constraints

- 공개 도구는 읽기 전용 코드 카탈로그이고 워크스페이스 도구만 Postgres에 저장한다.
- 모든 로그인 사용자는 관리자 승인 없이 `community` 상태로 게시한다.
- 관리자는 `verified`, `deprecated`, `blocked` 상태만 관리하며 게시 승인 게이트가 아니다.
- source URL은 Git HTTPS만 받고 credential, localhost, loopback, 사설 IP를 거부한다.
- source ref는 semantic version tag 또는 40자리 commit SHA만 받으며 tag가 불변이라고 표현하지 않는다.
- 환경변수 이름만 저장하고 값·토큰·비밀번호·OAuth credential은 저장하지 않는다.
- 로컬 파일 업로드, artifact 저장, MCP 원격 실행, 자동 설치·삭제는 MVP 범위 밖이다.
- 공개 카탈로그 source URL/ref는 구현 시 공식 원본과 릴리스 페이지에서 확인한 값만 넣는다.
- 한국어와 영어 메시지 구조를 동일하게 유지하고 390px 폭에서 가로 오버플로가 없어야 한다.

---

## File Map

- `packages/core/src/tool-catalog.ts`: 도메인 타입, 입력 검증, 검색 필터, 인벤토리 설치 상태 계산.
- `packages/core/src/tool-catalog.test.ts`: 위 순수 함수의 경계값과 보안 규칙.
- `packages/core/src/index.ts`: 새 도메인 export.
- `migrations/1700000044_tool_catalog.sql`: 워크스페이스 카탈로그 테이블과 인덱스.
- `apps/web/lib/tool-catalog-public.ts`: 공식 원본을 확인한 읽기 전용 공개 항목.
- `apps/web/lib/tool-catalog.ts`: DB row mapping, 목록·상세·작성자 수정·관리자 상태 변경, 공개/DB 병합.
- `apps/web/lib/tool-catalog.test.ts`: repository SQL, 권한, 병합, migration 계약.
- `apps/web/app/(dashboard)/library/page.tsx`: 검색·범위·유형 필터와 반응형 목록.
- `apps/web/app/(dashboard)/library/[slug]/page.tsx`: 원본·권한·환경변수·host·설치 상태 상세.
- `apps/web/app/(dashboard)/library/share/actions.ts`: 로그인 사용자 게시 server action.
- `apps/web/app/(dashboard)/library/share/tool-share-form.tsx`: 입력 폼과 필드 오류.
- `apps/web/app/(dashboard)/library/share/page.tsx`: 공유 페이지 권한 경계.
- `apps/web/app/(dashboard)/library/tool-actions.ts`: 작성자 보관 action.
- `apps/web/app/(dashboard)/admin/library-actions.ts`: 관리자 검증·수명주기 action.
- `apps/web/app/(dashboard)/admin/library-panel.tsx`: 관리자 도구 표와 상태 조작.
- `apps/web/app/(dashboard)/admin/page.tsx`: `library` 관리 탭 연결.
- `apps/web/components/dashboard/sidebar-nav.tsx`: 워크스페이스 도구 라이브러리 메뉴.
- `apps/web/messages/{ko,en}/library.json`: 전체 라이브러리 UI 문구.
- `apps/web/messages/{ko,en}/{nav,admin}.json`: 메뉴·관리 탭 문구.
- `apps/web/i18n/{request,messages}.ts`: library 메시지 namespace 등록.
- `apps/web/lib/tool-library-ui.test.ts`: 라우트·권한·번역 shape·반응형 UI 계약.

---

### Task 1: Core catalog domain and validation

**Files:**
- Create: `packages/core/src/tool-catalog.ts`
- Create: `packages/core/src/tool-catalog.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces: `ToolCatalogItem`, `ToolCatalogSubmission`, `CatalogFieldErrors`, `parseToolCatalogSubmission()`, `filterToolCatalogItems()`, `resolveCatalogInstallState()`.
- Consumes: `DeviceToolInventory` from `packages/core/src/tool-metadata.ts`.

- [ ] **Step 1: Write failing validation and inventory tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  filterToolCatalogItems,
  parseToolCatalogSubmission,
  resolveCatalogInstallState,
  type ToolCatalogItem,
} from "./tool-catalog";

const valid = {
  name: "GitHub PR Review",
  slug: "github-pr-review",
  description: "Reviews pull requests",
  kind: "skill",
  sourceUrl: "https://github.com/acme/github-pr-review",
  sourceRef: "v1.2.3",
  supportedClients: ["codex"],
  requiredEnv: ["GITHUB_TOKEN"],
  networkHosts: ["api.github.com"],
  installNotes: "Follow the repository README.",
  uninstallNotes: "Remove the installed skill directory.",
  inventoryItemKey: "github-pr-review",
  inventorySourceProvider: "codex",
};

test("submission accepts a semantic tag and normalizes arrays", () => {
  const result = parseToolCatalogSubmission({ ...valid, requiredEnv: [" GITHUB_TOKEN ", "GITHUB_TOKEN"] });
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value.requiredEnv, ["GITHUB_TOKEN"]);
});

test("submission rejects credentials and private source hosts", () => {
  for (const sourceUrl of ["https://u:p@github.com/a/b", "https://localhost/a/b", "https://127.0.0.1/a/b", "http://github.com/a/b"]) {
    const result = parseToolCatalogSubmission({ ...valid, sourceUrl });
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.fieldErrors.sourceUrl);
  }
});

test("submission rejects secret values and invalid refs", () => {
  assert.equal(parseToolCatalogSubmission({ ...valid, requiredEnv: ["TOKEN=secret"] }).ok, false);
  assert.equal(parseToolCatalogSubmission({ ...valid, sourceRef: "main" }).ok, false);
  assert.equal(parseToolCatalogSubmission({ ...valid, sourceRef: "a".repeat(40) }).ok, true);
});

test("inventory match returns installed without inventing a version", () => {
  const state = resolveCatalogInstallState(
    { kind: "skill", inventoryItemKey: "github-pr-review", inventorySourceProvider: "codex", sourceRef: "v1.2.3" },
    [{ tokenId: "t", host: "mac", fingerprint: "f", observedAt: new Date(), receivedAt: new Date(), items: [{ kind: "skill", itemKey: "github-pr-review", displayName: "PR", sourceProvider: "codex", pluginKey: null, version: null, enabled: true }] }],
  );
  assert.deepEqual(state, { status: "installed", version: null, versionRelation: "unknown" });
});
```

- [ ] **Step 2: Run the core test and verify missing module failure**

Run: `pnpm --filter @toard/core exec node --import tsx --test src/tool-catalog.test.ts`

Expected: FAIL with `Cannot find module './tool-catalog'`.

- [ ] **Step 3: Implement domain types and pure helpers**

```ts
export type ToolCatalogKind = "mcp" | "skill" | "plugin";
export type ToolCatalogTrust = "community" | "verified";
export type ToolCatalogLifecycle = "published" | "deprecated" | "blocked" | "archived";
export type ToolCatalogOrigin = "public" | "workspace";
export type ToolCatalogClient = "codex" | "claude_code";

export type ToolCatalogSubmission = {
  name: string; slug: string; description: string; kind: ToolCatalogKind;
  sourceUrl: string; sourceRef: string; supportedClients: ToolCatalogClient[];
  requiredEnv: string[]; networkHosts: string[]; installNotes: string;
  uninstallNotes: string; inventoryItemKey: string; inventorySourceProvider: ToolCatalogClient;
};

export type ToolCatalogItem = ToolCatalogSubmission & {
  id: string; origin: ToolCatalogOrigin; trustStatus: ToolCatalogTrust;
  lifecycleStatus: ToolCatalogLifecycle; statusReason: string | null;
  ownerUserId: string | null; ownerName: string | null; createdAt: Date; updatedAt: Date;
};

export type CatalogFieldErrors = Partial<Record<keyof ToolCatalogSubmission, string>>;
export type CatalogParseResult = { ok: true; value: ToolCatalogSubmission } | { ok: false; fieldErrors: CatalogFieldErrors };

const TAG = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA = /^[a-f0-9]{40}$/i;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ENV = /^[A-Z_][A-Z0-9_]*$/;
const PRIVATE_V4 = /^(?:10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/;

export function parseToolCatalogSubmission(input: ToolCatalogSubmission): CatalogParseResult {
  const value = { ...input, name: input.name.trim(), slug: input.slug.trim(), description: input.description.trim(), sourceUrl: input.sourceUrl.trim(), sourceRef: input.sourceRef.trim(), requiredEnv: [...new Set(input.requiredEnv.map((x) => x.trim()).filter(Boolean))], networkHosts: [...new Set(input.networkHosts.map((x) => x.trim().toLowerCase()).filter(Boolean))], supportedClients: [...new Set(input.supportedClients)], installNotes: input.installNotes.trim(), uninstallNotes: input.uninstallNotes.trim(), inventoryItemKey: input.inventoryItemKey.trim(), inventorySourceProvider: input.inventorySourceProvider };
  const fieldErrors: CatalogFieldErrors = {};
  if (!value.name || value.name.length > 100) fieldErrors.name = "invalid";
  if (!SLUG.test(value.slug) || value.slug.length > 100) fieldErrors.slug = "invalid";
  if (!value.description || value.description.length > 500) fieldErrors.description = "invalid";
  if (!(["mcp", "skill", "plugin"] as string[]).includes(value.kind)) fieldErrors.kind = "invalid";
  try { const url = new URL(value.sourceUrl); if (url.protocol !== "https:" || url.username || url.password || url.hostname === "localhost" || PRIVATE_V4.test(url.hostname)) fieldErrors.sourceUrl = "invalid"; } catch { fieldErrors.sourceUrl = "invalid"; }
  if (!TAG.test(value.sourceRef) && !SHA.test(value.sourceRef)) fieldErrors.sourceRef = "invalid";
  if (!value.supportedClients.length || value.supportedClients.some((x) => x !== "codex" && x !== "claude_code")) fieldErrors.supportedClients = "invalid";
  if (value.requiredEnv.some((x) => !ENV.test(x))) fieldErrors.requiredEnv = "invalid";
  if (value.networkHosts.some((x) => !/^(?=.{1,253}$)(?!-)[a-z0-9.-]+(?<!-)$/.test(x) || x.includes(".."))) fieldErrors.networkHosts = "invalid";
  if (!value.inventoryItemKey || value.inventoryItemKey.length > 200) fieldErrors.inventoryItemKey = "invalid";
  return Object.keys(fieldErrors).length ? { ok: false, fieldErrors } : { ok: true, value };
}
```

Add `filterToolCatalogItems()` for `scope`, `kind`, and case-insensitive name/description search; add `resolveCatalogInstallState()` returning `not_installed | installed | unavailable` and only comparing versions when both values exist. Export the module from `packages/core/src/index.ts` with `export * from "./tool-catalog";`.

- [ ] **Step 4: Run core tests and typecheck**

Run: `pnpm --filter @toard/core test && pnpm --filter @toard/core typecheck`

Expected: all core tests PASS and TypeScript exits 0.

- [ ] **Step 5: Commit core domain**

```bash
git add packages/core/src/tool-catalog.ts packages/core/src/tool-catalog.test.ts packages/core/src/index.ts
git commit -m "feat(library): 도구 카탈로그 도메인 추가"
```

---

### Task 2: PostgreSQL migration and workspace repository

**Files:**
- Create: `migrations/1700000044_tool_catalog.sql`
- Create: `apps/web/lib/tool-catalog.ts`
- Create: `apps/web/lib/tool-catalog.test.ts`

**Interfaces:**
- Consumes: core `ToolCatalogItem`, `ToolCatalogSubmission`, `ToolCatalogLifecycle`, `ToolCatalogTrust`.
- Produces: `listToolCatalogWithDb()`, `getToolCatalogItemWithDb()`, `createToolCatalogItemWithDb()`, `archiveToolCatalogItemWithDb()`, `moderateToolCatalogItemWithDb()` and pool wrappers.

- [ ] **Step 1: Write failing migration and repository tests**

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createToolCatalogItemWithDb, moderateToolCatalogItemWithDb } from "./tool-catalog";

test("migration constrains trust and lifecycle without storing secrets", () => {
  const sql = readFileSync(new URL("../../../migrations/1700000044_tool_catalog.sql", import.meta.url), "utf8");
  assert.match(sql, /CREATE TABLE tool_catalog_items/);
  assert.match(sql, /trust_status IN \('community', 'verified'\)/);
  assert.match(sql, /lifecycle_status IN \('published', 'deprecated', 'blocked', 'archived'\)/);
  assert.match(sql, /-- Down Migration[\s\S]*DROP TABLE IF EXISTS tool_catalog_items/);
  assert.doesNotMatch(sql, /token_value|secret_value|credential_value/);
});

test("ordinary publication always writes owner and community trust", async () => {
  const db = recordingDb([{ id: "item-1" }]);
  await createToolCatalogItemWithDb(db, "user-1", submission);
  assert.match(db.calls[0]!.sql, /INSERT INTO tool_catalog_items/);
  assert.deepEqual(db.calls[0]!.params?.slice(-3), ["user-1", "community", "published"]);
});

test("moderation rejects non-admin before issuing SQL", async () => {
  const db = recordingDb([]);
  const result = await moderateToolCatalogItemWithDb(db, { id: "user-1", role: "member" }, "item-1", { trustStatus: "verified", lifecycleStatus: "published", statusReason: null });
  assert.deepEqual(result, { ok: false, reason: "forbidden" });
  assert.equal(db.calls.length, 0);
});
```

- [ ] **Step 2: Run repository test and verify failure**

Run: `pnpm --filter @toard/web exec node --import tsx --test lib/tool-catalog.test.ts`

Expected: FAIL because the migration and repository do not exist.

- [ ] **Step 3: Add migration with constrained arrays and ownership**

```sql
-- Up Migration
CREATE TABLE tool_catalog_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  description TEXT NOT NULL CHECK (char_length(description) BETWEEN 1 AND 500),
  kind TEXT NOT NULL CHECK (kind IN ('mcp', 'skill', 'plugin')),
  source_url TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  supported_clients TEXT[] NOT NULL,
  required_env TEXT[] NOT NULL DEFAULT '{}',
  network_hosts TEXT[] NOT NULL DEFAULT '{}',
  install_notes TEXT NOT NULL DEFAULT '',
  uninstall_notes TEXT NOT NULL DEFAULT '',
  inventory_item_key TEXT NOT NULL CHECK (char_length(inventory_item_key) BETWEEN 1 AND 200),
  inventory_source_provider TEXT NOT NULL CHECK (inventory_source_provider IN ('codex', 'claude_code')),
  trust_status TEXT NOT NULL DEFAULT 'community' CHECK (trust_status IN ('community', 'verified')),
  lifecycle_status TEXT NOT NULL DEFAULT 'published' CHECK (lifecycle_status IN ('published', 'deprecated', 'blocked', 'archived')),
  status_reason TEXT,
  owner_user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_tool_catalog_visible ON tool_catalog_items (lifecycle_status, kind, updated_at DESC);
CREATE INDEX idx_tool_catalog_owner ON tool_catalog_items (owner_user_id, updated_at DESC);

-- Down Migration
DROP TABLE IF EXISTS tool_catalog_items;
```

- [ ] **Step 4: Implement row mapping, visibility and permission-aware writes**

`apps/web/lib/tool-catalog.ts` must expose an injectable `ToolCatalogDb` and use parameterized SQL. Normal list queries include `lifecycle_status IN ('published','deprecated')`; direct detail queries return blocked rows so the page can show the reason; archived rows are returned only to owner/admin. `createToolCatalogItemWithDb()` hard-codes `community` and `published`. Owner update uses `WHERE id=$1 AND owner_user_id=$2`, resets `trust_status='community'`, and updates `updated_at`. `moderateToolCatalogItemWithDb()` checks `viewer.role === 'admin'` before SQL.

```ts
export type ToolCatalogDb = { query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount?: number | null }> };
export type CatalogViewer = { id: string; role: string };
export type CatalogModeration = { trustStatus: ToolCatalogTrust; lifecycleStatus: ToolCatalogLifecycle; statusReason: string | null };

export async function moderateToolCatalogItemWithDb(db: ToolCatalogDb, viewer: CatalogViewer, id: string, moderation: CatalogModeration) {
  if (viewer.role !== "admin") return { ok: false as const, reason: "forbidden" as const };
  const result = await db.query(
    `UPDATE tool_catalog_items SET trust_status=$2, lifecycle_status=$3, status_reason=$4, updated_at=now() WHERE id=$1 RETURNING id`,
    [id, moderation.trustStatus, moderation.lifecycleStatus, moderation.statusReason],
  );
  return result.rows[0] ? { ok: true as const } : { ok: false as const, reason: "not-found" as const };
}
```

- [ ] **Step 5: Run repository tests and web typecheck**

Run: `pnpm --filter @toard/web test && pnpm --filter @toard/web typecheck`

Expected: all web tests PASS and TypeScript exits 0.

- [ ] **Step 6: Commit persistence layer**

```bash
git add migrations/1700000044_tool_catalog.sql apps/web/lib/tool-catalog.ts apps/web/lib/tool-catalog.test.ts
git commit -m "feat(library): 워크스페이스 도구 저장소 추가"
```

---

### Task 3: Verified public catalog and catalog composition

**Files:**
- Create: `apps/web/lib/tool-catalog-public.ts`
- Modify: `apps/web/lib/tool-catalog.ts`
- Modify: `apps/web/lib/tool-catalog.test.ts`

**Interfaces:**
- Produces: `PUBLIC_TOOL_CATALOG`, `listToolCatalog()`, `getToolCatalogItem()`.
- Consumes: official release URLs verified on 2026-07-13 and repository functions from Task 2.

- [ ] **Step 1: Add failing public merge and collision tests**

```ts
test("public catalog is read-only verified metadata with unique slugs", () => {
  assert.ok(PUBLIC_TOOL_CATALOG.length >= 3);
  assert.equal(new Set(PUBLIC_TOOL_CATALOG.map((item) => item.slug)).size, PUBLIC_TOOL_CATALOG.length);
  assert.ok(PUBLIC_TOOL_CATALOG.every((item) => item.origin === "public" && item.ownerUserId === null));
});

test("workspace publication rejects a public slug", async () => {
  const db = recordingDb([]);
  const result = await createToolCatalogItemWithDb(db, "user-1", { ...submission, slug: "github-mcp-server" });
  assert.deepEqual(result, { ok: false, reason: "slug-conflict" });
  assert.equal(db.calls.length, 0);
});
```

- [ ] **Step 2: Run test and verify public module failure**

Run: `pnpm --filter @toard/web exec node --import tsx --test lib/tool-catalog.test.ts`

Expected: FAIL with missing `tool-catalog-public` module.

- [ ] **Step 3: Add three official public entries**

Use these source facts checked from official GitHub repositories on 2026-07-13:

```ts
export const PUBLIC_TOOL_CATALOG: readonly ToolCatalogItem[] = [
  publicItem({ slug: "github-mcp-server", name: "GitHub MCP Server", kind: "mcp", description: "GitHub 저장소, 이슈와 pull request를 다루는 공식 MCP 서버", sourceUrl: "https://github.com/github/github-mcp-server", sourceRef: "v0.31.0", supportedClients: ["codex", "claude_code"], requiredEnv: ["GITHUB_PERSONAL_ACCESS_TOKEN"], networkHosts: ["api.github.com", "github.com"], inventoryItemKey: "github", inventorySourceProvider: "codex" }),
  publicItem({ slug: "context7", name: "Context7", kind: "mcp", description: "라이브러리의 최신 문서를 조회하는 MCP 서버", sourceUrl: "https://github.com/upstash/context7", sourceRef: "@upstash/context7-mcp@3.2.0", supportedClients: ["codex", "claude_code"], requiredEnv: ["CONTEXT7_API_KEY"], networkHosts: ["mcp.context7.com", "context7.com"], inventoryItemKey: "context7", inventorySourceProvider: "codex" }),
  publicItem({ slug: "superpowers", name: "Superpowers", kind: "plugin", description: "에이전트 개발 워크플로와 재사용 스킬 모음", sourceUrl: "https://github.com/obra/superpowers", sourceRef: "v5.0.7", supportedClients: ["codex", "claude_code"], requiredEnv: [], networkHosts: ["github.com"], inventoryItemKey: "superpowers", inventorySourceProvider: "codex" }),
];
```

Public entries use stable deterministic IDs (`public:<slug>`), `trustStatus: "verified"`, `lifecycleStatus: "published"`, empty notes where the official README must be consulted, and fixed catalog timestamps declared in the module.

- [ ] **Step 4: Compose public and workspace results with inventory states**

`listToolCatalog()` concurrently loads visible workspace rows and `getMyDeviceInventories(viewer.id).catch(() => null)`, merges public first, applies the pure filter helper, then attaches `resolveCatalogInstallState()`. A failed inventory read produces `{ status: "unavailable" }` but does not reject catalog browsing.

- [ ] **Step 5: Run web tests and typecheck**

Run: `pnpm --filter @toard/web test && pnpm --filter @toard/web typecheck`

Expected: PASS.

- [ ] **Step 6: Commit public catalog**

```bash
git add apps/web/lib/tool-catalog-public.ts apps/web/lib/tool-catalog.ts apps/web/lib/tool-catalog.test.ts
git commit -m "feat(library): 공개 도구 카탈로그 구성"
```

---

### Task 4: Library navigation, translations, list and detail pages

**Files:**
- Create: `apps/web/messages/ko/library.json`
- Create: `apps/web/messages/en/library.json`
- Create: `apps/web/app/(dashboard)/library/page.tsx`
- Create: `apps/web/app/(dashboard)/library/[slug]/page.tsx`
- Modify: `apps/web/components/dashboard/sidebar-nav.tsx`
- Modify: `apps/web/messages/ko/nav.json`
- Modify: `apps/web/messages/en/nav.json`
- Modify: `apps/web/i18n/request.ts`
- Modify: `apps/web/i18n/messages.ts`
- Create: `apps/web/lib/tool-library-ui.test.ts`

**Interfaces:**
- Consumes: `listToolCatalog()`, `getToolCatalogItem()`, `getDashboardViewer()`.
- Produces: `/library` and `/library/[slug]` authenticated server pages.

- [ ] **Step 1: Write failing source and translation-shape tests**

```ts
test("library has authenticated list and detail routes", () => {
  const list = source("app/(dashboard)/library/page.tsx");
  const detail = source("app/(dashboard)/library/[slug]/page.tsx");
  assert.match(list, /getDashboardViewer/);
  assert.match(list, /listToolCatalog/);
  assert.match(list, /grid-cols-\[minmax\(0,1fr\)_auto\]/);
  assert.match(detail, /getToolCatalogItem/);
  assert.match(detail, /requiredEnv/);
  assert.doesNotMatch(detail, /type="password"|name="token"/);
});

test("Korean and English library messages have equal shape", () => {
  const ko = JSON.parse(source("messages/ko/library.json"));
  const en = JSON.parse(source("messages/en/library.json"));
  assert.deepEqual(messageShape(ko), messageShape(en));
});
```

- [ ] **Step 2: Run UI contract test and verify missing files**

Run: `pnpm --filter @toard/web exec node --import tsx --test lib/tool-library-ui.test.ts`

Expected: FAIL with missing library route/message files.

- [ ] **Step 3: Register translations and navigation**

Add `library` to both i18n loaders/types, add `"library": "도구 라이브러리"` / `"library": "Tool library"` to nav, add `LibraryBig` and `{ href: "/library", key: "library", icon: LibraryBig, badge: "beta" }` to `workspaceItems`, and extend `NavKey` with `library`.

The new `library.json` files define equal keys for `title`, `description`, `share`, `scope.*`, `kind.*`, `trust.*`, `lifecycle.*`, `state.*`, `table.*`, `detail.*`, `form.*`, `errors.*`, and `admin.*`.

- [ ] **Step 4: Implement the server-rendered responsive list**

Parse only `scope=all|public|workspace|mine`, `kind=all|mcp|skill|plugin`, and trimmed `q`. Render a compact header, link tabs, GET search/filter form, and rows with this layout:

```tsx
<div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 md:grid-cols-[minmax(0,2fr)_7rem_10rem_9rem_auto]">
  <div className="min-w-0"><Link className="font-medium" href={`/library/${item.slug}`}>{item.name}</Link><p className="text-muted-foreground truncate text-sm">{item.description}</p></div>
  <Badge className="hidden md:inline-flex">{t(`kind.${item.kind}`)}</Badge>
  <span className="hidden text-sm md:block">{originLabel}</span>
  <span className="hidden text-sm md:block">{stateLabel}</span>
  <Button asChild size="sm" variant="outline"><Link href={`/library/${item.slug}`}>{t("table.detail")}</Link></Button>
</div>
```

Empty results render the shared `Empty` components. Search and filters remain in the URL.

- [ ] **Step 5: Implement detail with trust boundary and copyable instructions**

The page redirects unauthenticated viewers, calls `notFound()` for missing/hidden archived items, shows blocked reason instead of install notes, displays source URL/ref, tag mutability notice, clients, environment variable names, network hosts, owner/timestamps and inventory state. External source links use `target="_blank" rel="noreferrer"`. Installation notes are plain `<pre>` text and a `CopyButton`; no command executes.

- [ ] **Step 6: Run UI tests and typecheck**

Run: `pnpm --filter @toard/web test && pnpm --filter @toard/web typecheck`

Expected: PASS.

- [ ] **Step 7: Commit discovery UI**

```bash
git add apps/web/app/'(dashboard)'/library apps/web/components/dashboard/sidebar-nav.tsx apps/web/messages apps/web/i18n apps/web/lib/tool-library-ui.test.ts
git commit -m "feat(library): 도구 탐색 화면 추가"
```

---

### Task 5: Immediate community publication, owner edit and archive

**Files:**
- Create: `apps/web/app/(dashboard)/library/share/actions.ts`
- Create: `apps/web/app/(dashboard)/library/share/tool-share-form.tsx`
- Create: `apps/web/app/(dashboard)/library/share/page.tsx`
- Create: `apps/web/app/(dashboard)/library/[slug]/edit/page.tsx`
- Create: `apps/web/app/(dashboard)/library/tool-actions.ts`
- Modify: `apps/web/app/(dashboard)/library/[slug]/page.tsx`
- Modify: `apps/web/lib/tool-library-ui.test.ts`

**Interfaces:**
- Consumes: `parseToolCatalogSubmission()`, `createToolCatalogItem()`, `updateToolCatalogItem()`, `archiveToolCatalogItem()`, `getDashboardViewer()`.
- Produces: `createToolCatalogAction(previous, formData)`, `updateToolCatalogAction(id, previous, formData)`, and `archiveToolCatalogAction(id)`.

- [ ] **Step 1: Add failing publication action contract tests**

```ts
test("share action authenticates, parses arrays and never accepts trust from the form", () => {
  const action = source("app/(dashboard)/library/share/actions.ts");
  assert.match(action, /getDashboardViewer/);
  assert.match(action, /parseToolCatalogSubmission/);
  assert.match(action, /formData\.getAll\("supportedClients"\)/);
  assert.doesNotMatch(action, /formData\.get\("trustStatus"\)/);
});

test("share form sends environment names and hosts, not secret values", () => {
  const form = source("app/(dashboard)/library/share/tool-share-form.tsx");
  assert.match(form, /name="requiredEnv"/);
  assert.match(form, /name="networkHosts"/);
  assert.doesNotMatch(form, /type="password"|secretValue|tokenValue/);
});

test("only the owner edit page can send mutable metadata", () => {
  const edit = source("app/(dashboard)/library/[slug]/edit/page.tsx");
  const actions = source("app/(dashboard)/library/share/actions.ts");
  assert.match(edit, /item\.ownerUserId !== viewer\.id/);
  assert.match(actions, /updateToolCatalogItem/);
  assert.doesNotMatch(actions, /formData\.get\("ownerUserId"\)/);
});
```

- [ ] **Step 2: Run contract test and verify missing action/form**

Run: `pnpm --filter @toard/web exec node --import tsx --test lib/tool-library-ui.test.ts`

Expected: FAIL with missing share files.

- [ ] **Step 3: Implement publication server action**

```ts
export type ShareToolState = { fieldErrors?: Record<string, string>; formError?: string };

export async function createToolCatalogAction(_previous: ShareToolState, formData: FormData): Promise<ShareToolState> {
  const viewer = await getDashboardViewer();
  if (!viewer) return { formError: "unauthorized" };
  const input = submissionFromFormData(formData);
  const parsed = parseToolCatalogSubmission(input);
  if (!parsed.ok) return { fieldErrors: parsed.fieldErrors };
  const created = await createToolCatalogItem(viewer.id, parsed.value);
  if (!created.ok) return { fieldErrors: created.reason === "slug-conflict" ? { slug: "duplicate" } : undefined, formError: created.reason === "slug-conflict" ? undefined : "save-failed" };
  redirect(`/library/${created.slug}`);
}
```

`submissionFromFormData()` splits newline values for `requiredEnv` and `networkHosts`, reads checked clients with `getAll`, and never reads trust/lifecycle/owner fields. `updateToolCatalogAction()` reuses the parser, binds the item ID on the server, calls `updateToolCatalogItem(viewer.id, id, parsed.value)`, and redirects to the updated slug. Repository SQL includes `WHERE id=$1 AND owner_user_id=$2` and sets `trust_status='community'`.

- [ ] **Step 4: Implement accessible share/edit form and owner archive**

The client form uses `useActionState`, `Label`, `Input`, native `<textarea>` and checkboxes and accepts optional initial values for edit mode. Every server field error renders next to its field. The share page explains immediate community publication and that verification is a later admin signal. The edit page loads the viewer and item, redirects non-owners, and explains that saving resets verification. Detail shows edit/archive controls only for the owner. The archive action reloads the current viewer server-side and repository SQL limits the update to the owner; after success it revalidates `/library` and `/library/[slug]`.

- [ ] **Step 5: Run tests and typecheck**

Run: `pnpm --filter @toard/web test && pnpm --filter @toard/web typecheck`

Expected: PASS.

- [ ] **Step 6: Commit publication flow**

```bash
git add apps/web/app/'(dashboard)'/library apps/web/lib/tool-library-ui.test.ts
git commit -m "feat(library): 커뮤니티 도구 공유 흐름 추가"
```

---

### Task 6: Post-publication administration

**Files:**
- Create: `apps/web/app/(dashboard)/admin/library-actions.ts`
- Create: `apps/web/app/(dashboard)/admin/library-panel.tsx`
- Modify: `apps/web/app/(dashboard)/admin/page.tsx`
- Modify: `apps/web/messages/ko/admin.json`
- Modify: `apps/web/messages/en/admin.json`
- Modify: `apps/web/lib/tool-library-ui.test.ts`

**Interfaces:**
- Consumes: `listAdminToolCatalog()`, `moderateToolCatalogItem()`, `getSessionUser()`.
- Produces: `moderateToolCatalogAction(previous, formData)` and `/admin?tab=library`.

- [ ] **Step 1: Add failing admin contract tests**

```ts
test("admin has a library tab and moderation remains post-publication", () => {
  const page = source("app/(dashboard)/admin/page.tsx");
  const action = source("app/(dashboard)/admin/library-actions.ts");
  assert.match(page, /raw === "library"/);
  assert.match(page, /<LibraryPanel/);
  assert.match(action, /user\.role !== "admin"/);
  assert.match(action, /moderateToolCatalogItem/);
  assert.doesNotMatch(action, /approvePublication|rejectPublication/);
});
```

- [ ] **Step 2: Run UI contract test and verify missing admin files**

Run: `pnpm --filter @toard/web exec node --import tsx --test lib/tool-library-ui.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement admin moderation action**

The action accepts only `id`, `trustStatus`, `lifecycleStatus`, and a trimmed `statusReason`. It checks the live session role, validates enum values, requires a reason for `blocked` and `deprecated`, calls the repository, revalidates `/admin` and `/library`, and returns a localized generic error without exposing SQL details.

- [ ] **Step 4: Add admin panel and tab**

Extend `Tab` with `library`, add the link tab, load DB workspace items including archived/blocked, and render public entries in a separate read-only section. Each workspace row shows name, kind, owner, trust, lifecycle, updated time, a state select, verified checkbox, reason input, and save button. The panel copy states that ordinary posts are already visible and moderation is not approval.

- [ ] **Step 5: Keep admin message catalogs shape-compatible**

Add matching `tabs.library` and `library.*` keys to Korean and English admin messages. Reuse existing admin error patterns for unauthorized and save failures.

- [ ] **Step 6: Run tests and typecheck**

Run: `pnpm --filter @toard/web test && pnpm --filter @toard/web typecheck`

Expected: PASS.

- [ ] **Step 7: Commit moderation UI**

```bash
git add apps/web/app/'(dashboard)'/admin apps/web/messages/ko/admin.json apps/web/messages/en/admin.json apps/web/lib/tool-library-ui.test.ts
git commit -m "feat(library): 게시 후 도구 관리 기능 추가"
```

---

### Task 7: Migration, regression and browser verification

**Files:**
- Modify only files required by failures found in Tasks 1-6.

**Interfaces:**
- Consumes: the complete library feature.
- Produces: evidence that schema, tests, typecheck and desktop/mobile browser flows work.

- [ ] **Step 1: Run focused package tests**

Run: `pnpm --filter @toard/core test && pnpm --filter @toard/web test`

Expected: all tests PASS.

- [ ] **Step 2: Run repository-wide static verification**

Run: `pnpm typecheck && git diff --check`

Expected: both commands exit 0.

- [ ] **Step 3: Apply migration to the local development database**

Run: `pnpm migrate`

Expected: node-pg-migrate reports `1700000044_tool_catalog` applied. Never run this against production.

- [ ] **Step 4: Start or reuse the local web server and verify health**

Run: `pnpm --filter @toard/web dev`

Expected: Next.js reports a local URL; `curl -fsS <local-url>/api/health` returns HTTP 200.

- [ ] **Step 5: Verify the authenticated browser flow**

In the in-app browser verify:

1. `/library` displays public rows, scope tabs, search and kind filters.
2. `/library/github-mcp-server` displays official source URL/ref, environment variable names, network hosts and install state.
3. `/library/share` publishes a valid test item immediately as community and redirects to detail.
4. `/admin?tab=library` verifies the test item, and `/library` reflects the verified badge.
5. Blocking it with a reason removes it from the default list and direct detail shows the reason.

- [ ] **Step 6: Verify the narrow layout**

Resize to 390px width and confirm the library rows show name, origin/status summary and detail action without horizontal page overflow; capture a screenshot for handoff evidence.

- [ ] **Step 7: Run final diff and status audit**

Run: `git status --short && git diff --stat HEAD~6..HEAD && git diff --check`

Expected: only planned feature files are present and diff check exits 0.
