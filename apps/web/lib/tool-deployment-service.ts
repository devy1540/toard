import {
  resolveDesiredTools,
  type ResolveDesiredInput,
  type ToolDeploymentManifestV1,
  type ToolPermissionDiff,
  type ToolRolloutPhase,
} from "@toard/core";
import type { IngestAuthResult } from "./ingest-auth";
import type { SessionUser } from "./session-user";
import { validateInstallManifest } from "./tool-source";

export class DeploymentClientError extends Error {
  constructor(
    readonly status: 400 | 403 | 409 | 426,
    readonly code: string,
  ) {
    super(code);
  }
}

export type DeviceManifestV1 = {
  schemaVersion: 1;
  generatedAt: Date;
  reconcileAfterSeconds: 60;
  items: Array<{
    catalogItemId: string;
    versionId: string;
    origin: "personal" | "team";
    manifest: ToolDeploymentManifestV1;
  }>;
};

export type DeploymentServiceRepository = {
  getDeviceContext(owner: IngestAuthResult, fingerprint: string): Promise<ResolveDesiredInput | null>;
  getManifestVersion(versionId: string): Promise<ToolDeploymentManifestV1 | null>;
  permissionDiffFromLastKnownGood(
    teamId: string,
    catalogItemId: string,
    versionId: string,
  ): Promise<Pick<ToolPermissionDiff, "approvalRequired">>;
  saveTeamPolicy(input: {
    actorUserId: string;
    teamId: string;
    catalogItemId: string;
    versionId: string;
    rolloutPhase: ToolRolloutPhase;
    rolloutPercent: number;
  }): Promise<void>;
};

const FINGERPRINT = /^[a-f0-9]{64}$/;

export async function buildDeviceManifest(
  owner: IngestAuthResult,
  input: { fingerprint: string; protocol: number },
  repository: DeploymentServiceRepository,
  now = new Date(),
): Promise<DeviceManifestV1> {
  if (input.protocol !== 1) throw new DeploymentClientError(426, "protocol_unsupported");
  if (!FINGERPRINT.test(input.fingerprint)) throw new DeploymentClientError(400, "invalid_fingerprint");
  const context = await repository.getDeviceContext(owner, input.fingerprint);
  if (!context) throw new DeploymentClientError(403, "device_not_owned");
  const desired = resolveDesiredTools(context);
  const items = await Promise.all(
    desired.map(async (entry) => {
      const manifest = await repository.getManifestVersion(entry.versionId);
      if (!manifest) throw new DeploymentClientError(409, "version_unavailable");
      return { ...entry, manifest: validateInstallManifest(manifest) };
    }),
  );
  return {
    schemaVersion: 1,
    generatedAt: now,
    reconcileAfterSeconds: 60,
    items,
  };
}

export type TeamPolicyMutationInput = {
  teamId: string;
  catalogItemId: string;
  versionId: string;
};

export type TeamPolicyMutationResult =
  | { ok: false; reason: "forbidden" }
  | { ok: true; rolloutPhase: "preflight" | "paused" };

export async function mutateTeamPolicy(
  actor: SessionUser,
  input: TeamPolicyMutationInput,
  repository: DeploymentServiceRepository,
): Promise<TeamPolicyMutationResult> {
  if (actor.teamRole !== "leader" || actor.teamId !== input.teamId) {
    return { ok: false, reason: "forbidden" };
  }
  const diff = await repository.permissionDiffFromLastKnownGood(
    input.teamId,
    input.catalogItemId,
    input.versionId,
  );
  const rolloutPhase = diff.approvalRequired ? "paused" : "preflight";
  await repository.saveTeamPolicy({
    actorUserId: actor.id,
    ...input,
    rolloutPhase,
    rolloutPercent: 0,
  });
  return { ok: true, rolloutPhase };
}
