"use client";

import { Activity, Stethoscope } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
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

const DOCTOR_RESULT_CODES = [
  "scheduler_inactive",
  "collection_stale",
  "token_invalid",
  "endpoint_not_found",
  "endpoint_unreachable",
  "endpoint_unhealthy",
  "target_unavailable",
  "path_misconfigured",
  "doctor_failed",
] as const;
type DoctorResultCode = (typeof DOCTOR_RESULT_CODES)[number];

function isDoctorResultCode(value: string): value is DoctorResultCode {
  return (DOCTOR_RESULT_CODES as readonly string[]).includes(value);
}

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
  syncStale: boolean;
  command: {
    type: DeviceControlCommandType;
    status: DeviceControlCommandStatus;
    resultCode: string | null;
  } | null;
};

export function DeviceActions({
  control,
  contentEnabled,
  pollWhenMissing = false,
}: {
  control: DeviceControlClientView | null;
  contentEnabled: boolean;
  pollWhenMissing?: boolean;
}) {
  const t = useTranslations("settings");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const applying =
    control?.desiredGeneration !== null &&
    control?.desiredGeneration !== control?.appliedGeneration;
  const commandActive =
    control?.command?.status === "pending" || control?.command?.status === "claimed";
  const doctorResultCode =
    control?.command?.type === "doctor" &&
    control.command.resultCode &&
    isDoctorResultCode(control.command.resultCode)
      ? control.command.resultCode
      : null;
  const needsRefresh =
    (!control?.lastSyncAt && pollWhenMissing) || applying || commandActive;

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
      <Field orientation="horizontal" className="w-auto items-center gap-2">
        <FieldLabel htmlFor={`device-history-${control.deviceFingerprint}`} className="font-normal">
          {t("install.deviceControl.history")}
        </FieldLabel>
        <Switch
          id={`device-history-${control.deviceFingerprint}`}
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
      </Field>
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
      {commandActive ? (
        <span className="text-muted-foreground text-xs">
          {t(`install.deviceControl.running.${control.command?.type ?? "collect"}`)}
        </span>
      ) : control.command?.status === "expired" ? (
        <span className="text-amber-600 text-xs dark:text-amber-500">
          {t("install.deviceControl.expired")}
        </span>
      ) : control.command?.status === "failed" ? (
        <span className="text-destructive text-xs">
          {doctorResultCode
            ? t(`install.deviceControl.diagnostic.${doctorResultCode}`)
            : t(`install.deviceControl.completed.${control.command.type}.failed`)}
        </span>
      ) : control.command?.status === "succeeded" ? (
        <span
          className={
            doctorResultCode
              ? "text-amber-600 text-xs dark:text-amber-500"
              : "text-muted-foreground text-xs"
          }
        >
          {doctorResultCode
            ? t(`install.deviceControl.diagnostic.${doctorResultCode}`)
            : t(`install.deviceControl.completed.${control.command.type}.succeeded`)}
        </span>
      ) : control.daemonActive === false ? (
        <span className="text-amber-600 text-xs dark:text-amber-500">
          {t("install.deviceControl.periodicInactive")}
        </span>
      ) : control.syncStale ? (
        <span className="text-amber-600 text-xs dark:text-amber-500">
          {t("install.deviceControl.syncStale")}
        </span>
      ) : !contentEnabled ? (
        <span className="text-muted-foreground text-xs">
          {t("install.deviceControl.serverDisabled")}
        </span>
      ) : control.lastSyncLabel ? (
        <span className="text-muted-foreground text-xs">
          {t("install.deviceControl.lastSync", { time: control.lastSyncLabel })}
        </span>
      ) : null}
    </div>
  );
}
