import { getDeviceManifestResponse } from "@/lib/tool-deployment-api";
import { toolDeploymentApiDependencies } from "../dependencies";

export async function GET(request: Request): Promise<Response> {
  return getDeviceManifestResponse(request, toolDeploymentApiDependencies());
}
