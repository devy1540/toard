"use server";

import { revalidatePath } from "next/cache";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session-user";
import { getToolDeploymentRepository } from "@/lib/tool-deployment-repository";
import { mutateTeamPolicy } from "@/lib/tool-deployment-service";
import { toolDeploymentExperimentalEnabled } from "@/lib/tool-deployment-feature";

const FINGERPRINT = /^[a-f0-9]{64}$/;

function field(formData: FormData, name: string): string {
  return String(formData.get(name) ?? "").trim();
}

async function installableVersion(catalogItemId: string, versionId: string): Promise<boolean> {
  const result = await getPool().query(
    "SELECT 1 FROM tool_versions WHERE id = $1 AND catalog_item_id = $2",
    [versionId, catalogItemId],
  );
  return Boolean(result.rows[0]);
}

export async function installToolAction(formData: FormData): Promise<void> {
  if (!toolDeploymentExperimentalEnabled()) return;
  const viewer = await getSessionUser();
  if (!viewer) return;
  const catalogItemId = field(formData, "catalogItemId");
  const versionId = field(formData, "versionId");
  const slug = field(formData, "slug");
  const scope = field(formData, "scope") === "selected_devices" ? "selected_devices" : "all_devices";
  const fingerprints = formData.getAll("deviceFingerprints").map(String);
  if (!catalogItemId || !versionId || !(await installableVersion(catalogItemId, versionId))) return;
  if (scope === "selected_devices") {
    if (fingerprints.length === 0 || fingerprints.some((value) => !FINGERPRINT.test(value))) return;
    const owned = await getPool().query<{ fingerprint: string }>(
      "SELECT fingerprint FROM device_tool_inventory_snapshots WHERE user_id = $1 AND fingerprint = ANY($2::text[])",
      [viewer.id, [...new Set(fingerprints)]],
    );
    if (new Set(owned.rows.map((row) => row.fingerprint)).size !== new Set(fingerprints).size) return;
  }
  await getToolDeploymentRepository().savePersonalPreference({
    actorUserId: viewer.id,
    catalogItemId,
    mode: "install",
    scope,
    versionId,
    deviceFingerprints: scope === "selected_devices" ? fingerprints : [],
  });
  revalidatePath(`/library/${slug}`);
}

export async function excludeTeamDefaultAction(formData: FormData): Promise<void> {
  if (!toolDeploymentExperimentalEnabled()) return;
  const viewer = await getSessionUser();
  if (!viewer) return;
  const catalogItemId = field(formData, "catalogItemId");
  const slug = field(formData, "slug");
  if (!catalogItemId) return;
  await getToolDeploymentRepository().savePersonalPreference({
    actorUserId: viewer.id,
    catalogItemId,
    mode: "exclude",
    scope: "all_devices",
    versionId: null,
    deviceFingerprints: [],
  });
  revalidatePath(`/library/${slug}`);
}

export async function deployTeamDefaultAction(formData: FormData): Promise<void> {
  if (!toolDeploymentExperimentalEnabled()) return;
  const viewer = await getSessionUser();
  if (!viewer?.teamId) return;
  const catalogItemId = field(formData, "catalogItemId");
  const versionId = field(formData, "versionId");
  const slug = field(formData, "slug");
  if (!catalogItemId || !versionId || !(await installableVersion(catalogItemId, versionId))) return;
  await mutateTeamPolicy(
    viewer,
    { teamId: viewer.teamId, catalogItemId, versionId },
    getToolDeploymentRepository(),
  );
  revalidatePath(`/library/${slug}`);
}

export async function approveTeamRolloutAction(formData: FormData): Promise<void> {
  if (!toolDeploymentExperimentalEnabled()) return;
  const viewer = await getSessionUser();
  if (!viewer?.teamId || viewer.teamRole !== "leader") return;
  const catalogItemId = field(formData, "catalogItemId");
  const slug = field(formData, "slug");
  await getPool().query(
    `WITH changed AS (
       UPDATE team_tool_policies SET rollout_phase = 'canary', rollout_percent = 10,
         phase_started_at = now(), updated_by = $1, updated_at = now()
       WHERE team_id = $2 AND catalog_item_id = $3 AND rollout_phase = 'paused'
       RETURNING team_id, catalog_item_id
     )
     INSERT INTO tool_deployment_audit (actor_user_id, action, team_id, catalog_item_id, after_value)
     SELECT $1, 'team_permission_change_approved', team_id, catalog_item_id,
            '{"rolloutPhase":"canary","rolloutPercent":10}'::jsonb FROM changed`,
    [viewer.id, viewer.teamId, catalogItemId],
  );
  revalidatePath(`/library/${slug}`);
}
