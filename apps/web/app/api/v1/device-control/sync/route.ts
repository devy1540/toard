import { postDeviceControlSyncResponse } from "@/lib/device-control-api";
import { deviceControlApiDependencies } from "../dependencies";

export async function POST(request: Request): Promise<Response> {
  return postDeviceControlSyncResponse(request, deviceControlApiDependencies());
}
