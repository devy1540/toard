import { postDeploymentReportResponse } from "@/lib/tool-deployment-api";
import { toolDeploymentApiDependencies } from "../dependencies";

export async function POST(request: Request): Promise<Response> {
  return postDeploymentReportResponse(request, toolDeploymentApiDependencies());
}
