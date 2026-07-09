"use client";

import { MoreHorizontal } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type DeviceAction = "collect" | "doctor" | "update";

const COMMANDS: Record<DeviceAction, string> = {
  collect: "toard-shim collect",
  doctor: "toard-shim doctor",
  update: "toard-shim update",
};

export function DeviceActions({ primary }: { primary: DeviceAction }) {
  const t = useTranslations("settings");

  const copy = async (action: DeviceAction) => {
    try {
      await navigator.clipboard.writeText(COMMANDS[action]);
      toast.success(t("install.deviceCommandCopied"));
    } catch {
      toast.error(t("errors.copyCommandFailed"));
    }
  };

  return (
    <div className="flex items-center justify-end gap-2">
      <Button type="button" size="sm" onClick={() => copy(primary)}>
        {t(`install.deviceAction.${primary}`)}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" size="sm" aria-label={t("install.deviceAction.more")}>
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {(["collect", "doctor", "update"] as const)
            .filter((action) => action !== primary)
            .map((action) => (
              <DropdownMenuItem key={action} onSelect={() => copy(action)}>
                {t(`install.deviceAction.${action}`)}
              </DropdownMenuItem>
            ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
