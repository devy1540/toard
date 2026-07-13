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
