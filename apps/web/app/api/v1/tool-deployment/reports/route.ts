import { postDeploymentReportResponse } from "@/lib/tool-deployment-api";
import { toolDeploymentExperimentalEnabled, toolDeploymentUnavailableResponse } from "@/lib/tool-deployment-feature";
import { toolDeploymentApiDependencies } from "../dependencies";

export async function POST(request: Request): Promise<Response> {
  if (!toolDeploymentExperimentalEnabled()) return toolDeploymentUnavailableResponse();
  return postDeploymentReportResponse(request, toolDeploymentApiDependencies());
}
