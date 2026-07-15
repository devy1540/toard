import assert from "node:assert/strict";
import test from "node:test";
import {
  diffToolPermissions,
  evaluateRollout,
  resolveDesiredTools,
  rolloutCohortPercent,
  type ToolDeploymentManifestV1,
} from "./tool-deployment";

const baseManifest: ToolDeploymentManifestV1 = {
  schemaVersion: 1,
  catalogItemId: "catalog-1",
  versionId: "version-1",
  slug: "github-review",
  kind: "mcp",
  source: {
    provider: "github",
    repository: "acme/github-review",
    exactRef: "a".repeat(40),
    path: "",
    treeDigest: `sha256:${"b".repeat(64)}`,
    downloadUrl: "https://github.com/acme/github-review/archive/a.tar.gz",
  },
  clients: ["codex", "claude_code"],
  minProtocolVersion: 1,
  permissions: {
    env: ["TOKEN"],
    networkHosts: ["api.github.com"],
    executables: ["node"],
  },
  payload: {
    type: "mcp_stdio",
    command: "node",
    args: ["server.js"],
    requiredEnvNames: ["TOKEN"],
    managedKey: "github-review",
  },
};

test("exclude가 개인 설치와 팀 기본보다 우선한다", () => {
  const desired = resolveDesiredTools({
    userId: "user-1",
    deviceFingerprint: "device-1",
    preferences: [
      {
        catalogItemId: "excluded",
        mode: "exclude",
        scope: "all_devices",
        versionId: null,
        deviceFingerprints: [],
      },
    ],
    teamPolicies: [
      { catalogItemId: "excluded", versionId: "team-v1", rolloutId: "rollout-excluded", rolloutSeed: "seed", rolloutPercent: 100 },
    ],
  });

  assert.deepEqual(desired, []);
});

test("선택 기기의 개인 설치가 팀 기본 버전보다 우선한다", () => {
  const desired = resolveDesiredTools({
    userId: "user-1",
    deviceFingerprint: "device-1",
    preferences: [
      {
        catalogItemId: "personal",
        mode: "install",
        scope: "selected_devices",
        versionId: "personal-v2",
        deviceFingerprints: ["device-1"],
      },
    ],
    teamPolicies: [
      { catalogItemId: "personal", versionId: "team-v1", rolloutId: "rollout-personal", rolloutSeed: "seed", rolloutPercent: 100 },
      { catalogItemId: "team", versionId: "team-v1", rolloutId: "rollout-team", rolloutSeed: "seed", rolloutPercent: 100 },
    ],
  });

  assert.deepEqual(desired, [
    { catalogItemId: "personal", versionId: "personal-v2", origin: "personal", rolloutId: null },
    { catalogItemId: "team", versionId: "team-v1", origin: "team", rolloutId: "rollout-team" },
  ]);
});

test("선택되지 않은 기기는 개인 선택 대신 팀 기본을 상속한다", () => {
  const desired = resolveDesiredTools({
    userId: "user-1",
    deviceFingerprint: "device-2",
    preferences: [
      {
        catalogItemId: "review",
        mode: "install",
        scope: "selected_devices",
        versionId: "personal-v2",
        deviceFingerprints: ["device-1"],
      },
    ],
    teamPolicies: [
      { catalogItemId: "review", versionId: "team-v1", rolloutId: "rollout-review", rolloutSeed: "seed", rolloutPercent: 100 },
    ],
  });

  assert.deepEqual(desired, [{ catalogItemId: "review", versionId: "team-v1", origin: "team", rolloutId: "rollout-review" }]);
});

test("새 환경변수와 source identity 변경은 승인을 요구한다", () => {
  const diff = diffToolPermissions(baseManifest, {
    ...baseManifest,
    versionId: "version-2",
    source: { ...baseManifest.source, repository: "other/github-review" },
    permissions: { ...baseManifest.permissions, env: ["TOKEN", "NEW_TOKEN"] },
  });

  assert.deepEqual(diff, {
    approvalRequired: true,
    addedEnv: ["NEW_TOKEN"],
    addedHosts: [],
    sourceChanged: true,
    commandChanged: false,
    componentsAdded: [],
  });
});

test("같은 권한과 source의 새 ref는 자동 업데이트할 수 있다", () => {
  const diff = diffToolPermissions(baseManifest, {
    ...baseManifest,
    versionId: "version-2",
    source: { ...baseManifest.source, exactRef: "c".repeat(40), treeDigest: `sha256:${"d".repeat(64)}` },
  });

  assert.equal(diff.approvalRequired, false);
});

test("rollout cohort는 같은 seed와 device에서 결정적이다", () => {
  assert.equal(
    rolloutCohortPercent("rollout-1", "device-1"),
    rolloutCohortPercent("rollout-1", "device-1"),
  );
});

test("2대 실패 또는 20퍼센트 실패면 rollback한다", () => {
  assert.deepEqual(
    evaluateRollout(
      {
        phase: "canary",
        eligible: 10,
        attempted: 2,
        failed: 2,
        phaseStartedAt: new Date(0),
      },
      new Date(5 * 60_000),
    ),
    { action: "rollback", reason: "failure_threshold" },
  );
  assert.deepEqual(
    evaluateRollout(
      {
        phase: "expand",
        eligible: 100,
        attempted: 10,
        failed: 2,
        phaseStartedAt: new Date(0),
      },
      new Date(5 * 60_000),
    ),
    { action: "rollback", reason: "failure_threshold" },
  );
});

test("canary 30분 뒤 50퍼센트, expand 60분 뒤 100퍼센트로 전진한다", () => {
  assert.deepEqual(
    evaluateRollout(
      {
        phase: "canary",
        eligible: 10,
        attempted: 1,
        failed: 0,
        phaseStartedAt: new Date(0),
      },
      new Date(30 * 60_000),
    ),
    { action: "advance", nextPhase: "expand", percent: 50 },
  );
  assert.deepEqual(
    evaluateRollout(
      {
        phase: "expand",
        eligible: 10,
        attempted: 5,
        failed: 0,
        phaseStartedAt: new Date(0),
      },
      new Date(60 * 60_000),
    ),
    { action: "advance", nextPhase: "active", percent: 100 },
  );
});
