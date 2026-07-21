import assert from "node:assert/strict";
import test from "node:test";
import type { ToolDeploymentManifestV1 } from "@toard/core";
import {
  canonicalTreeDigest,
  normalizeSafeRelativePath,
  permissionFingerprint,
  validateInstallManifest,
} from "./tool-source";

const bytes = (value: string) => new TextEncoder().encode(value);

const validManifest: ToolDeploymentManifestV1 = {
  schemaVersion: 1,
  catalogItemId: "catalog-1",
  versionId: "version-1",
  slug: "github-review",
  kind: "mcp",
  source: {
    provider: "github",
    repository: "acme/github-review",
    exactRef: "a".repeat(40),
    path: "server",
    treeDigest: `sha256:${"b".repeat(64)}`,
    downloadUrl: "https://github.com/acme/github-review/archive/a.tar.gz",
  },
  clients: ["codex"],
  minProtocolVersion: 1,
  permissions: { env: ["GITHUB_TOKEN"], networkHosts: ["api.github.com"], executables: ["node"] },
  payload: {
    type: "mcp_stdio",
    command: "node",
    args: ["server/index.js"],
    requiredEnvNames: ["GITHUB_TOKEN"],
    managedKey: "github-review",
  },
};

const validStdioPayload = {
  type: "mcp_stdio" as const,
  command: "node",
  args: ["server/index.js"],
  requiredEnvNames: ["GITHUB_TOKEN"],
  managedKey: "github-review",
};

test("canonical tree digest는 입력 순서와 archive metadata에 무관하다", () => {
  const first = canonicalTreeDigest([
    { path: "SKILL.md", bytes: bytes("a") },
    { path: "references/x.md", bytes: bytes("b") },
  ]);
  const second = canonicalTreeDigest([
    { path: "references/x.md", bytes: bytes("b") },
    { path: "SKILL.md", bytes: bytes("a") },
  ]);

  assert.equal(first, second);
  assert.match(first, /^sha256:[a-f0-9]{64}$/);
});

test("상대 경로는 traversal, absolute, NUL, 중복 separator를 거부한다", () => {
  assert.equal(normalizeSafeRelativePath("references/api.md"), "references/api.md");
  for (const path of ["../secret", "/etc/passwd", "a/../../b", "a\u0000b", "a//b", "./a"]) {
    assert.throws(() => normalizeSafeRelativePath(path), /unsafe source path/);
  }
});

test("manifest는 shell string과 unpinned npx package를 거부한다", () => {
  assert.throws(
    () =>
      validateInstallManifest({
        ...validManifest,
        payload: { ...validStdioPayload, command: "bash", args: ["-c", "curl bad"] },
      }),
    /shell command/,
  );
  assert.throws(
    () =>
      validateInstallManifest({
        ...validManifest,
        payload: { ...validStdioPayload, command: "sh -c curl bad" },
      }),
    /invalid command/,
  );
  assert.throws(
    () =>
      validateInstallManifest({
        ...validManifest,
        payload: {
          type: "mcp_stdio",
          command: "npx",
          args: ["@acme/server@latest"],
          requiredEnvNames: [],
          managedKey: "server",
        },
      }),
    /pinned package/,
  );
});

test("Skill manifest는 SKILL.md와 안전한 파일만 허용한다", () => {
  const skill: ToolDeploymentManifestV1 = {
    ...validManifest,
    kind: "skill",
    payload: { type: "skill", files: ["references/api.md"], targetKey: "review" },
  };
  assert.throws(() => validateInstallManifest(skill), /SKILL.md/);
  assert.throws(
    () => validateInstallManifest({ ...skill, payload: { type: "skill", targetKey: "review", files: ["SKILL.md", "../secret"] } }),
    /unsafe source path/,
  );
  assert.equal(
    validateInstallManifest({ ...skill, payload: { type: "skill", targetKey: "review", files: ["SKILL.md"] } }).payload.type,
    "skill",
  );
});

test("permission fingerprint는 권한 배열 순서가 달라도 같다", () => {
  assert.equal(
    permissionFingerprint({ env: ["B", "A"], networkHosts: ["b.example", "a.example"], executables: ["node"] }),
    permissionFingerprint({ env: ["A", "B"], networkHosts: ["a.example", "b.example"], executables: ["node"] }),
  );
});
