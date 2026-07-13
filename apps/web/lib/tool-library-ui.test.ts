import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function messageShape(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return typeof value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, messageShape(nested)]),
  );
}

test("라이브러리 목록은 로그인 경계와 서버 카탈로그 query를 사용한다", () => {
  const page = source("app/(dashboard)/library/page.tsx");

  assert.match(page, /getDashboardViewer/);
  assert.match(page, /if \(!viewer\) redirect\("\/login"\)/);
  assert.match(page, /listToolCatalog/);
  assert.match(page, /scope: parseScope\(sp\.scope\)/);
  assert.match(page, /kind: parseKind\(sp\.kind\)/);
  assert.match(page, /grid-cols-\[minmax\(0,1fr\)_auto\]/);
  assert.match(page, /md:grid-cols-/);
  assert.doesNotMatch(page, /overflow-x-scroll/);
});

test("라이브러리 상세는 원본과 안전 메타데이터만 표시한다", () => {
  const page = source("app/(dashboard)/library/[slug]/page.tsx");

  assert.match(page, /getToolCatalogItem/);
  assert.match(page, /item\.sourceUrl/);
  assert.match(page, /item\.sourceRef/);
  assert.match(page, /item\.requiredEnv/);
  assert.match(page, /item\.networkHosts/);
  assert.match(page, /item\.installState/);
  assert.match(page, /rel="noreferrer"/);
  assert.match(page, /item\.lifecycleStatus === "blocked"/);
  assert.doesNotMatch(page, /type="password"|name="token"|dangerouslySetInnerHTML/);
});

test("도구 라이브러리는 워크스페이스 내비게이션에 연결된다", () => {
  const nav = source("components/dashboard/sidebar-nav.tsx");
  const ko = JSON.parse(source("messages/ko/nav.json"));
  const en = JSON.parse(source("messages/en/nav.json"));

  assert.match(nav, /href: "\/library", key: "library"/);
  assert.equal(ko.library, "도구 라이브러리");
  assert.equal(en.library, "Tool library");
});

test("한영 라이브러리 메시지는 동일한 구조와 주요 상태 문구를 가진다", () => {
  const ko = JSON.parse(source("messages/ko/library.json"));
  const en = JSON.parse(source("messages/en/library.json"));

  assert.deepEqual(messageShape(ko), messageShape(en));
  for (const catalog of [ko, en]) {
    assert.equal(typeof catalog.scope.all, "string");
    assert.equal(typeof catalog.scope.mine, "string");
    assert.equal(typeof catalog.kind.plugin, "string");
    assert.equal(typeof catalog.trust.verified, "string");
    assert.equal(typeof catalog.lifecycle.blocked, "string");
    assert.equal(typeof catalog.state.unavailable, "string");
    assert.equal(typeof catalog.detail.tagNotice, "string");
  }
});

test("library 메시지 namespace는 request loader와 타입에 등록된다", () => {
  const request = source("i18n/request.ts");
  const messages = source("i18n/messages.ts");

  assert.match(request, /messages\/\$\{locale\}\/library\.json/);
  assert.match(request, /library: library\.default/);
  assert.match(messages, /type library from "\.\.\/messages\/en\/library\.json"/);
  assert.match(messages, /library: typeof library/);
});

test("공유 action은 로그인 사용자를 owner로 강제하고 신뢰 상태를 폼에서 읽지 않는다", () => {
  const action = source("app/(dashboard)/library/share/actions.ts");
  const parser = source("lib/tool-catalog-form.ts");

  assert.match(action, /getDashboardViewer/);
  assert.match(action, /parseToolCatalogSubmission/);
  assert.match(parser, /\.getAll\("supportedClients"\)/);
  assert.match(action, /createToolCatalogItem\(viewer\.id/);
  assert.match(action, /updateToolCatalogItem\(viewer\.id, id/);
  assert.doesNotMatch(action, /formData\.get\("trustStatus"\)|formData\.get\("ownerUserId"\)/);
});

test("공유 action의 redirect는 DB 오류 catch 밖에서 실행된다", () => {
  const action = source("app/(dashboard)/library/share/actions.ts");
  const updateStart = action.indexOf("export async function updateToolCatalogAction");
  const createBody = action.slice(0, updateStart);
  const updateBody = action.slice(updateStart);

  for (const body of [createBody, updateBody]) {
    assert.notEqual(body.indexOf("} catch"), -1);
    assert.equal(body.indexOf("redirect(`") > body.indexOf("} catch"), true);
  }
});

test("공유 폼은 환경변수 이름과 host만 받고 비밀값 입력을 만들지 않는다", () => {
  const form = source("app/(dashboard)/library/share/tool-share-form.tsx");

  assert.match(form, /name="requiredEnv"/);
  assert.match(form, /name="networkHosts"/);
  assert.match(form, /name="supportedClients"/);
  assert.doesNotMatch(form, /type="password"|secretValue|tokenValue|credentialValue/);
});

test("편집 페이지와 보관 action은 작성자 소유권을 다시 확인한다", () => {
  const edit = source("app/(dashboard)/library/[slug]/edit/page.tsx");
  const archive = source("app/(dashboard)/library/tool-actions.ts");
  const detail = source("app/(dashboard)/library/[slug]/page.tsx");

  assert.match(edit, /item\.ownerUserId !== viewer\.id/);
  assert.match(edit, /mode="edit"/);
  assert.match(archive, /archiveToolCatalogItem\(viewer\.id, id\)/);
  assert.match(detail, /item\.ownerUserId === viewer\.id/);
  assert.match(detail, /\/edit/);
});

test("관리 화면은 게시 승인 게이트가 아닌 사후 moderation 탭을 제공한다", () => {
  const page = source("app/(dashboard)/admin/page.tsx");
  const action = source("app/(dashboard)/admin/library-actions.ts");
  const panel = source("app/(dashboard)/admin/library-panel.tsx");

  assert.match(page, /raw === "library"/);
  assert.match(page, /<LibraryPanel/);
  assert.match(action, /user\.role !== "admin"/);
  assert.match(action, /isToolCatalogTrust/);
  assert.match(action, /isToolCatalogLifecycle/);
  assert.match(action, /moderateToolCatalogItem/);
  assert.match(action, /lifecycleStatus === "blocked" \|\| lifecycleStatus === "deprecated"/);
  assert.match(panel, /name="verified"/);
  assert.match(panel, /name="lifecycleStatus"/);
  assert.match(panel, /name="statusReason"/);
  assert.doesNotMatch(action, /approvePublication|rejectPublication/);
});

test("관리자 한영 메시지는 도구 탭과 사후 관리 문구를 같은 구조로 제공한다", () => {
  const ko = JSON.parse(source("messages/ko/admin.json"));
  const en = JSON.parse(source("messages/en/admin.json"));

  assert.deepEqual(messageShape(ko), messageShape(en));
  assert.equal(typeof ko.tabs.library, "string");
  assert.equal(typeof en.library.immediateNotice, "string");
  assert.equal(typeof ko.library.errors.reasonRequired, "string");
});
