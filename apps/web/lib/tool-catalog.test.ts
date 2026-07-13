import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { ToolCatalogSubmission } from "@toard/core";
import {
  archiveToolCatalogItemWithDb,
  composeToolCatalogItems,
  createToolCatalogItemWithDb,
  getWorkspaceToolCatalogItemWithDb,
  listWorkspaceToolCatalogWithDb,
  moderateToolCatalogItemWithDb,
  updateToolCatalogItemWithDb,
  type ToolCatalogDb,
} from "./tool-catalog";
import { PUBLIC_TOOL_CATALOG } from "./tool-catalog-public";
import { submissionFromFormData } from "./tool-catalog-form";

type Call = { sql: string; params?: unknown[] };
type Response = { rows: Record<string, unknown>[]; rowCount?: number };

class RecordingDb implements ToolCatalogDb {
  readonly calls: Call[] = [];
  constructor(private readonly responses: Response[]) {}

  async query<T extends Record<string, unknown>>(sql: string, params?: unknown[]) {
    this.calls.push({ sql, params });
    const response = this.responses.shift() ?? { rows: [], rowCount: 0 };
    return response as { rows: T[]; rowCount?: number };
  }
}

const submission: ToolCatalogSubmission = {
  name: "GitHub PR Review",
  slug: "github-pr-review",
  description: "Reviews pull requests with the workspace policy.",
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

const row = {
  id: "item-1",
  slug: submission.slug,
  name: submission.name,
  description: submission.description,
  kind: submission.kind,
  source_url: submission.sourceUrl,
  source_ref: submission.sourceRef,
  supported_clients: submission.supportedClients,
  required_env: submission.requiredEnv,
  network_hosts: submission.networkHosts,
  install_notes: submission.installNotes,
  uninstall_notes: submission.uninstallNotes,
  inventory_item_key: submission.inventoryItemKey,
  inventory_source_provider: submission.inventorySourceProvider,
  trust_status: "community",
  lifecycle_status: "published",
  status_reason: null,
  owner_user_id: "user-1",
  owner_name: "owner@example.com",
  created_at: new Date("2026-07-13T00:00:00Z"),
  updated_at: new Date("2026-07-13T00:00:00Z"),
};

test("migration은 카탈로그 상태를 제한하고 down migration을 제공한다", () => {
  const sql = readFileSync(new URL("../../../migrations/1700000025_tool_catalog.sql", import.meta.url), "utf8");

  assert.match(sql, /CREATE TABLE tool_catalog_items/);
  assert.match(sql, /trust_status IN \('community', 'verified'\)/);
  assert.match(sql, /lifecycle_status IN \('published', 'deprecated', 'blocked', 'archived'\)/);
  assert.match(sql, /owner_user_id UUID NOT NULL REFERENCES users\(id\)/);
  assert.match(sql, /-- Down Migration[\s\S]*DROP TABLE IF EXISTS tool_catalog_items/);
  assert.doesNotMatch(sql, /token_value|secret_value|credential_value/);
});

test("일반 목록은 게시·사용 중단 항목만 조회하고 row를 domain으로 변환한다", async () => {
  const db = new RecordingDb([{ rows: [row], rowCount: 1 }]);

  const result = await listWorkspaceToolCatalogWithDb(db, { id: "user-1", role: "member" });

  assert.equal(result.length, 1);
  assert.deepEqual(result[0], {
    ...submission,
    id: "item-1",
    origin: "workspace",
    trustStatus: "community",
    lifecycleStatus: "published",
    statusReason: null,
    ownerUserId: "user-1",
    ownerName: "owner@example.com",
    createdAt: new Date("2026-07-13T00:00:00Z"),
    updatedAt: new Date("2026-07-13T00:00:00Z"),
  });
  assert.match(db.calls[0]!.sql, /lifecycle_status IN \('published', 'deprecated'\)/);
  assert.match(db.calls[0]!.sql, /LEFT JOIN users/);
});

test("직접 상세는 blocked를 반환하지만 archived는 작성자와 관리자에게만 반환한다", async () => {
  const blocked = new RecordingDb([{ rows: [{ ...row, lifecycle_status: "blocked", status_reason: "unsafe" }] }]);
  const archivedForOther = new RecordingDb([{ rows: [{ ...row, lifecycle_status: "archived" }] }]);
  const archivedForOwner = new RecordingDb([{ rows: [{ ...row, lifecycle_status: "archived" }] }]);

  const blockedResult = await getWorkspaceToolCatalogItemWithDb(blocked, { id: "user-2", role: "member" }, submission.slug);
  const hiddenResult = await getWorkspaceToolCatalogItemWithDb(archivedForOther, { id: "user-2", role: "member" }, submission.slug);
  const ownerResult = await getWorkspaceToolCatalogItemWithDb(archivedForOwner, { id: "user-1", role: "member" }, submission.slug);

  assert.equal(blockedResult?.lifecycleStatus, "blocked");
  assert.equal(blockedResult?.statusReason, "unsafe");
  assert.equal(hiddenResult, null);
  assert.equal(ownerResult?.lifecycleStatus, "archived");
});

test("일반 사용자의 게시 상태는 SQL에서 community와 published로 고정된다", async () => {
  const db = new RecordingDb([{ rows: [{ id: "item-1", slug: submission.slug }], rowCount: 1 }]);

  const result = await createToolCatalogItemWithDb(db, "user-1", submission);

  assert.deepEqual(result, { ok: true, id: "item-1", slug: submission.slug });
  assert.match(db.calls[0]!.sql, /'community', 'published'/);
  assert.doesNotMatch(db.calls[0]!.sql, /\$\d+::.*trust|approved/i);
  assert.equal(db.calls[0]!.params?.at(-1), "user-1");
});

test("작성자 수정은 소유권을 SQL에서 제한하고 검증 상태를 community로 되돌린다", async () => {
  const db = new RecordingDb([{ rows: [{ id: "item-1", slug: "renamed-tool" }], rowCount: 1 }]);

  const result = await updateToolCatalogItemWithDb(db, "user-1", "item-1", { ...submission, slug: "renamed-tool" });

  assert.deepEqual(result, { ok: true, id: "item-1", slug: "renamed-tool" });
  assert.match(db.calls[0]!.sql, /trust_status = 'community'/);
  assert.match(db.calls[0]!.sql, /WHERE id = \$1 AND owner_user_id = \$2/);
  assert.deepEqual(db.calls[0]!.params?.slice(0, 2), ["item-1", "user-1"]);
});

test("작성자 보관은 해당 소유자의 항목만 archived로 바꾼다", async () => {
  const db = new RecordingDb([{ rows: [{ id: "item-1" }], rowCount: 1 }]);

  const result = await archiveToolCatalogItemWithDb(db, "user-1", "item-1");

  assert.deepEqual(result, { ok: true });
  assert.match(db.calls[0]!.sql, /lifecycle_status = 'archived'/);
  assert.match(db.calls[0]!.sql, /owner_user_id = \$2/);
});

test("관리자 아닌 사용자의 moderation은 SQL 실행 전에 거부한다", async () => {
  const db = new RecordingDb([]);

  const result = await moderateToolCatalogItemWithDb(
    db,
    { id: "user-1", role: "member" },
    "item-1",
    { trustStatus: "verified", lifecycleStatus: "published", statusReason: null },
  );

  assert.deepEqual(result, { ok: false, reason: "forbidden" });
  assert.equal(db.calls.length, 0);
});

test("관리자는 신뢰·수명주기·사유만 변경한다", async () => {
  const db = new RecordingDb([{ rows: [{ id: "item-1" }], rowCount: 1 }]);

  const result = await moderateToolCatalogItemWithDb(
    db,
    { id: "admin-1", role: "admin" },
    "item-1",
    { trustStatus: "community", lifecycleStatus: "blocked", statusReason: "credential exposure" },
  );

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(db.calls[0]!.params, ["item-1", "community", "blocked", "credential exposure"]);
  assert.doesNotMatch(db.calls[0]!.sql, /source_url\s*=|owner_user_id\s*=/);
});

test("공개 카탈로그는 공식 원본과 고유 slug를 가진 읽기 전용 항목이다", () => {
  assert.equal(PUBLIC_TOOL_CATALOG.length, 3);
  assert.equal(new Set(PUBLIC_TOOL_CATALOG.map((item) => item.slug)).size, PUBLIC_TOOL_CATALOG.length);
  assert.deepEqual(
    PUBLIC_TOOL_CATALOG.map((item) => [item.slug, item.sourceUrl, item.sourceRef]),
    [
      ["github-mcp-server", "https://github.com/github/github-mcp-server", "v0.31.0"],
      ["context7", "https://github.com/upstash/context7", "@upstash/context7-mcp@3.2.0"],
      ["superpowers", "https://github.com/obra/superpowers", "v5.0.7"],
    ],
  );
  assert.ok(
    PUBLIC_TOOL_CATALOG.every(
      (item) =>
        item.origin === "public" &&
        item.ownerUserId === null &&
        item.trustStatus === "verified" &&
        item.lifecycleStatus === "published",
    ),
  );
});

test("워크스페이스 게시물은 공개 slug와 충돌할 수 없다", async () => {
  const db = new RecordingDb([]);

  const result = await createToolCatalogItemWithDb(db, "user-1", {
    ...submission,
    slug: "github-mcp-server",
  });

  assert.deepEqual(result, { ok: false, reason: "slug-conflict" });
  assert.equal(db.calls.length, 0);
});

test("공개·워크스페이스 합성은 필터와 설치 상태를 함께 계산한다", () => {
  const items = composeToolCatalogItems(
    [
      {
        ...submission,
        id: "item-1",
        origin: "workspace",
        trustStatus: "community",
        lifecycleStatus: "published",
        statusReason: null,
        ownerUserId: "user-1",
        ownerName: "owner@example.com",
        createdAt: new Date("2026-07-13T00:00:00Z"),
        updatedAt: new Date("2026-07-13T00:00:00Z"),
      },
    ],
    { id: "user-1", role: "member" },
    { scope: "mine", kind: "skill", query: "pull request" },
    [],
  );

  assert.equal(items.length, 1);
  assert.equal(items[0]?.slug, "github-pr-review");
  assert.deepEqual(items[0]?.installState, { status: "not_installed" });
});

test("인벤토리 조회 실패는 카탈로그를 막지 않고 확인 불가 상태가 된다", () => {
  const items = composeToolCatalogItems(
    [],
    { id: "user-1", role: "member" },
    { scope: "public", kind: "mcp", query: "github" },
    null,
  );

  assert.equal(items.length, 1);
  assert.equal(items[0]?.slug, "github-mcp-server");
  assert.deepEqual(items[0]?.installState, { status: "unavailable" });
});

test("공유 FormData는 안전한 submission 필드만 구조화한다", () => {
  const formData = new FormData();
  formData.set("name", "GitHub PR Review");
  formData.set("slug", "github-pr-review");
  formData.set("description", "Reviews pull requests");
  formData.set("kind", "skill");
  formData.set("sourceUrl", "https://github.com/acme/github-pr-review");
  formData.set("sourceRef", "v1.2.3");
  formData.append("supportedClients", "codex");
  formData.append("supportedClients", "claude_code");
  formData.set("requiredEnv", "GITHUB_TOKEN\nSENTRY_DSN");
  formData.set("networkHosts", "api.github.com\n github.com ");
  formData.set("installNotes", "Install notes");
  formData.set("uninstallNotes", "Remove notes");
  formData.set("inventoryItemKey", "github-pr-review");
  formData.set("inventorySourceProvider", "codex");
  formData.set("trustStatus", "verified");
  formData.set("ownerUserId", "attacker");

  assert.deepEqual(submissionFromFormData(formData), {
    name: "GitHub PR Review",
    slug: "github-pr-review",
    description: "Reviews pull requests",
    kind: "skill",
    sourceUrl: "https://github.com/acme/github-pr-review",
    sourceRef: "v1.2.3",
    supportedClients: ["codex", "claude_code"],
    requiredEnv: ["GITHUB_TOKEN", "SENTRY_DSN"],
    networkHosts: ["api.github.com", "github.com"],
    installNotes: "Install notes",
    uninstallNotes: "Remove notes",
    inventoryItemKey: "github-pr-review",
    inventorySourceProvider: "codex",
  });
});
