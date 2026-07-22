/** Repository migration prefix expected by a release-completion marker. */
export const LATEST_SCHEMA_VERSION = 1700000048 as const;

const RELEASE_ENV_KEYS = [
  "TOARD_DEPLOYMENT_ID",
  "TOARD_RELEASE_COMPLETION_ID",
  "TOARD_EXPECTED_SCHEMA_VERSION",
] as const;

export type DeploymentReleaseEnvironment = Readonly<
  Record<string, string | undefined>
>;

export type DeploymentReleaseIdentity = Readonly<{
  deploymentId: string;
  releaseCompletionId: string;
  expectedSchemaVersion: typeof LATEST_SCHEMA_VERSION;
}>;

const DEPLOYMENT_ID_PATTERN =
  /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?\/[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
const RELEASE_COMPLETION_ID_PATTERN = /^[0-9a-f]{64}$/;

function invalidEnvironment(): never {
  throw new Error("DEPLOYMENT_RELEASE_ENV_INVALID");
}

/**
 * Returns null only when the three Helm release variables are all absent.
 * Partial, empty, stale-schema, or non-canonical values fail closed.
 */
export function parseDeploymentReleaseEnvironment(
  env: DeploymentReleaseEnvironment,
): DeploymentReleaseIdentity | null {
  const values = RELEASE_ENV_KEYS.map((key) => env[key]);
  if (values.every((value) => value === undefined)) return null;
  if (values.some((value) => value === undefined)) invalidEnvironment();

  const [deploymentId, releaseCompletionId, schemaVersionText] =
    values as [string, string, string];
  if (!DEPLOYMENT_ID_PATTERN.test(deploymentId)) invalidEnvironment();
  if (!RELEASE_COMPLETION_ID_PATTERN.test(releaseCompletionId)) {
    invalidEnvironment();
  }
  if (schemaVersionText !== String(LATEST_SCHEMA_VERSION)) {
    invalidEnvironment();
  }

  return {
    deploymentId,
    releaseCompletionId,
    expectedSchemaVersion: LATEST_SCHEMA_VERSION,
  };
}
