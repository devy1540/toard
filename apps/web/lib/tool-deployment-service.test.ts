import assert from "node:assert/strict";
import test from "node:test";
import type { ToolDeploymentManifestV1 } from "@toard/core";
import {
  DeploymentClientError,
  buildDeviceManifest,
  mutateTeamPolicy,
  type DeploymentServiceRepository,
} from "./tool-deployment-service";

const manifest: ToolDeploymentManifestV1 = {
  schemaVersion: 1,
  catalogItemId: "catalog-1",
  versionId: "version-1",
  slug: "review",
  kind: "skill",
  source: {
    provider: "github",
    repository: "acme/review",
    exactRef: "a".repeat(40),
    path: "",
    treeDigest: `sha256:${"b".repeat(64)}`,
    downloadUrl: "https://github.com/acme/review/archive/a.tar.gz",
  },
  clients: ["codex"],
  minProtocolVersion: 1,
  permissions: { env: [], networkHosts: [], executables: [] },
  payload: { type: "skill", files: ["SKILL.md"], targetKey: "review" },
};

function repository(overrides: Partial<DeploymentServiceRepository> = {}): DeploymentServiceRepository {
  return {
    async getDeviceContext() {
      return {
        userId: "user-1",
        deviceFingerprint: "a".repeat(64),
        preferences: [],
        teamPolicies: [
          { catalogItemId: "catalog-1", versionId: "version-1", rolloutSeed: "seed", rolloutPercent: 100 },
        ],
      };
    },
    async getManifestVersion() {
      return manifest;
    },
    async permissionDiffFromLastKnownGood() {
      return { approvalRequired: false };
    },
    async saveTeamPolicy() {},
    ...overrides,
  };
}

test("기기 manifest는 인증 token 소유 context로 원하는 버전을 조립한다", async () => {
  const result = await buildDeviceManifest(
    { userId: "user-1", tokenId: "token-1" },
    { fingerprint: "a".repeat(64), protocol: 1 },
    repository(),
    new Date("2026-07-15T00:00:00Z"),
  );

  assert.equal(result.schemaVersion, 1);
  assert.equal(result.reconcileAfterSeconds, 60);
  assert.equal(result.items[0]?.origin, "team");
  assert.equal(result.items[0]?.manifest.versionId, "version-1");
});

test("지원하지 않는 protocol과 token 소유가 아닌 기기는 닫힌 오류가 된다", async () => {
  await assert.rejects(
    buildDeviceManifest(
      { userId: "user-1", tokenId: "token-1" },
      { fingerprint: "a".repeat(64), protocol: 2 },
      repository(),
    ),
    (error: unknown) => error instanceof DeploymentClientError && error.status === 426,
  );
  await assert.rejects(
    buildDeviceManifest(
      { userId: "user-1", tokenId: "token-1" },
      { fingerprint: "a".repeat(64), protocol: 1 },
      repository({ async getDeviceContext() { return null; } }),
    ),
    (error: unknown) => error instanceof DeploymentClientError && error.status === 403,
  );
});

test("team leader만 자기 팀 정책을 저장하고 권한 확대는 paused로 시작한다", async () => {
  const saves: unknown[] = [];
  const repo = repository({
    async permissionDiffFromLastKnownGood() {
      return { approvalRequired: true };
    },
    async saveTeamPolicy(value) {
      saves.push(value);
    },
  });
  const leader = {
    id: "leader-1",
    email: "leader@example.com",
    role: "member",
    teamRole: "leader" as const,
    teamId: "team-a",
    teamName: "A",
    teamOnboardingCompletedAt: new Date(),
  };

  assert.deepEqual(
    await mutateTeamPolicy(leader, { teamId: "team-b", catalogItemId: "catalog-1", versionId: "version-2" }, repo),
    { ok: false, reason: "forbidden" },
  );
  assert.deepEqual(
    await mutateTeamPolicy(leader, { teamId: "team-a", catalogItemId: "catalog-1", versionId: "version-2" }, repo),
    { ok: true, rolloutPhase: "paused" },
  );
  assert.equal((saves[0] as { rolloutPercent: number }).rolloutPercent, 0);
});
