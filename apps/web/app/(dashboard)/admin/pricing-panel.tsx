"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { Surface } from "@/components/ui/surface";
import type { PricingAdminStatus } from "@/lib/pricing-admin-status";

/** 가격 sync와 자동 복구의 읽기 전용 상태. 관리자가 실행하거나 켜고 끌 작업은 없다. */
export function PricingSyncPanel({
  initialStatus,
  builtinScheduler,
}: {
  initialStatus: PricingAdminStatus;
  builtinScheduler: boolean;
}) {
  const t = useTranslations("admin");
  const locale = useLocale();
  const [status, setStatus] = useState(initialStatus);
  const [requestFailed, setRequestFailed] = useState(false);
  const formatCount = (value: number) => new Intl.NumberFormat(locale).format(value);
  const formatDateTime = (value: string) => new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const response = await fetch("/api/admin/pricing/status", { cache: "no-store" });
        if (!response.ok) throw new Error(`pricing status ${response.status}`);
        const next = await response.json() as PricingAdminStatus;
        if (active) {
          setStatus(next);
          setRequestFailed(false);
        }
      } catch {
        if (active) setRequestFailed(true);
      }
    };
    const timer = setInterval(() => void refresh(), 30_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  const healthy = status.repair.state === "idle"
    && status.repair.remainingUnpricedEvents === 0
    && status.repair.remainingLegacyEvents === 0
    && status.repair.lastSucceededAt != null;
  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">
          {status.models > 0
            ? t("system.modelsCount", { count: formatCount(status.models) })
            : t("system.noPricing")}
        </span>
        <span className="text-muted-foreground">
          {t("system.lastSync", { day: status.lastDay ?? "—" })}
        </span>
        <Badge variant={builtinScheduler ? "secondary" : "outline"}>
          {builtinScheduler ? t("system.autoSyncActive") : t("system.autoSyncUnavailable")}
        </Badge>
      </div>

      <Surface radius="sm" padding="md">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span>{t("system.repairTitle")}</span>
          <Badge variant={status.repair.state === "failed" ? "destructive" : healthy ? "secondary" : "outline"}>
            {t(`system.repairStates.${status.repair.state}`)}
          </Badge>
        </div>
        <dl className="mt-2 grid gap-1 text-xs sm:grid-cols-3">
          <div><dt className="text-muted-foreground inline">{t("system.recoveredEvents")}: </dt><dd className="inline">{formatCount(status.repair.recoveredEvents)}</dd></div>
          <div><dt className="text-muted-foreground inline">{t("system.repricedLegacyEvents")}: </dt><dd className="inline">{formatCount(status.repair.repricedLegacyEvents)}</dd></div>
          <div><dt className="text-muted-foreground inline">{t("system.reconciledEvents")}: </dt><dd className="inline">{formatCount(status.repair.reconciledEvents)}</dd></div>
          <div><dt className="text-muted-foreground inline">{t("system.remainingEvents")}: </dt><dd className="inline">{formatCount(status.repair.remainingUnpricedEvents)}</dd></div>
          <div><dt className="text-muted-foreground inline">{t("system.remainingLegacyEvents")}: </dt><dd className="inline">{formatCount(status.repair.remainingLegacyEvents)}</dd></div>
          <div><dt className="text-muted-foreground inline">{t("system.lastRepair")}: </dt><dd className="inline">{status.repair.lastSucceededAt ? formatDateTime(status.repair.lastSucceededAt) : "—"}</dd></div>
        </dl>
        {status.unresolvedModels.length > 0 ? (
          <div className="mt-3 space-y-1 text-xs">
            <p className="text-muted-foreground">{t("system.unresolvedModels")}</p>
            {status.unresolvedModels.slice(0, 10).map((item) => (
              <p key={`${item.model ?? "unknown"}:${item.firstAt}`}>
                <span className="font-mono">{item.model ?? "(unknown)"}</span>
                {" · "}{t("system.unresolvedEvents", { count: formatCount(item.events) })}
                {" · "}{t("system.unresolvedEventBreakdown", {
                  unpriced: formatCount(item.unpricedEvents),
                  legacy: formatCount(item.legacyEvents),
                })}
              </p>
            ))}
          </div>
        ) : null}
        {status.history.state !== "idle" && status.history.state !== "completed" ? (
          <Surface radius="sm" padding="sm" className="mt-3 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>{t("system.historyTitle")}</span>
              <Badge variant={status.history.state === "failed" ? "destructive" : "outline"}>
                {t(`system.historyStates.${status.history.state}`)}
              </Badge>
            </div>
            <p className="mt-1 text-muted-foreground">
              {t("system.historyProgress", {
                processed: formatCount(status.history.processedSnapshots),
                total: formatCount(status.history.totalSnapshots),
                models: formatCount(status.history.models),
              })}
            </p>
            {status.history.nextAttemptAt ? (
              <p className="mt-1 text-muted-foreground">
                {t("system.historyRetryAt", {
                  time: formatDateTime(status.history.nextAttemptAt),
                })}
              </p>
            ) : null}
          </Surface>
        ) : null}
      </Surface>
      {requestFailed ? <p className="text-destructive text-xs">{t("system.pricingStatusFailed")}</p> : null}
    </div>
  );
}
