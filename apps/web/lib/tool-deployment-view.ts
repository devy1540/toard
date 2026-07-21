import type { ToolDeploymentStatus, ToolRolloutPhase } from "@toard/core";
import { getPool } from "./db";

export type DeploymentDevice = {
  fingerprint: string;
  host: string | null;
  receivedAt: Date;
};

export type DeploymentReportView = {
  fingerprint: string;
  host: string | null;
  status: ToolDeploymentStatus;
  errorCode: string | null;
  updatedAt: Date | null;
};

export type ToolDeploymentView = {
  versionId: string | null;
  devices: DeploymentDevice[];
  selectedScope: "all_devices" | "selected_devices";
  selectedDevices: string[];
  inherited: boolean;
  excluded: boolean;
  reports: DeploymentReportView[];
  teamPolicy: null | {
    phase: ToolRolloutPhase;
    percent: number;
    targetVersionId: string;
    installed: number;
    failed: number;
    settingsRequired: number;
  };
};

export async function getToolDeploymentView(
  userId: string,
  teamId: string | null,
  catalogItemId: string,
): Promise<ToolDeploymentView> {
  const pool = getPool();
  const [version, devices, preference, preferenceDevices, reports, policy] = await Promise.all([
    pool.query<{ id: string }>(
      "SELECT id FROM tool_versions WHERE catalog_item_id = $1 ORDER BY created_at DESC LIMIT 1",
      [catalogItemId],
    ),
    pool.query<{ fingerprint: string; host: string | null; received_at: Date }>(
      `SELECT fingerprint, NULLIF(host, '') AS host, received_at
       FROM device_tool_inventory_snapshots
       WHERE user_id = $1 ORDER BY received_at DESC`,
      [userId],
    ),
    pool.query<{ mode: "install" | "exclude"; install_scope: "all_devices" | "selected_devices" }>(
      `SELECT mode, install_scope FROM user_tool_preferences
       WHERE user_id = $1 AND catalog_item_id = $2`,
      [userId, catalogItemId],
    ),
    pool.query<{ device_fingerprint: string }>(
      `SELECT device_fingerprint FROM user_tool_preference_devices
       WHERE user_id = $1 AND catalog_item_id = $2 ORDER BY device_fingerprint`,
      [userId, catalogItemId],
    ),
    pool.query<{
      device_fingerprint: string;
      host: string | null;
      status: ToolDeploymentStatus;
      error_code: string | null;
      last_attempted_at: Date | null;
    }>(
      `SELECT r.device_fingerprint, NULLIF(s.host, '') AS host, r.status, r.error_code, r.last_attempted_at
       FROM tool_deployment_reports r
       LEFT JOIN device_tool_inventory_snapshots s
         ON s.ingest_token_id = r.ingest_token_id AND s.fingerprint = r.device_fingerprint
       WHERE r.user_id = $1 AND r.catalog_item_id = $2
       ORDER BY r.last_attempted_at DESC NULLS LAST`,
      [userId, catalogItemId],
    ),
    teamId
      ? pool.query<{
          rollout_phase: ToolRolloutPhase;
          rollout_percent: number;
          target_version_id: string;
          installed: string;
          failed: string;
          settings_required: string;
        }>(
          `SELECT p.rollout_phase, p.rollout_percent, p.target_version_id,
                  COUNT(*) FILTER (WHERE r.status = 'installed') AS installed,
                  COUNT(*) FILTER (WHERE r.status IN ('failed', 'rolled_back')) AS failed,
                  COUNT(*) FILTER (WHERE r.status = 'settings_required') AS settings_required
           FROM team_tool_policies p
           LEFT JOIN tool_deployment_reports r ON r.rollout_id = p.id
           WHERE p.team_id = $1 AND p.catalog_item_id = $2 AND p.enabled = true
           GROUP BY p.id`,
          [teamId, catalogItemId],
        )
      : Promise.resolve({ rows: [] }),
  ]);
  const pref = preference.rows[0];
  const team = policy.rows[0];
  return {
    versionId: version.rows[0]?.id ?? null,
    devices: devices.rows.map((device) => ({
      fingerprint: device.fingerprint,
      host: device.host,
      receivedAt: new Date(device.received_at),
    })),
    selectedScope: pref?.install_scope ?? "all_devices",
    selectedDevices: preferenceDevices.rows.map((row) => row.device_fingerprint),
    inherited: Boolean(team) && pref?.mode !== "exclude",
    excluded: pref?.mode === "exclude",
    reports: reports.rows.map((report) => ({
      fingerprint: report.device_fingerprint,
      host: report.host,
      status: report.status,
      errorCode: report.error_code,
      updatedAt: report.last_attempted_at ? new Date(report.last_attempted_at) : null,
    })),
    teamPolicy: team
      ? {
          phase: team.rollout_phase,
          percent: team.rollout_percent,
          targetVersionId: team.target_version_id,
          installed: Number(team.installed),
          failed: Number(team.failed),
          settingsRequired: Number(team.settings_required),
        }
      : null,
  };
}
