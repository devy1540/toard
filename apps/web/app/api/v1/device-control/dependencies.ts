import type { DeviceControlApiDependencies } from "@/lib/device-control-api";
import { getDeviceControlRepository } from "@/lib/device-control-repository";
import { authenticateIngestToken } from "@/lib/ingest-auth";

export function deviceControlApiDependencies(): DeviceControlApiDependencies {
  const repository = getDeviceControlRepository();
  return {
    authenticate: authenticateIngestToken,
    sync: (owner, observation) => repository.sync(owner, observation),
  };
}
