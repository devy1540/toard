import { authenticateIngestToken } from "@/lib/ingest-auth";
import { getToolDeploymentRepository } from "@/lib/tool-deployment-repository";
import { buildDeviceManifest } from "@/lib/tool-deployment-service";
import type { ToolDeploymentApiDependencies } from "@/lib/tool-deployment-api";

export function toolDeploymentApiDependencies(): ToolDeploymentApiDependencies {
  const repository = getToolDeploymentRepository();
  return {
    authenticate: authenticateIngestToken,
    buildManifest: (owner, input) => buildDeviceManifest(owner, input, repository),
    deviceBelongsToToken: (owner, fingerprint) => repository.deviceBelongsToToken(owner, fingerprint),
    saveReport: (owner, report) => repository.saveDeploymentReport(owner, report),
  };
}
