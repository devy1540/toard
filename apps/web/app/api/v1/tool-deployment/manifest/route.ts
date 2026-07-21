import { getDeviceManifestResponse } from "@/lib/tool-deployment-api";
import { toolDeploymentExperimentalEnabled, toolDeploymentUnavailableResponse } from "@/lib/tool-deployment-feature";
import { toolDeploymentApiDependencies } from "../dependencies";

export async function GET(request: Request): Promise<Response> {
  if (!toolDeploymentExperimentalEnabled()) return toolDeploymentUnavailableResponse();
  return getDeviceManifestResponse(request, toolDeploymentApiDependencies());
}
