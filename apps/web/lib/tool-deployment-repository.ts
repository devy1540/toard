import {
  diffToolPermissions,
  type ResolveDesiredInput,
  type ToolDeploymentManifestV1,
  type ToolDeploymentStatus,
  type ToolPermissionDiff,
  type ToolRolloutPhase,
} from "@toard/core";
import type { IngestAuthResult } from "./ingest-auth";
import { getPool } from "./db";
import { validateInstallManifest } from "./tool-source";

type QueryResult<T> = { rows: T[]; rowCount?: number | null };

export type ToolDeploymentQueryable = {
  query<T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
};

export type ToolDeploymentClient = ToolDeploymentQueryable & { release(): void };

export type ToolDeploymentDb = ToolDeploymentQueryable & {
  connect(): Promise<ToolDeploymentClient>;
};

export type PersonalPreferenceInput = {
  actorUserId: string;
  catalogItemId: string;
  mode: "install" | "exclude";
  scope: "all_devices" | "selected_devices";
  versionId: string | null;
  deviceFingerprints: string[];
};

export type DeploymentReportInput = {
  deviceFingerprint: string;
  catalogItemId: string;
  desiredVersionId: string | null;
  appliedVersionId: string | null;
  status: ToolDeploymentStatus;
  errorCode: string | null;
  attempt: number;
  rolloutId: string | null;
};

export type SaveTeamPolicyInput = {
  actorUserId: string;
  teamId: string;
  catalogItemId: string;
  versionId: string;
  rolloutPhase: ToolRolloutPhase;
  rolloutPercent: number;
};

export type ToolDeploymentRepository = {
  savePersonalPreference(input: PersonalPreferenceInput): Promise<void>;
  saveDeploymentReport(owner: IngestAuthResult, report: DeploymentReportInput): Promise<void>;
  getDeviceContext(owner: IngestAuthResult, fingerprint: string): Promise<ResolveDesiredInput | null>;
  getManifestVersion(versionId: string): Promise<ToolDeploymentManifestV1 | null>;
  deviceBelongsToToken(owner: IngestAuthResult, fingerprint: string): Promise<boolean>;
  permissionDiffFromLastKnownGood(
    teamId: string,
    catalogItemId: string,
    versionId: string,
  ): Promise<Pick<ToolPermissionDiff, "approvalRequired">>;
  saveTeamPolicy(input: SaveTeamPolicyInput): Promise<void>;
};

const FINGERPRINT = /^[a-f0-9]{64}$/;
const ERROR_CODE = /^[a-z0-9_]{1,80}$/;

