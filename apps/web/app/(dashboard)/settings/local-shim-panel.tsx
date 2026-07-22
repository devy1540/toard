"use client";

import { Laptop, RefreshCw } from "lucide-react";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  connectLocalShim,
  connectLocalShimFromBrowser,
  runLocalShimAction,
  type LocalShimAction,
  type LocalShimSession,
} from "@/lib/local-shim-client";
import { formatVersion, isShimOutdated } from "@toard/core";

type ConnectionState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "unavailable" }
  | { kind: "connected"; session: LocalShimSession };

export function LocalShimPanel({
  serverVersion,
  targetId,
}: {
  serverVersion: string;
  targetId: string;
}) {
  const t = useTranslations("settings.install.localControl");
  const [connection, setConnection] = useState<ConnectionState>({ kind: "idle" });
  const [running, setRunning] = useState<LocalShimAction | null>(null);

  const connect = async () => {
    setConnection({ kind: "checking" });
    try {
      const session = await connectLocalShimFromBrowser(targetId);
      setConnection({ kind: "connected", session });
    } catch {
      setConnection({ kind: "unavailable" });
    }
  };

  const run = async (action: LocalShimAction) => {
    setRunning(action);
    try {
      if (connection.kind !== "connected") throw new Error("local shim is not connected");
      const currentSession = connection.session;
      const refreshedStatus = await runLocalShimAction(currentSession, action);
      toast.success(t(`success.${action}`));
      if (refreshedStatus) {
        setConnection({
          kind: "connected",
          session: { ...currentSession, status: refreshedStatus },
        });
      } else if (action === "collect") {
        setConnection({ kind: "connected", session: await connectLocalShim(targetId) });
      } else if (action === "update") {
        setConnection({ kind: "checking" });
        setConnection({ kind: "connected", session: await reconnectAfterUpdate(targetId) });
      }
    } catch {
      if (action === "update") setConnection({ kind: "unavailable" });
      toast.error(t(`failure.${action}`));
    } finally {
      setRunning(null);
    }
  };

  const status = connection.kind === "connected" ? connection.session.status : null;
  const outdated = status ? isShimOutdated(status.version, serverVersion) : false;

  return (
    <Card className="min-w-0">
      <CardHeader className="gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <CardTitle className="flex min-w-0 flex-1 flex-wrap items-center gap-2 leading-snug">
            <Laptop className="size-4" aria-hidden="true" />
            {t("title")}
          </CardTitle>
          {status ? <Badge variant="secondary">{t("connected")}</Badge> : null}
        </div>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent aria-live="polite">
        {connection.kind === "idle" ? (
          <Button type="button" onClick={() => void connect()}>
            {t("connect")}
          </Button>
        ) : null}

        {connection.kind === "checking" ? (
          <Button type="button" disabled>
            <RefreshCw className="size-4 animate-spin" aria-hidden="true" />
            {t("checking")}
          </Button>
        ) : null}

        {connection.kind === "unavailable" ? (
          <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-medium">{t("unavailable")}</p>
              <p className="text-muted-foreground mt-1 text-xs">
                {t("fallback")}
              </p>
            </div>
            <Button type="button" variant="outline" onClick={() => void connect()}>
              {t("retry")}
            </Button>
          </div>
        ) : null}

        {status && connection.kind === "connected" ? (
          <div className="space-y-4">
            <div className="grid gap-3 text-sm sm:grid-cols-3">
              <StatusItem label={t("computer")} value={status.host ?? t("unknownComputer")} />
              <StatusItem
                label={t("version")}
                value={`${formatVersion(status.version)}${outdated ? ` · ${t("updateNeeded")}` : ""}`}
              />
              <StatusItem
                label={t("periodicCollection")}
                value={status.daemon.active ? t("active") : t("inactive")}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              {(["collect", "doctor", "update"] as const).map((action) => (
                <Button
                  key={action}
                  type="button"
                  variant={action === "collect" ? "default" : "outline"}
                  disabled={running !== null || !status.capabilities.includes(action)}
                  onClick={() => void run(action)}
                >
                  {running === action ? t(`running.${action}`) : t(`action.${action}`)}
                </Button>
              ))}
            </div>
            <p className="text-muted-foreground text-xs">{t("security")}</p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

async function reconnectAfterUpdate(targetId: string): Promise<LocalShimSession> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    try {
      return await connectLocalShim(targetId);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("local shim did not restart");
}

function StatusItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-muted/40 min-w-0 rounded-lg p-3">
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className="mt-1 break-words font-medium [overflow-wrap:anywhere]">{value}</p>
    </div>
  );
}
