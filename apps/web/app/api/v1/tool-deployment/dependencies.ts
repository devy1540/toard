import { authenticateIngestToken } from "@/lib/ingest-auth";
import { getToolDeploymentRepository } from "@/lib/tool-deployment-repository";
import { buildDeviceManifest } from "@/lib/tool-deployment-service";
import type { ToolDeploymentApiDependencies } from "@/lib/tool-deployment-api";

export function toolDeploymentApiDependencies(): ToolDeploymentApiDependencies {
  const repository = getToolDeploymentRepository();
  const build = (owner: Parameters<typeof buildDeviceManifest>[0], input: Parameters<typeof buildDeviceManifest>[1]) =>
    buildDeviceManifest(owner, input, repository);
  return {
    authenticate: authenticateIngestToken,
    buildManifest: build,
    deviceBelongsToToken: (owner, fingerprint) => repository.deviceBelongsToToken(owner, fingerprint),
    reportMatchesDesiredState: async (owner, report) => {
      const manifest = await build(owner, { fingerprint: report.deviceFingerprint, protocol: 1 });
      return manifest.items.some(
        (item) =>
          item.catalogItemId === report.catalogItemId &&
          item.versionId === report.desiredVersionId &&
          item.rolloutId === report.rolloutId,
      );
    },
    saveReport: (owner, report) => repository.saveDeploymentReport(owner, report),
  };
}