async function inTransaction<T>(db: ToolDeploymentDb, work: (client: ToolDeploymentClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function validatePersonalPreference(input: PersonalPreferenceInput): void {
  if (input.mode === "install" && !input.versionId) throw new Error("install preference requires versionId");
  if (input.mode === "exclude" && input.versionId) throw new Error("exclude preference cannot include versionId");
  if (input.deviceFingerprints.some((value) => !FINGERPRINT.test(value))) {
    throw new Error("invalid device fingerprint");
  }
}

function validateReport(report: DeploymentReportInput): void {
  if (!FINGERPRINT.test(report.deviceFingerprint)) throw new Error("invalid device fingerprint");
  if (!Number.isSafeInteger(report.attempt) || report.attempt < 0) throw new Error("invalid attempt");
  if (report.errorCode !== null && !ERROR_CODE.test(report.errorCode)) throw new Error("invalid error code");
}

export function createToolDeploymentRepository(db: ToolDeploymentDb): ToolDeploymentRepository {
  return {
    async getDeviceContext(owner, fingerprint) {
      if (!FINGERPRINT.test(fingerprint)) return null;
      const device = await db.query<{ team_id: string | null }>(
        `SELECT u.team_id
         FROM device_tool_inventory_snapshots s
         JOIN users u ON u.id = s.user_id
         WHERE s.user_id = $1 AND s.ingest_token_id = $2 AND s.fingerprint = $3
         LIMIT 1`,
        [owner.userId, owner.tokenId, fingerprint],
      );
      const row = device.rows[0];
      if (!row) return null;
      const preferences = await db.query<{
        catalog_item_id: string;
        mode: "install" | "exclude";
        install_scope: "all_devices" | "selected_devices";
        target_version_id: string | null;
        device_fingerprints: string[];
      }>(
        `SELECT p.catalog_item_id, p.mode, p.install_scope, p.target_version_id,
                COALESCE(array_agg(d.device_fingerprint ORDER BY d.device_fingerprint)
                  FILTER (WHERE d.device_fingerprint IS NOT NULL), '{}') AS device_fingerprints
         FROM user_tool_preferences p
         JOIN tool_catalog_items c
           ON c.id::text = p.catalog_item_id
          AND c.lifecycle_status IN ('published', 'deprecated')
         LEFT JOIN user_tool_preference_devices d
           ON d.user_id = p.user_id AND d.catalog_item_id = p.catalog_item_id
         WHERE p.user_id = $1
         GROUP BY p.user_id, p.catalog_item_id, p.mode, p.install_scope, p.target_version_id`,
        [owner.userId],
      );
      const policies = row.team_id
        ? await db.query<{
            catalog_item_id: string;
            target_version_id: string;
            rollout_id: string;
            rollout_seed: string;
            rollout_percent: number;
          }>(
            `SELECT p.catalog_item_id, p.target_version_id, p.rollout_seed::text AS rollout_id,
                    p.rollout_seed::text, p.rollout_percent
             FROM team_tool_policies p
             JOIN tool_catalog_items c
               ON c.id::text = p.catalog_item_id
              AND c.lifecycle_status IN ('published', 'deprecated')
             WHERE p.team_id = $1 AND p.enabled = true
               AND rollout_phase IN ('canary', 'expand', 'active', 'rollback')`,
            [row.team_id],
          )
        : { rows: [] };
      return {
        userId: owner.userId,
        deviceFingerprint: fingerprint,
        preferences: preferences.rows.map((preference) => ({
          catalogItemId: preference.catalog_item_id,
          mode: preference.mode,
          scope: preference.install_scope,
          versionId: preference.target_version_id,
          deviceFingerprints: preference.device_fingerprints,
        })),
        teamPolicies: policies.rows.map((policy) => ({
          catalogItemId: policy.catalog_item_id,
          versionId: policy.target_version_id,
          rolloutId: policy.rollout_id,
          rolloutSeed: policy.rollout_seed,
          rolloutPercent: policy.rollout_percent,
        })),
      };
    },

    async getManifestVersion(versionId) {
      const result = await db.query<{ manifest: ToolDeploymentManifestV1 | string }>(
        "SELECT manifest FROM tool_versions WHERE id = $1",
        [versionId],
      );
      const raw = result.rows[0]?.manifest;
      if (!raw) return null;
      const manifest = validateInstallManifest(typeof raw === "string" ? JSON.parse(raw) : raw);
      return manifest.payload.type === "skill" || manifest.payload.type === "mcp_stdio" ? manifest : null;
    },

    async deviceBelongsToToken(owner, fingerprint) {
      if (!FINGERPRINT.test(fingerprint)) return false;
      const result = await db.query<{ exists: boolean }>(
        `SELECT EXISTS(
           SELECT 1 FROM device_tool_inventory_snapshots
           WHERE user_id = $1 AND ingest_token_id = $2 AND fingerprint = $3
         ) AS exists`,
        [owner.userId, owner.tokenId, fingerprint],
      );
      return result.rows[0]?.exists === true;
    },

    async permissionDiffFromLastKnownGood(teamId, catalogItemId, versionId) {
      const result = await db.query<{
        next_manifest: ToolDeploymentManifestV1 | string;
        previous_manifest: ToolDeploymentManifestV1 | string | null;
      }>(
        `SELECT next.manifest AS next_manifest, previous.manifest AS previous_manifest
         FROM tool_versions next
         LEFT JOIN team_tool_policies policy
           ON policy.team_id = $1 AND policy.catalog_item_id = $2
         LEFT JOIN tool_versions previous ON previous.id = policy.last_known_good_version_id
         WHERE next.id = $3 AND next.catalog_item_id = $2`,
        [teamId, catalogItemId, versionId],
      );
      const row = result.rows[0];
      if (!row) throw new Error("tool version not found");
      if (!row.previous_manifest) return { approvalRequired: false };
      const previous = validateInstallManifest(
        typeof row.previous_manifest === "string" ? JSON.parse(row.previous_manifest) : row.previous_manifest,
      );
      const next = validateInstallManifest(
        typeof row.next_manifest === "string" ? JSON.parse(row.next_manifest) : row.next_manifest,
      );
      return { approvalRequired: diffToolPermissions(previous, next).approvalRequired };
    },

    async saveTeamPolicy(input) {
      await inTransaction(db, async (client) => {
        await client.query(
          `INSERT INTO team_tool_policies
             (team_id, catalog_item_id, target_version_id, tracking_mode,
              rollout_phase, rollout_percent, enabled, created_by, updated_by)
           VALUES ($1, $2, $3, 'auto', $4, $5, true, $6, $6)
           ON CONFLICT (team_id, catalog_item_id) DO UPDATE SET
             target_version_id = EXCLUDED.target_version_id,
             rollout_phase = EXCLUDED.rollout_phase,
             rollout_percent = EXCLUDED.rollout_percent,
             rollout_seed = gen_random_uuid(),
             phase_started_at = now(),
             enabled = true,
             updated_by = EXCLUDED.updated_by,
             updated_at = now()`,
          [
            input.teamId,
            input.catalogItemId,
            input.versionId,
            input.rolloutPhase,
            input.rolloutPercent,
            input.actorUserId,
          ],
        );
        await client.query(
          `INSERT INTO tool_deployment_audit
             (actor_user_id, action, team_id, catalog_item_id, after_value)
           VALUES ($1, 'team_policy_changed', $2, $3, $4::jsonb)`,
          [
            input.actorUserId,
            input.teamId,
            input.catalogItemId,
            JSON.stringify({
              versionId: input.versionId,
              rolloutPhase: input.rolloutPhase,
              rolloutPercent: input.rolloutPercent,
            }),
          ],
        );
      });
    },

    async savePersonalPreference(input) {
      validatePersonalPreference(input);
      await inTransaction(db, async (client) => {
        const scope = input.mode === "exclude" ? "all_devices" : input.scope;
        await client.query(
          `INSERT INTO user_tool_preferences
             (user_id, catalog_item_id, mode, install_scope, target_version_id, tracking_mode)
           VALUES ($1, $2, $3, $4, $5, 'auto')
           ON CONFLICT (user_id, catalog_item_id) DO UPDATE SET
             mode = EXCLUDED.mode,
             install_scope = EXCLUDED.install_scope,
             target_version_id = EXCLUDED.target_version_id,
             updated_at = now()`,
          [input.actorUserId, input.catalogItemId, input.mode, scope, input.versionId],
        );
        await client.query(
          "DELETE FROM user_tool_preference_devices WHERE user_id = $1 AND catalog_item_id = $2",
          [input.actorUserId, input.catalogItemId],
        );
        if (input.mode === "install" && scope === "selected_devices") {
          for (const fingerprint of [...new Set(input.deviceFingerprints)].sort()) {
            await client.query(
              `INSERT INTO user_tool_preference_devices
                 (user_id, catalog_item_id, device_fingerprint)
               VALUES ($1, $2, $3)`,
              [input.actorUserId, input.catalogItemId, fingerprint],
            );
          }
        }
        await client.query(
          `INSERT INTO tool_deployment_audit
             (actor_user_id, action, catalog_item_id, after_value)
           VALUES ($1, 'personal_preference_changed', $2, $3::jsonb)`,
          [
            input.actorUserId,
            input.catalogItemId,
            JSON.stringify({
              mode: input.mode,
              scope,
              versionId: input.versionId,
              deviceFingerprints:
                input.mode === "install" && scope === "selected_devices"
                  ? [...new Set(input.deviceFingerprints)].sort()
                  : [],
            }),
          ],
        );
      });
    },

    async saveDeploymentReport(owner, report) {
      validateReport(report);
      await db.query(
        `INSERT INTO tool_deployment_reports
           (user_id, ingest_token_id, device_fingerprint, catalog_item_id,
            desired_version_id, applied_version_id, status, error_code,
            attempt, rollout_id, first_attempted_at, last_attempted_at,
            applied_at, rolled_back_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                 now(), now(),
                 CASE WHEN $7 = 'installed' THEN now() ELSE NULL END,
                 CASE WHEN $7 = 'rolled_back' THEN now() ELSE NULL END)
         ON CONFLICT (ingest_token_id, device_fingerprint, catalog_item_id)
         DO UPDATE SET
           desired_version_id = EXCLUDED.desired_version_id,
           applied_version_id = EXCLUDED.applied_version_id,
           status = EXCLUDED.status,
           error_code = EXCLUDED.error_code,
           attempt = EXCLUDED.attempt,
           rollout_id = EXCLUDED.rollout_id,
           last_attempted_at = now(),
           applied_at = CASE WHEN EXCLUDED.status = 'installed' THEN now() ELSE tool_deployment_reports.applied_at END,
           rolled_back_at = CASE WHEN EXCLUDED.status = 'rolled_back' THEN now() ELSE tool_deployment_reports.rolled_back_at END`,
        [
          owner.userId,
          owner.tokenId,
          report.deviceFingerprint,
          report.catalogItemId,
          report.desiredVersionId,
          report.appliedVersionId,
          report.status,
          report.errorCode,
          report.attempt,
          report.rolloutId,
        ],
      );
    },
  };
}

export function getToolDeploymentRepository(): ToolDeploymentRepository {
  return createToolDeploymentRepository(getPool() as unknown as ToolDeploymentDb);
}
