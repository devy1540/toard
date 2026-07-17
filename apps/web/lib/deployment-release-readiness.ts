import { parseDeploymentReleaseEnvironment } from "@toard/core";

type ReleaseReadinessDb = {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>> }>;
};

/**
 * Compose/non-Helm installs remain unchanged only when all release env is absent.
 * Any configured Helm release must have its exact post-seed completion row.
 */
export async function assertDeploymentReleaseReady(
  db: ReleaseReadinessDb,
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const release = parseDeploymentReleaseEnvironment(env);
  if (!release) return;
  const result = await db.query(
    `SELECT 1 AS ok
       FROM deployment_release_completions
      WHERE deployment_id = $1
        AND release_revision = $2
        AND release_token = $3
        AND expected_schema_version = $4
      LIMIT 1`,
    [
      release.deploymentId,
      release.releaseRevision,
      release.releaseToken,
      release.expectedSchemaVersion,
    ],
  );
  if (result.rows.length !== 1) {
    throw new Error("DEPLOYMENT_RELEASE_NOT_COMPLETE");
  }
}
