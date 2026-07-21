import assert from "node:assert/strict";
import test from "node:test";
import {
  filterToolCatalogItems,
  parseToolCatalogSubmission,
  resolveCatalogInstallState,
  type ToolCatalogItem,
  type ToolCatalogSubmission,
} from "./tool-catalog";

const validSubmission: ToolCatalogSubmission = {
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

const catalogItem: ToolCatalogItem = {
  ...validSubmission,
  id: "workspace:item-1",
  origin: "workspace",
  trustStatus: "community",
  lifecycleStatus: "published",
  statusReason: null,
  ownerUserId: "user-1",
  ownerName: "owner@example.com",
  createdAt: new Date("2026-07-13T00:00:00Z"),
  updatedAt: new Date("2026-07-13T00:00:00Z"),
};

test("카탈로그 입력은 공백과 중복 배열을 정규화한다", () => {
  const result = parseToolCatalogSubmission({
    ...validSubmission,
    name: "  GitHub PR Review  ",
    requiredEnv: [" GITHUB_TOKEN ", "GITHUB_TOKEN"],
    networkHosts: [" API.GITHUB.COM ", "api.github.com"],
    supportedClients: ["codex", "codex"],
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.name, "GitHub PR Review");
  assert.deepEqual(result.value.requiredEnv, ["GITHUB_TOKEN"]);
  assert.deepEqual(result.value.networkHosts, ["api.github.com"]);
  assert.deepEqual(result.value.supportedClients, ["codex"]);
});

test("카탈로그 입력은 semantic tag와 full commit SHA만 ref로 허용한다", () => {
  for (const sourceRef of ["1.2.3", "v1.2.3", "v1.2.3-rc.1", "a".repeat(40)]) {
    assert.equal(parseToolCatalogSubmission({ ...validSubmission, sourceRef }).ok, true, sourceRef);
  }
  for (const sourceRef of ["main", "latest", "1.2", "abc1234", "a".repeat(39)]) {
    const result = parseToolCatalogSubmission({ ...validSubmission, sourceRef });
    assert.equal(result.ok, false, sourceRef);
    if (!result.ok) assert.equal(result.fieldErrors.sourceRef, "invalid");
  }
});

test("카탈로그 입력은 credential·HTTP·로컬·사설 source URL을 거부한다", () => {
  const invalidUrls = [
    "http://github.com/acme/tool",
    "https://user:pass@github.com/acme/tool",
    "https://localhost/acme/tool",
    "https://tool.local/acme/tool",
    "https://127.0.0.1/acme/tool",
    "https://10.0.0.2/acme/tool",
    "https://172.16.0.2/acme/tool",
    "https://192.168.0.2/acme/tool",
    "https://[::1]/acme/tool",
    "not-a-url",
  ];

  for (const sourceUrl of invalidUrls) {
    const result = parseToolCatalogSubmission({ ...validSubmission, sourceUrl });
    assert.equal(result.ok, false, sourceUrl);
    if (!result.ok) assert.equal(result.fieldErrors.sourceUrl, "invalid");
  }
});

test("카탈로그 입력은 환경변수 값과 URL 형태 network host를 거부한다", () => {
  const secret = parseToolCatalogSubmission({ ...validSubmission, requiredEnv: ["TOKEN=secret"] });
  const urlHost = parseToolCatalogSubmission({ ...validSubmission, networkHosts: ["https://api.github.com/path"] });
  const noClient = parseToolCatalogSubmission({ ...validSubmission, supportedClients: [] });

  assert.equal(secret.ok, false);
  if (!secret.ok) assert.equal(secret.fieldErrors.requiredEnv, "invalid");
  assert.equal(urlHost.ok, false);
  if (!urlHost.ok) assert.equal(urlHost.fieldErrors.networkHosts, "invalid");
  assert.equal(noClient.ok, false);
  if (!noClient.ok) assert.equal(noClient.fieldErrors.supportedClients, "invalid");
});

test("카탈로그 검색은 범위·유형·이름과 설명을 함께 적용한다", () => {
  const publicMcp: ToolCatalogItem = {
    ...catalogItem,
    id: "public:context7",
    slug: "context7",
    name: "Context7",
    description: "Current library documentation",
    kind: "mcp",
    origin: "public",
    ownerUserId: null,
    ownerName: null,
  };

  assert.deepEqual(
    filterToolCatalogItems([catalogItem, publicMcp], {
      scope: "public",
      kind: "mcp",
      query: "DOCUMENTATION",
      viewerId: "user-1",
    }).map((item) => item.slug),
    ["context7"],
  );
  assert.deepEqual(
    filterToolCatalogItems([catalogItem, publicMcp], {
      scope: "mine",
      kind: "all",
      query: "pull requests",
      viewerId: "user-1",
    }).map((item) => item.slug),
    ["github-pr-review"],
  );
});

test("인벤토리 식별자가 없으면 미설치로 판단한다", () => {
  assert.deepEqual(resolveCatalogInstallState(catalogItem, []), { status: "not_installed" });
});

test("인벤토리 식별자가 일치하고 버전이 없으면 업데이트 여부를 추측하지 않는다", () => {
  const state = resolveCatalogInstallState(catalogItem, [
    {
      tokenId: "token-1",
      host: "macbook.local",
      fingerprint: "f".repeat(64),
      observedAt: new Date("2026-07-13T00:00:00Z"),
      receivedAt: new Date("2026-07-13T00:00:00Z"),
      items: [
        {
          kind: "skill",
          itemKey: "github-pr-review",
          displayName: "GitHub PR Review",
          sourceProvider: "codex",
          pluginKey: null,
          version: null,
          enabled: true,
        },
      ],
    },
  ]);

  assert.deepEqual(state, { status: "installed", version: null, versionRelation: "unknown" });
});

test("인벤토리와 source ref 버전이 모두 있을 때만 동일 여부를 계산한다", () => {
  const inventory = (version: string) => [
    {
      tokenId: "token-1",
      host: "macbook.local",
      fingerprint: "f".repeat(64),
      observedAt: new Date("2026-07-13T00:00:00Z"),
      receivedAt: new Date("2026-07-13T00:00:00Z"),
      items: [
        {
          kind: "skill" as const,
          itemKey: "github-pr-review",
          displayName: "GitHub PR Review",
          sourceProvider: "codex",
          pluginKey: null,
          version,
          enabled: true,
        },
      ],
    },
  ];

  assert.deepEqual(resolveCatalogInstallState(catalogItem, inventory("v1.2.3")), {
    status: "installed",
    version: "v1.2.3",
    versionRelation: "same",
  });
  assert.deepEqual(resolveCatalogInstallState(catalogItem, inventory("v1.2.2")), {
    status: "installed",
    version: "v1.2.2",
    versionRelation: "different",
  });
});
