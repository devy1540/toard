"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { AlertTriangle, CheckCircle2, KeyRound, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { LegacyRetirementStatus } from "@/lib/e2ee-legacy-retirement";

export function LegacyRetirementPanel({ initialStatus }: { initialStatus: LegacyRetirementStatus | null }) {
  const t = useTranslations("admin.system");
  const locale = useLocale();
  const [status, setStatus] = useState(initialStatus);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const confirmBackup = async () => {
    setBusy(true);
    setFailed(false);
    try {
      const response = await fetch("/api/admin/content-retirement/confirm-backup", { method: "POST" });
      if (!response.ok) throw new Error("confirmation failed");
      setStatus(await response.json() as LegacyRetirementStatus);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  if (!status) return <p className="text-muted-foreground text-sm">{t("legacyRetirementUnavailable")}</p>;
  const canConfirm = status.state === "backup_confirmation_required" || status.state === "key_removed_unconfirmed";
  const done = status.state === "retired";
  const dangerous = status.state === "unsafe_key_missing" || status.state === "key_removed_unconfirmed";
  const fmt = (value: string | null) => value
    ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value))
    : "—";

  return (
    <div className="min-w-0 space-y-3 text-sm">
      <Badge variant={done ? "secondary" : dangerous ? "destructive" : "outline"}>
        {done ? <CheckCircle2 /> : dangerous ? <AlertTriangle /> : <KeyRound />}
        {t(`legacyRetirementStates.${status.state}`)}
      </Badge>
      <dl className="grid min-w-0 gap-x-4 gap-y-2 text-xs sm:grid-cols-[minmax(0,1fr)_auto]">
        <dt className="text-muted-foreground">{t("legacyRemaining")}</dt><dd className="font-medium">{t("legacyRecords", { count: status.legacyRecords })}</dd>
        <dt className="text-muted-foreground">{t("legacyZeroObserved")}</dt><dd>{fmt(status.zeroObservedAt)}</dd>
        <dt className="text-muted-foreground">{t("legacyRetention")}</dt><dd>{status.retentionDays === null ? t("legacyUnconfigured") : t("legacyDays", { count: status.retentionDays })}</dd>
        <dt className="text-muted-foreground">{t("legacyEligibleAt")}</dt><dd>{fmt(status.eligibleAt)}</dd>
        <dt className="text-muted-foreground">{t("legacyBackupConfirmed")}</dt><dd>{fmt(status.backupConfirmedAt)}</dd>
        <dt className="text-muted-foreground">{t("legacyKek")}</dt><dd>{status.kekConfigured ? t("legacyKekPresent") : t("legacyKekRemoved")}</dd>
      </dl>
      {canConfirm ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void confirmBackup()}>{busy ? <Loader2 className="animate-spin" /> : null}{t("legacyConfirmBackup")}</Button> : null}
      {canConfirm ? <p className="text-muted-foreground text-xs">{t("legacyConfirmBackupNote")}</p> : null}
      {failed ? <p className="text-destructive text-xs">{t("legacyConfirmFailed")}</p> : null}
    </div>
  );
}
