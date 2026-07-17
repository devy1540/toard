import { pathToFileURL } from "node:url";
import { Client } from "pg";
import { parseDeploymentReleaseEnvironment } from "../packages/core/src/deployment-release";

type MarkerDb = {
  query(
    sql: string,
    params: readonly unknown[],
  ): Promise<{ rowCount: number | null }>;
};

const INSERT_COMPLETION_SQL = `
  INSERT INTO deployment_release_completions
    (deployment_id, release_completion_id, expected_schema_version)
  VALUES ($1, $2, $3)
  ON CONFLICT (deployment_id, release_completion_id) DO UPDATE
    SET completed_at = deployment_release_completions.completed_at
    WHERE deployment_release_completions.expected_schema_version = EXCLUDED.expected_schema_version
  RETURNING deployment_id
`;

/** Records only an exact, fully validated release identity using bound parameters. */
export async function insertDeploymentReleaseCompletion(
  db: MarkerDb,
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const release = parseDeploymentReleaseEnvironment(env);
  if (!release) throw new Error("DEPLOYMENT_RELEASE_ENV_INVALID");
  const result = await db.query(INSERT_COMPLETION_SQL, [
    release.deploymentId,
    release.releaseCompletionId,
    release.expectedSchemaVersion,
  ]);
  if (result.rowCount !== 1) {
    throw new Error("DEPLOYMENT_RELEASE_MARKER_CONFLICT");
  }
}

async function main(): Promise<void> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await insertDeploymentReleaseCompletion(client, process.env);
  } finally {
    await client.end();
  }
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;
if (isMain) {
  main().catch(() => {
    // completion ID, DATABASE_URL, SQL/driver detail은 어느 실패 경로에서도 출력하지 않는다.
    console.error("deployment release completion failed");
    process.exitCode = 1;
  });
}
