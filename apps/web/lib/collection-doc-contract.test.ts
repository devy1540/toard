import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function repoSource(path: string): string {
  return readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
}

const readme = repoSource("README.md");
const architecture = repoSource("docs/ARCHITECTURE.md");
const deploy = repoSource("docs/DEPLOY.md");
const shim = repoSource("shim/README.md");
const toolMetadata = repoSource("docs/tool-metadata-collection.md");
const transitionDesign = repoSource("docs/design-usage-pull.md");

test("공개 수집 문서는 pull-primary와 experimental OTLP 경계를 같은 endpoint로 설명한다", () => {
  for (const [name, document] of [
    ["README", readme],
    ["architecture", architecture],
    ["deploy", deploy],
    ["shim", shim],
  ] as const) {
    assert.match(document, /\/api\/v1\/events/, `${name}: primary events endpoint`);
    assert.match(document, /experimental[\s\S]{0,160}\/api\/v1\/logs|\/api\/v1\/logs[\s\S]{0,160}experimental/i,
      `${name}: experimental OTLP endpoint`);
  }

  for (const document of [architecture, deploy]) {
    assert.match(document, /단방향 HTTPS/);
    assert.match(document, /target별 (?:파일 stamp와 전송 진행 )?cursor/);
    assert.match(document, /별도 durable (?:shim )?outbox는 없다/);
    assert.match(document, /원본 session 파일을 삭제하면|원본 파일을 삭제하면/);
    assert.match(document, /dedup/);
  }
});

test("문서 endpoint 표와 shim 전송 메서드는 현재 HTTP 계약을 유지한다", () => {
  const postSource = repoSource("shim/rust/src/collect/post.rs");
  for (const [method, endpoint] of [
    ["POST", "/api/v1/events"],
    ["POST", "/api/v1/events/reconcile"],
    ["POST", "/api/v1/prompts"],
    ["POST", "/api/v1/prompts/reconcile"],
    ["POST", "/api/v1/tool-events"],
    ["PUT", "/api/v1/tool-inventory"],
    ["POST", "/api/v1/logs"],
  ] as const) {
    const row = `| \`${method}\` | \`${endpoint}\``;
    assert.equal(architecture.includes(row), true, `architecture: ${method} ${endpoint}`);
    assert.equal(deploy.includes(row), true, `deploy: ${method} ${endpoint}`);
    assert.equal(shim.includes(row), true, `shim: ${method} ${endpoint}`);
  }
  assert.match(postSource, /"POST", "\/v1\/events"/);
  assert.match(postSource, /"POST", "\/v1\/prompts"/);
  assert.match(postSource, /"POST",\s*"\/v1\/events\/reconcile"/);
  assert.match(postSource, /"POST",\s*"\/v1\/prompts\/reconcile"/);
  assert.match(postSource, /"POST",\s*"\/v1\/tool-events"/);
  assert.match(postSource, /"PUT",\s*"\/v1\/tool-inventory"/);
});

test("provider baseline과 문서 지원표는 usage 5종과 tool 3종을 구분한다", () => {
  const seed = repoSource("scripts/seed.ts");
  for (const provider of ["claude_code", "codex", "cursor", "gemini", "qwen"]) {
    assert.match(seed, new RegExp(`'${provider}'[\\s\\S]{0,120}'logfile'`));
  }
  for (const label of ["Claude Code", "Codex", "Cursor", "Gemini", "Qwen"]) {
    assert.match(shim, new RegExp(`\\| ${label} \\|`));
    assert.match(toolMetadata, new RegExp(`\\| ${label} \\|`));
  }
  assert.match(toolMetadata, /\| Gemini \| 미지원 \| 미지원 \|/);
  assert.match(toolMetadata, /\| Qwen \| 미지원 \| 미지원 \|/);
});

test("provider 대칭 gate와 과거 전환 문서 상태를 고정한다", () => {
  const eventsRoute = repoSource("apps/web/app/api/v1/events/route.ts");
  const otlpProvider = repoSource("packages/ingest/src/provider.ts");
  assert.match(eventsRoute, /collectionMethod === "logfile"/);
  assert.match(otlpProvider, /collectionMethod !== "otel"/);
  assert.match(readme, /collection_method='logfile'.*collection_method='otel'/);
  assert.match(transitionDesign, /상태: 구현 완료\(Implemented\).*역사적 전환 설계/);
  assert.match(transitionDesign, /전환 전 Claude Code·Codex/);
  assert.doesNotMatch(transitionDesign, /상태: 제안\(Proposed\)/);
});

test("현재 실행 문서는 stale OTLP-first 계획 문구를 다시 허용하지 않는다", () => {
  const currentDocs = [readme, architecture, deploy].join("\n");
  for (const stale of [
    /Shim sends OTLP\/JSON directly to the app without a Collector/,
    /수집\(OTLP\)을 앱이\s*직수신/,
    /POST \/api\/v1\/logs`?만 1차 구현/,
    /로컬 로그 pull 경로 \(범용 수집 — 2차/,
    /\/events[^\n]*2차/,
    /무중단 배포[^\n]*수집 유실 방지/,
  ]) {
    assert.doesNotMatch(currentDocs, stale);
  }
});
