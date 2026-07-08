"use client";

import { useEffect, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { formatVersion } from "@toard/core";
import { Button } from "@/components/ui/button";
import type { ServerUpdatePhase, ServerUpdateStatus } from "@/lib/server-update";

const POLL_MS = 2_000;

export function ServerUpdatePanel({
  currentVersion,
  initialStatus,
}: {
  currentVersion: string;
  initialStatus: ServerUpdateStatus;
}) {
  const t = useTranslations("admin");
  const [status, setStatus] = useState(initialStatus);
  const [pending, startTransition] = useTransition();

  const phaseLabel = (phase: ServerUpdatePhase): string => {
    switch (phase) {
      case "latest":
        return t("system.updatePhaseLatest");
      case "preflight":
        return t("system.updatePhasePreflight");
      case "pulling":
        return t("system.updatePhasePulling");
      case "migrating":
        return t("system.updatePhaseMigrating");
      case "restarting":
        return t("system.updatePhaseRestarting");
      case "verifying":
        return t("system.updatePhaseVerifying");
      case "completed":
        return t("system.updatePhaseCompleted");
      case "failed":
        return t("system.updatePhaseFailed");
      default:
        return t("system.updatePhaseIdle");
    }
  };

  const refresh = async () => {
    const res = await fetch("/api/admin/update/status", { cache: "no-store" });
    if (res.ok) setStatus((await res.json()) as ServerUpdateStatus);
  };

  useEffect(() => {
    if (!status.running) return;
    const id = window.setInterval(() => {
      void refresh();
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [status.running]);

  const start = () => {
    startTransition(async () => {
      const res = await fetch("/api/admin/update/start", { method: "POST" });
      const body = (await res.json()) as ServerUpdateStatus | { error?: string };
      if ("phase" in body) {
        setStatus(body);
      } else {
        setStatus((prev) => ({
          ...prev,
          phase: "failed",
          message: "start failed",
          error: body.error ?? `HTTP ${res.status}`,
        }));
      }
    });
  };

  if (!status.available) {
    return (
      <div className="space-y-1 text-sm">
        <p className="text-muted-foreground">{t("system.updateUnavailable")}</p>
        <p className="text-muted-foreground text-xs">{t("system.updateUnavailableHint")}</p>
        {status.error ? <p className="text-destructive text-xs">{status.error}</p> : null}
      </div>
    );
  }

  const latest = status.latestVersion ? formatVersion(status.latestVersion) : null;
  const lastLogs = status.logs.slice(-5);

  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <p>
            <span className="text-muted-foreground">{t("system.updateCurrent")}</span>{" "}
            <span className="font-mono">{formatVersion(status.currentVersion ?? currentVersion)}</span>
            {latest ? (
              <>
                {" "}
                <span className="text-muted-foreground">· {t("system.updateLatest", { version: latest })}</span>
              </>
            ) : null}
          </p>
          <p className={status.phase === "failed" ? "text-destructive" : "text-muted-foreground"}>
            {phaseLabel(status.phase)} {status.message ? `· ${status.message}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => void refresh()} disabled={pending}>
            {t("system.updateRefresh")}
          </Button>
          <Button type="button" size="sm" onClick={start} disabled={pending || status.running}>
            {status.running || pending ? t("system.updateRunning") : t("system.updateStart")}
          </Button>
        </div>
      </div>

      {status.error ? <p className="text-destructive text-xs">{status.error}</p> : null}
      {lastLogs.length > 0 ? (
        <pre className="bg-muted max-h-32 overflow-auto rounded-md p-3 text-xs whitespace-pre-wrap">
          {lastLogs.join("\n")}
        </pre>
      ) : null}
    </div>
  );
}
