"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { AlertTriangle, CheckCircle2, KeyRound } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { EncryptionAdminStatus } from "@/lib/encryption-admin-status";

function providerLabel(provider: EncryptionAdminStatus["provider"]): string {
  switch (provider) {
    case "aws-kms": return "AWS KMS";
    case "gcp-kms": return "Google Cloud KMS";
    case "azure-key-vault": return "Azure Key Vault";
    case "vault-transit": return "HashiCorp Vault Transit";
    case "openbao-transit": return "OpenBao Transit";
    case "local": return "Local KEK";
    default: return "—";
  }
}

export function EncryptionPanel({ status }: { status: EncryptionAdminStatus | null }) {
  const t = useTranslations("admin.encryption");
  if (!status) {
    return <p className="text-muted-foreground text-sm">{t("unavailable")}</p>;
  }
  if (!status.enabled) {
    return <p className="text-muted-foreground text-sm">{t("disabled")}</p>;
  }

  const cacheTotal = status.cache30d.hit + status.cache30d.miss + status.cache30d.singleFlight;
  const hitRate = cacheTotal === 0 ? null : (status.cache30d.hit / cacheTotal) * 100;
  const operationCount = status.operations30d.reduce((sum, operation) => sum + operation.count, 0);
  const health = status.health;
  const healthy = health?.status === "healthy";

  return (
    <div className="min-w-0 space-y-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={healthy ? "secondary" : "destructive"}>
          {healthy ? <CheckCircle2 /> : <AlertTriangle />}
          {healthy ? t("healthy") : t("unhealthy")}
        </Badge>
        <span className="font-medium">{providerLabel(status.provider)}</span>
      </div>

      <dl className="grid min-w-0 gap-x-4 gap-y-2 text-xs sm:grid-cols-[minmax(0,1fr)_auto]">
        <dt className="text-muted-foreground">{t("keyRef")}</dt>
        <dd className="max-w-xl break-all font-mono text-right">{status.keyRef ?? "—"}</dd>
        <dt className="text-muted-foreground">{t("fingerprint")}</dt>
        <dd className="font-mono text-right">{status.fingerprint ?? "—"}</dd>
        <dt className="text-muted-foreground">{t("credentialSource")}</dt>
        <dd className="text-right">{status.credentialSource?.kind ?? "—"}</dd>
        <dt className="text-muted-foreground">{t("credentialMode")}</dt>
        <dd className="text-right">
          {status.credentialSource?.staticCredential ? t("staticCredential") : t("ambientCredential")}
        </dd>
        <dt className="text-muted-foreground">{t("operations30d")}</dt>
        <dd className="text-right">{t("count", { count: operationCount })}</dd>
        <dt className="text-muted-foreground">{t("cacheHitRate")}</dt>
        <dd className="text-right">{hitRate === null ? "—" : `${hitRate.toFixed(1)}%`}</dd>
        <dt className="text-muted-foreground">{t("records")}</dt>
        <dd className="text-right">
          {t("recordCounts", status.records)}
        </dd>
        <dt className="text-muted-foreground">{t("userKeys")}</dt>
        <dd className="text-right">{t("userKeyCounts", status.userKeys)}</dd>
        <dt className="text-muted-foreground">{t("migrations")}</dt>
        <dd className="text-right">{t("migrationCounts", status.migrations)}</dd>
      </dl>

      {status.credentialSource?.staticCredential ? (
        <p className="flex items-start gap-2 text-xs text-amber-600 dark:text-amber-500">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          {t("staticCredentialWarning")}
        </p>
      ) : null}

      <div className="rounded-md border p-3 text-xs">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="font-medium">{t("providerMigration")}</p>
          <Badge variant={status.providerMigration.removalReady ? "secondary" : "destructive"}>
            {status.providerMigration.removalReady ? t("removalReady") : t("removalBlocked")}
          </Badge>
        </div>
        <p className="text-muted-foreground mt-2">
          {t("migrationReadinessCounts", {
            oldActive: status.providerMigration.oldActiveWrappers,
            targetActive: status.providerMigration.targetActiveWrappers,
            totalActive: status.providerMigration.totalActiveWrappers,
            pending: status.providerMigration.pendingWrappers,
            unexpected: status.providerMigration.unexpectedActiveWrappers,
          })}
        </p>
        <dl className="mt-2 grid min-w-0 gap-x-4 gap-y-1 sm:grid-cols-[auto_minmax(0,1fr)]">
          <dt className="text-muted-foreground">{t("oldFingerprint")}</dt>
          <dd className="break-all font-mono">{status.providerMigration.old?.providerFingerprint ?? "—"}</dd>
          <dt className="text-muted-foreground">{t("targetFingerprint")}</dt>
          <dd className="break-all font-mono">{status.providerMigration.target?.providerFingerprint ?? "—"}</dd>
        </dl>
        <p className="mt-3 font-medium">{t("wrapperDistribution")}</p>
        {status.wrapperDistribution.length === 0 ? (
          <p className="text-muted-foreground mt-1">{t("wrapperDistributionEmpty")}</p>
        ) : (
          <ul className="mt-1 space-y-1">
            {status.wrapperDistribution.map((entry) => (
              <li
                className="grid min-w-0 gap-x-2 sm:grid-cols-[minmax(0,1fr)_auto]"
                key={`${entry.provider}:${entry.providerFingerprint}:${entry.state}`}
              >
                <span className="break-all font-mono">
                  {entry.providerFingerprint} · {entry.state}
                </span>
                <span>{t("wrapperCount", { count: entry.count })}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="rounded-md border p-3 text-xs">
        <p className="flex items-center gap-2 font-medium"><KeyRound className="size-4" />{t("estimatedCost")}</p>
        {status.costEstimate ? (
          <>
            <p className="mt-2 text-lg font-semibold">${status.costEstimate.total.toFixed(2)} USD</p>
            <p className="text-muted-foreground">
              {t("costBreakdown", {
                requests: status.costEstimate.requestCost.toFixed(2),
                key: status.costEstimate.monthlyKeyCost.toFixed(2),
              })}
            </p>
            <p className="text-muted-foreground mt-2">
              {status.costEstimate.source === "reference"
                ? t("referencePricing", { asOf: status.costEstimate.asOf ?? "—" })
                : t("overridePricing")}
            </p>
            <p className="text-muted-foreground">{t("grossDisclaimer")}</p>
            <p className="text-muted-foreground mt-2">
              {t("costScope", {
                included: status.costEstimate.includedRequests,
                excluded: status.costEstimate.excludedRequests,
              })}
            </p>
          </>
        ) : (
          <p className="text-muted-foreground mt-2">{t("costUnavailable")}</p>
        )}
      </div>
    </div>
  );
}
