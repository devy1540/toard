import type { ToolDeploymentStatus } from "@toard/core";
import type { IngestAuthResult } from "./ingest-auth";
import { getPool } from "./db";

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

export type ToolDeploymentRepository = {
  savePersonalPreference(input: PersonalPreferenceInput): Promise<void>;
  saveDeploymentReport(owner: IngestAuthResult, report: DeploymentReportInput): Promise<void>;
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
