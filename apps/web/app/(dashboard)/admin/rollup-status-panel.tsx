"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { RollupStorageTable } from "@toard/storage-clickhouse";
import type {
  RollupAdminStatus,
  RollupWorkerStatusView,
} from "@/lib/rollup-status";
import type { RollupWorkerName } from "@/lib/rollup-worker-state";
import {
  createRollupStatusRequestGate,
  type RollupStatusRequestGate,
} from "./rollup-status-request-gate";

const POLL_MS = 10_000;

function formatDateTime(value: string | null, locale: string): string {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatNumber(value: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(value);
}

function formatBytes(value: number, locale: string): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const scaled = value / 1024 ** index;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: index === 0 ? 0 : 1 }).format(scaled)} ${units[index]}`;
}

function safePercent(value: number): number {
  return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;
}

export function RollupStatusPanel({
  initialStatus,
}: {
  initialStatus: RollupAdminStatus | null;
}) {
  const t = useTranslations("admin");
  const locale = useLocale();
  const [status, setStatus] = useState(initialStatus);
  const [requestFailed, setRequestFailed] = useState(false);
  const [pendingWorker, setPendingWorker] = useState<RollupWorkerName | null>(null);
  const requestGateRef = useRef<RollupStatusRequestGate | null>(null);
  const controlAbortRef = useRef<AbortController | null>(null);
  requestGateRef.current ??= createRollupStatusRequestGate();

  const refresh = useCallback(async () => {
    const requestGate = requestGateRef.current;
    if (!requestGate) return;
    const ticket = requestGate.begin();
    try {
      const response = await fetch("/api/admin/rollups/status", {
        cache: "no-store",
        signal: ticket.signal,
      });
      if (!response.ok) throw new Error("rollup status request failed");
      const nextStatus = (await response.json()) as RollupAdminStatus;
      if (!requestGate.canCommit(ticket)) return;
      setStatus(nextStatus);
      setRequestFailed(false);
    } catch {
      if (requestGate.canCommit(ticket)) setRequestFailed(true);
    }
  }, []);

  useEffect(() => {
    const requestGate = requestGateRef.current ?? createRollupStatusRequestGate();
    requestGateRef.current = requestGate;
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, POLL_MS);
    return () => {
      window.clearInterval(id);
      requestGate.dispose();
      if (requestGateRef.current === requestGate) requestGateRef.current = null;
      controlAbortRef.current?.abort();
      controlAbortRef.current = null;
    };
  }, [refresh]);

  const control = async (worker: RollupWorkerName, action: "pause" | "resume") => {
    requestGateRef.current?.invalidate();
    controlAbortRef.current?.abort();
    const controller = new AbortController();
    controlAbortRef.current = controller;
    setPendingWorker(worker);
    try {
      const response = await fetch("/api/admin/rollups/control", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ worker, action }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("rollup control request failed");
      if (controller.signal.aborted) return;
      requestGateRef.current?.invalidate();
      await refresh();
    } catch {
      if (!controller.signal.aborted) setRequestFailed(true);
    } finally {
      if (controlAbortRef.current === controller) {
        controlAbortRef.current = null;
        if (!controller.signal.aborted) setPendingWorker(null);
      }
    }
  };

  if (!status) {
    return (
      <div className="space-y-2 text-sm">
        <p className="text-muted-foreground">{t("rollup.unavailable")}</p>
        {requestFailed ? <p className="text-destructive text-xs">{t("rollup.requestFailed")}</p> : null}
        <Button type="button" variant="outline" size="sm" onClick={() => void refresh()}>
          {t("rollup.refresh")}
        </Button>
      </div>
    );
  }

  const workers: Array<{
    key: "usage15mV2" | "timezone";
    value: RollupWorkerStatusView;
  }> = [
    { key: "usage15mV2", value: status.workers.usage15mV2 },
    { key: "timezone", value: status.workers.timezone },
  ];
  const cutovers = [
    { key: "usage15mV2" as const, value: status.cutover.usage15mV2 },
    { key: "timezone" as const, value: status.cutover.timezone },
  ];
  const tableEntries = status.storage
    ? Object.entries(status.storage.tables) as Array<[
      RollupStorageTable,
      { rows: number; bytes: number },
    ]>
    : [];
  const summaryLabel = status.degraded
    ? t("rollup.summary.degraded")
    : status.backend === "postgres"
      ? t("rollup.summary.notApplicable")
      : t("rollup.summary.healthy");

  return (
    <div className="space-y-5 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={status.degraded ? "destructive" : status.backend === "postgres" ? "outline" : "secondary"}>
              {summaryLabel}
            </Badge>
            <span className="text-muted-foreground text-xs">
              {t("rollup.updatedAt", { value: formatDateTime(status.collectedAt, locale) })}
            </span>
          </div>
          <div className="text-muted-foreground space-y-1 text-xs">
            <p>
              {t("rollup.readSource.label")}: {t("rollup.readSource.usage15mV2")} {status.readSources.usage15mV2 ? t("rollup.on") : t("rollup.off")} · {t("rollup.readSource.timezone")} {status.readSources.timezone ? t("rollup.on") : t("rollup.off")}
            </p>
            <p>
              {t("rollup.rawTtl.label")}: {status.normalizedRawTtl.enabled
                ? t("rollup.rawTtl.enabled", { days: status.normalizedRawTtl.days })
                : t("rollup.rawTtl.disabled")}
            </p>
          </div>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => void refresh()}>
          {t("rollup.refresh")}
        </Button>
      </div>

      {requestFailed ? <p className="text-destructive text-xs">{t("rollup.requestFailed")}</p> : null}

      <section className="space-y-3 rounded-md border p-3" aria-label={t("rollup.coordinator.title")}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="space-y-1">
            <h3 className="font-medium">{t("rollup.coordinator.title")}</h3>
            <p className="text-muted-foreground text-xs">{t("rollup.coordinator.description")}</p>
          </div>
          <Badge variant={status.scheduler.state === "stalled" || status.scheduler.state === "unavailable" ? "destructive" : "outline"}>
            {t(`rollup.coordinator.states.${status.scheduler.state}`)}
          </Badge>
        </div>
        <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
          <div><dt className="text-muted-foreground inline">{t("rollup.coordinator.lastHeartbeat")}: </dt><dd className="inline">{formatDateTime(status.scheduler.lastHeartbeatAt, locale)}</dd></div>
          <div><dt className="text-muted-foreground inline">{t("rollup.coordinator.lastTask")}: </dt><dd className="inline">{status.scheduler.lastSelectedTask ? t(`rollup.coordinator.tasks.${status.scheduler.lastSelectedTask}`) : "—"}</dd></div>
          <div><dt className="text-muted-foreground inline">{t("rollup.coordinator.lastOutcome")}: </dt><dd className="inline">{status.scheduler.lastTaskOutcome ? t(`rollup.coordinator.outcomes.${status.scheduler.lastTaskOutcome}`) : "—"}</dd></div>
        </dl>
      </section>

      <section className="space-y-3" aria-label={t("rollup.cutover.title")}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="space-y-1">
            <h3 className="font-medium">{t("rollup.cutover.title")}</h3>
            <p className="text-muted-foreground text-xs">{t("rollup.cutover.description")}</p>
          </div>
          <Badge variant="outline">
            {t("rollup.cutover.mode")}: {t(`rollup.cutover.modes.${status.cutover.mode}`)}
          </Badge>
        </div>
        <div className="grid gap-3 lg:grid-cols-2">
          {cutovers.map(({ key, value }) => {
            const observationPercent = safePercent(
              value.requiredHealthySeconds > 0
                ? value.healthySeconds / value.requiredHealthySeconds * 100
                : 0,
            );
            const stateDanger = value.state === "fallback" || value.state === "unavailable";
            return (
              <article key={key} className="space-y-3 rounded-md border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h4 className="font-medium">{t(`rollup.cutover.layer.${key}`)}</h4>
                  <Badge variant={stateDanger ? "destructive" : "outline"}>
                    {t(`rollup.cutover.states.${value.state}`)}
                  </Badge>
                </div>
                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span>{t("rollup.cutover.observation")}</span>
                    <span>{t("rollup.cutover.observationValue", {
                      current: formatNumber(Math.floor(value.healthySeconds / 60), locale),
                      required: formatNumber(Math.ceil(value.requiredHealthySeconds / 60), locale),
                    })}</span>
                  </div>
                  <div className="bg-muted h-2 overflow-hidden rounded-full">
                    <div className="bg-primary h-full rounded-full" style={{ width: `${observationPercent}%` }} />
                  </div>
                </div>
                <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
                  <div><dt className="text-muted-foreground inline">{t("rollup.cutover.target")}: </dt><dd className="inline">{formatDateTime(value.targetWatermark, locale)}</dd></div>
                  <div><dt className="text-muted-foreground inline">{t("rollup.cutover.lastValidation")}: </dt><dd className="inline">{formatDateTime(value.lastValidationAt, locale)}</dd></div>
                  <div className="sm:col-span-2"><dt className="text-muted-foreground inline">{t("rollup.cutover.failure")}: </dt><dd className="inline">{value.lastFailureKind ? t(`rollup.cutover.failures.${value.lastFailureKind}`) : "—"}</dd></div>
                </dl>
              </article>
            );
          })}
        </div>
      </section>

      <div className="grid gap-3 lg:grid-cols-2">
        {workers.map(({ key, value: worker }) => {
          const progress = safePercent(worker.progressPercent);
          const action = worker.paused ? "resume" : "pause";
          const resumeBlocked = action === "resume" && !worker.hardEnabled;
          const controlDisabled = pendingWorker !== null
            || !worker.controlAvailable
            || worker.paused === null
            || resumeBlocked;
          const stateDanger = worker.state === "error" || worker.state === "stalled";
          const coverage = key === "timezone"
            ? t("rollup.coverage", {
              hour: formatNumber(status.coverage.hour, locale),
              day: formatNumber(status.coverage.day, locale),
            })
            : t("rollup.watermark", { value: formatDateTime(worker.watermark, locale) });

          return (
            <section key={key} className="space-y-3 rounded-md border p-3" aria-label={t(`rollup.worker.${key}`)}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <h3 className="font-medium">{t(`rollup.worker.${key}`)}</h3>
                  <Badge variant={stateDanger ? "destructive" : "outline"}>
                    {t(`rollup.states.${worker.state}`)}
                  </Badge>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={controlDisabled}
                  onClick={() => void control(worker.worker, action)}
                >
                  {action === "pause" ? t("rollup.pause") : t("rollup.resume")}
                </Button>
              </div>

              <div className="space-y-1">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span>{t("rollup.progress")}</span>
                  <span>{progress.toLocaleString(locale, { maximumFractionDigits: 2 })}%</span>
                </div>
                <div
                  role="progressbar"
                  aria-label={t("rollup.progressLabel", { worker: t(`rollup.worker.${key}`) })}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(progress)}
                  className="bg-muted h-2 overflow-hidden rounded-full"
                >
                  <div className="bg-primary h-full rounded-full" style={{ width: `${progress}%` }} />
                </div>
              </div>

              <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
                <div><dt className="text-muted-foreground inline">{t("rollup.sourceProgress")}: </dt><dd className="inline">{coverage}</dd></div>
                <div><dt className="text-muted-foreground inline">{t("rollup.remaining")}: </dt><dd className="inline">{formatNumber(worker.remainingUnits, locale)}</dd></div>
                <div>
                  <dt className="text-muted-foreground inline">{t("rollup.eta")}: </dt>
                  <dd className="inline">
                    {worker.etaMinutes == null
                      ? t("rollup.etaUnavailable")
                      : t("rollup.etaMinutes", { minutes: formatNumber(worker.etaMinutes, locale) })}
                    {worker.etaBasis === "configured" ? ` · ${t("rollup.etaConfigured")}` : ""}
                  </dd>
                </div>
                <div><dt className="text-muted-foreground inline">{t("rollup.lastSuccess")}: </dt><dd className="inline">{formatDateTime(worker.lastSuccessAt, locale)}</dd></div>
                {key === "timezone" ? (
                  <>
                    <div><dt className="text-muted-foreground inline">{t("rollup.eligiblePending")}: </dt><dd className="inline">{formatNumber(worker.eligiblePendingJobs ?? 0, locale)}</dd></div>
                    <div><dt className="text-muted-foreground inline">{t("rollup.waitingForBase")}: </dt><dd className="inline">{formatNumber(worker.waitingForBaseJobs ?? 0, locale)}</dd></div>
                    <div className="sm:col-span-2"><dt className="text-muted-foreground inline">{t("rollup.eligibleSince")}: </dt><dd className="inline">{formatDateTime(worker.eligibleSince, locale)}</dd></div>
                  </>
                ) : null}
                <div>
                  <dt className="text-muted-foreground inline">{t("rollup.load.limit", { limit: worker.adaptiveLimit == null ? "—" : formatNumber(worker.adaptiveLimit, locale) })}</dt>
                </div>
                <div>
                  <dt className="text-muted-foreground inline">
                    {worker.loadState
                      ? t("rollup.load.state", { state: t(`rollup.load.states.${worker.loadState}`) })
                      : t("rollup.load.state", { state: "—" })}
                  </dt>
                </div>
                <div className="sm:col-span-2">
                  <dt className="text-muted-foreground inline">{t("rollup.lastBatch")}: </dt>
                  <dd className="inline">
                    {worker.lastBatch
                      ? t("rollup.lastBatchValue", {
                        units: formatNumber(worker.lastBatch.units, locale),
                        rows: formatNumber(worker.lastBatch.rows, locale),
                        duration: worker.lastBatch.durationMs == null ? "—" : formatNumber(worker.lastBatch.durationMs, locale),
                      })
                      : "—"}
                  </dd>
                </div>
              </dl>

              {!worker.hardEnabled ? <p className="text-muted-foreground text-xs">{t("rollup.disabledByServer")}</p> : null}
              {worker.state === "error" && worker.lastError ? (
                <p className="text-destructive text-xs">
                  {t("rollup.lastError", { value: formatDateTime(worker.lastErrorAt, locale) })}
                </p>
              ) : null}
            </section>
          );
        })}
      </div>

      <section className="space-y-3" aria-label={t("rollup.storage.title")}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-medium">{t("rollup.storage.title")}</h3>
          <span className="text-muted-foreground text-xs">
            {t("rollup.storage.postgresRawEvents", { count: formatNumber(status.postgresRawEvents, locale) })}
          </span>
        </div>
        <p className="text-muted-foreground text-xs">
          {t("rollup.activeTimezones", { count: formatNumber(status.activeTimezones.length, locale) })} · {t("rollup.jobs", {
            pending: formatNumber(status.jobs.pending, locale),
            inflight: formatNumber(status.jobs.inflight, locale),
          })}
        </p>
        {status.storage ? (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-left text-xs">
              <thead className="bg-muted/50">
                <tr>
                  <th className="px-3 py-2 font-medium">{t("rollup.storage.table")}</th>
                  <th className="px-3 py-2 text-right font-medium">{t("rollup.storage.rows")}</th>
                  <th className="px-3 py-2 text-right font-medium">{t("rollup.storage.bytes")}</th>
                </tr>
              </thead>
              <tbody>
                {tableEntries.map(([table, stats]) => (
                  <tr key={table} className="border-t">
                    <td className="px-3 py-2 font-mono">{t(`rollup.storage.tables.${table}`)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatNumber(stats.rows, locale)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatBytes(stats.bytes, locale)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-muted-foreground text-xs">{t("rollup.storage.unavailable")}</p>
        )}
        {status.storage ? (
          <p className="text-muted-foreground text-xs">
            {t("rollup.storage.rawRange", {
              from: formatDateTime(status.storage.rawRange.from, locale),
              to: formatDateTime(status.storage.rawRange.to, locale),
            })}
          </p>
        ) : null}
      </section>
    </div>
  );
}
