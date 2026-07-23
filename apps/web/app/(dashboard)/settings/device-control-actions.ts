"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { contentCollectionEnabled } from "@/lib/content-crypto";
import {
  getDeviceControlRepository,
  type DeviceControlCommandType,
  type DeviceControlMutableContentMode,
} from "@/lib/device-control-repository";

export type DeviceControlActionResult =
  | { ok: true }
  | { ok: false; error: "login_required" | "device_not_owned" | "invalid_request" | "failed" };

const FINGERPRINT = /^[a-f0-9]{64}$/;

function validTarget(tokenId: string, deviceFingerprint: string): boolean {
  return tokenId.length > 0 && tokenId.length <= 128 && FINGERPRINT.test(deviceFingerprint);
}

export async function setDeviceHistoryAction(input: {
  tokenId: string;
  deviceFingerprint: string;
  contentMode: DeviceControlMutableContentMode;
}): Promise<DeviceControlActionResult> {
  const userId = (await auth())?.user?.id;
  if (!userId) return { ok: false, error: "login_required" };
  if (
    !validTarget(input.tokenId, input.deviceFingerprint) ||
    !["off", "server_v1"].includes(input.contentMode) ||
    (input.contentMode === "server_v1" && !contentCollectionEnabled())
  ) {
    return { ok: false, error: "invalid_request" };
  }
  try {
    const updated = await getDeviceControlRepository().setDesiredContentMode({
      actorUserId: userId,
      tokenId: input.tokenId,
      deviceFingerprint: input.deviceFingerprint,
      contentMode: input.contentMode,
    });
    if (!updated) return { ok: false, error: "device_not_owned" };
    revalidatePath("/settings");
    return { ok: true };
  } catch {
    return { ok: false, error: "failed" };
  }
}

export async function enqueueDeviceCommandAction(input: {
  tokenId: string;
  deviceFingerprint: string;
  commandType: DeviceControlCommandType;
}): Promise<DeviceControlActionResult> {
  const userId = (await auth())?.user?.id;
  if (!userId) return { ok: false, error: "login_required" };
  if (
    !validTarget(input.tokenId, input.deviceFingerprint) ||
    !["collect", "doctor"].includes(input.commandType)
  ) {
    return { ok: false, error: "invalid_request" };
  }
  try {
    const commandId = await getDeviceControlRepository().enqueueCommand({
      actorUserId: userId,
      tokenId: input.tokenId,
      deviceFingerprint: input.deviceFingerprint,
      commandType: input.commandType,
    });
    if (!commandId) return { ok: false, error: "device_not_owned" };
    revalidatePath("/settings");
    return { ok: true };
  } catch {
    return { ok: false, error: "failed" };
  }
}
