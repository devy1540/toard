"use client";

import { Activity, Stethoscope } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import type {
  DeviceControlCommandStatus,
  DeviceControlCommandType,
  DeviceControlContentMode,
} from "@/lib/device-control-repository";
import {
  enqueueDeviceCommandAction,
  setDeviceHistoryAction,
} from "./device-control-actions";

export type DeviceControlClientView = {
  tokenId: string;
  deviceFingerprint: string;
  desiredGeneration: number | null;
  desiredContentMode: DeviceControlContentMode | null;
  appliedGeneration: number | null;
  appliedContentMode: DeviceControlContentMode | null;
  daemonActive: boolean | null;
  lastSyncAt: string | null;
  lastSyncLabel: string | null;
  errorCode: string | null;
  command: {
    type: DeviceControlCommandType;
    status: DeviceControlCommandStatus;
    resultCode: string | null;
  } | null;
};

export function DeviceActions({
  control,
  contentEnabled,
}: {
  control: DeviceControlClientView | null;
  contentEnabled: boolean;
}) {
  const t = useTranslations("settings");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const applying =
    control?.desiredGeneration !== null &&
    control?.desiredGeneration !== control?.appliedGeneration;
  const commandActive =
    control?.command?.status === "pending" || control?.command?.status === "claimed";
  const needsRefresh = !control?.lastSyncAt || applying || commandActive;

  useEffect(() => {
    if (!needsRefresh) return;
    const timer = window.setInterval(() => router.refresh(), 5_000);
    return () => window.clearInterval(timer);
  }, [needsRefresh, router]);

  if (!control?.lastSyncAt) {
    return (
      <div className="flex justify-end">
        <Badge variant="outline">{t("install.deviceControl.waiting")}</Badge>
      </div>
    );
  }

  const desiredOn =
    control.desiredContentMode === "server_v1" ||
    control.desiredContentMode === "e2ee_v1";
  const appliedOn = control.appliedContentMode === "server_v1";
  const legacy = !applying && control.appliedContentMode === "e2ee_v1";

  const setHistory = (enabled: boolean) => {
    startTransition(async () => {
      const result = await setDeviceHistoryAction({
        tokenId: control.tokenId,
        deviceFingerprint: control.deviceFingerprint,
        contentMode: enabled ? "server_v1" : "off",
      });
      if (!result.ok) {
        toast.error(t("install.deviceControl.failed"));
        return;
      }
      toast.success(t("install.deviceControl.saved"));
      router.refresh();
    });
  };

  const run = (commandType: DeviceControlCommandType) => {
    startTransition(async () => {
      const result = await enqueueDeviceCommandAction({
        tokenId: control.tokenId,
        deviceFingerprint: control.deviceFingerprint,
        commandType,
      });
      if (!result.ok) {
        toast.error(t("install.deviceControl.failed"));
        return;
      }
      toast.success(t(`install.deviceControl.queued.${commandType}`));
      router.refresh();
    });
  };

  return (
    <div className="flex min-w-[18rem] flex-col items-end gap-2">
      <label className="flex items-center gap-2 text-sm">
        <span>{t("install.deviceControl.history")}</span>
        <Switch
          checked={desiredOn}
          disabled={pending || !contentEnabled}
          onCheckedChange={setHistory}
          aria-label={t("install.deviceControl.history")}
        />
        <Badge variant={applying ? "outline" : appliedOn ? "secondary" : "outline"}>
          {applying
            ? t("install.deviceControl.applying")
            : legacy
              ? t("install.deviceControl.legacy")
              : appliedOn
                ? t("install.deviceControl.on")
                : t("install.deviceControl.off")}
        </Badge>
      </label>
      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending || commandActive}
          onClick={() => run("collect")}
        >
          <Activity className="size-4" />
          {t("install.deviceControl.collect")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending || commandActive}
          onClick={() => run("doctor")}
        >
          <Stethoscope className="size-4" />
          {t("install.deviceControl.doctor")}
        </Button>
      </div>
      {!contentEnabled ? (
        <span className="text-muted-foreground text-xs">
          {t("install.deviceControl.serverDisabled")}
        </span>
      ) : commandActive ? (
        <span className="text-muted-foreground text-xs">
          {t(`install.deviceControl.running.${control.command?.type ?? "collect"}`)}
        </span>
      ) : control.errorCode ? (
        <span className="text-destructive text-xs">{t("install.deviceControl.shimError")}</span>
      ) : control.command?.status === "failed" ? (
        <span className="text-destructive text-xs">
          {t(`install.deviceControl.completed.${control.command.type}.failed`)}
        </span>
      ) : control.command?.status === "succeeded" ? (
        <span className="text-muted-foreground text-xs">
          {t(`install.deviceControl.completed.${control.command.type}.succeeded`)}
        </span>
      ) : control.daemonActive === false ? (
        <span className="text-amber-600 text-xs dark:text-amber-500">
          {t("install.deviceControl.periodicInactive")}
        </span>
      ) : control.lastSyncLabel ? (
        <span className="text-muted-foreground text-xs">
          {t("install.deviceControl.lastSync", { time: control.lastSyncLabel })}
        </span>
      ) : null}
    </div>
  );
}
