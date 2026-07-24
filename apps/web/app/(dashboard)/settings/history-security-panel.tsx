import { getLocale, getTranslations } from "next-intl/server";
import { KeyRound, MonitorSmartphone, ShieldCheck } from "lucide-react";
import * as React from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  getUserHistorySecurityStatus,
  type UserHistorySecurityStatus,
} from "@/lib/user-history-security";
import { getViewerTimezone } from "@/lib/viewer-time";

export type HistorySecurityTranslationKey =
  | "title"
  | "description"
  | "protected"
  | "ready"
  | "transitioning"
  | "attention"
  | "disabled"
  | "protectionMethod"
  | "managedEncryption"
  | "notConfigured"
  | "historyKey"
  | "keyAutoCreate"
  | "privacyBoundary"
  | "statusUnavailable"
  | "legacyTitle"
  | "legacyDescription"
  | "legacyPending"
  | "legacyActive"
  | "legacyMigrating"
  | "legacyBlocked"
  | "legacyComplete"
  | "legacyE2eeRecords"
  | "legacyServerRecords"
  | "recoveryConfirmed"
  | "approvedDevices"
  | "neverUsed"
  | "noDevices"
  | "legacyReadOnly";

type Translate = (
  key: HistorySecurityTranslationKey,
  values?: Record<string, string | number>,
) => string;

function effectiveState(
  status: UserHistorySecurityStatus | null,
): UserHistorySecurityStatus["managed"]["state"] {
  if (!status) return "attention";
  if (status.managed.state === "attention" || status.legacy?.state === "blocked") {
    return "attention";
  }
  if (status.managed.state === "transitioning" || status.legacy?.state === "migrating") {
    return "transitioning";
  }
  return status.managed.state;
}

function badgeVariant(
  state: UserHistorySecurityStatus["managed"]["state"],
): "secondary" | "outline" | "destructive" {
  if (state === "attention") return "destructive";
  if (state === "protected") return "secondary";
  return "outline";
}

function legacyMessage(
  legacy: NonNullable<UserHistorySecurityStatus["legacy"]>,
  translate: Translate,
): string {
  if (legacy.state === "blocked") {
    return translate("legacyBlocked", { count: legacy.e2eeRecords });
  }
  if (legacy.state === "migrating") {
    return translate("legacyMigrating", {
      count: legacy.e2eeRecords + legacy.serverRecords,
    });
  }
  if (legacy.state === "pending") return translate("legacyPending");
  if (legacy.state === "active") return translate("legacyActive");
  return translate("legacyComplete");
}

export function HistorySecurityPanelView({
  status,
  translate,
  formatDate,
}: {
  status: UserHistorySecurityStatus | null;
  translate: Translate;
  formatDate: (date: Date) => string;
}) {
  const legacy = status?.legacy ?? null;
  const state = effectiveState(status);

  return (
    <Card id="history-security" className="min-w-0 scroll-mt-6">
      <CardHeader>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <CardTitle>{translate("title")}</CardTitle>
          <Badge variant={badgeVariant(state)}>{translate(state)}</Badge>
        </div>
        <CardDescription>{translate("description")}</CardDescription>
      </CardHeader>
      <CardContent className="min-w-0 space-y-4">
        {status ? (
          <>
            <dl className="grid min-w-0 gap-3 text-sm sm:grid-cols-2">
              <div className="min-w-0 rounded-lg border p-3">
                <dt className="text-muted-foreground flex items-center gap-1.5 text-xs">
                  <ShieldCheck className="size-3.5" />
                  {translate("protectionMethod")}
                </dt>
                <dd className="mt-1 font-medium">
                  {status.managed.configured
                    ? translate("managedEncryption")
                    : translate("notConfigured")}
                </dd>
              </div>
              <div className="min-w-0 rounded-lg border p-3">
                <dt className="text-muted-foreground flex items-center gap-1.5 text-xs">
                  <KeyRound className="size-3.5" />
                  {translate("historyKey")}
                </dt>
                <dd className="mt-1 font-medium">
                  {status.managed.activeKeyVersion !== null
                    ? `v${status.managed.activeKeyVersion}`
                    : status.managed.state === "ready"
                      ? translate("keyAutoCreate")
                      : "—"}
                </dd>
              </div>
            </dl>
            {status.managed.state === "attention" ? (
              <Alert variant="destructive" className="border-destructive/40 bg-destructive/5">
                <AlertDescription>{translate("statusUnavailable")}</AlertDescription>
              </Alert>
            ) : null}
            <p className="text-muted-foreground text-xs">{translate("privacyBoundary")}</p>
          </>
        ) : (
          <Alert variant="destructive" className="border-destructive/40 bg-destructive/5">
            <AlertDescription>{translate("statusUnavailable")}</AlertDescription>
          </Alert>
        )}

        {legacy ? (
          <section className="min-w-0 space-y-3 border-t pt-4">
            <div>
              <h3 className="text-sm font-medium">{translate("legacyTitle")}</h3>
              <p className="text-muted-foreground mt-1 text-xs">
                {translate("legacyDescription")}
              </p>
            </div>
            <p className="rounded-lg border p-3 text-sm">{legacyMessage(legacy, translate)}</p>
            <dl className="grid min-w-0 gap-3 text-sm sm:grid-cols-2">
              {legacy.hasE2eeContext ? (
                <div className="min-w-0 rounded-lg border p-3">
                  <dt className="text-muted-foreground text-xs">{translate("legacyE2eeRecords")}</dt>
                  <dd className="mt-1 font-medium">{legacy.e2eeRecords}</dd>
                </div>
              ) : null}
              <div className="min-w-0 rounded-lg border p-3">
                <dt className="text-muted-foreground text-xs">{translate("legacyServerRecords")}</dt>
                <dd className="mt-1 font-medium">{legacy.serverRecords}</dd>
              </div>
              {legacy.hasE2eeContext ? (
                <div className="min-w-0 rounded-lg border p-3 sm:col-span-2">
                  <dt className="text-muted-foreground flex items-center gap-1.5 text-xs">
                    <ShieldCheck className="size-3.5" />
                    {translate("recoveryConfirmed")}
                  </dt>
                  <dd className="mt-1 break-words font-medium">
                    {legacy.recoveryConfirmedAt
                      ? formatDate(legacy.recoveryConfirmedAt)
                      : "—"}
                  </dd>
                </div>
              ) : null}
            </dl>
            {legacy.hasE2eeContext ? (
              <div className="min-w-0">
                <h3 className="text-sm font-medium">{translate("approvedDevices")}</h3>
                {legacy.devices.length > 0 ? (
                  <ul className="mt-2 min-w-0 divide-y rounded-lg border">
                    {legacy.devices.map((device) => (
                      <li key={device.id} className="flex min-w-0 items-center gap-3 p-3 text-sm">
                        <MonitorSmartphone className="text-muted-foreground size-4 shrink-0" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{device.label}</span>
                          <span className="text-muted-foreground block truncate text-xs">
                            {device.kind} · {device.platform}
                          </span>
                        </span>
                        <span className="text-muted-foreground shrink-0 text-xs">
                          {device.lastUsedAt
                            ? formatDate(device.lastUsedAt)
                            : translate("neverUsed")}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-muted-foreground mt-2 text-sm">{translate("noDevices")}</p>
                )}
              </div>
            ) : null}
            <p className="text-muted-foreground text-xs">{translate("legacyReadOnly")}</p>
          </section>
        ) : null}
      </CardContent>
    </Card>
  );
}

export async function HistorySecurityPanel({ userId }: { userId: string }) {
  const t = await getTranslations("settings.historySecurity");
  const status = await getUserHistorySecurityStatus(userId).catch(() => null);
  const locale = await getLocale();
  const formatter = new Intl.DateTimeFormat(locale, {
    timeZone: await getViewerTimezone(),
    dateStyle: "medium",
    timeStyle: "short",
  });

  return (
    <HistorySecurityPanelView
      status={status}
      translate={(key, values) => t(key, values)}
      formatDate={(date) => formatter.format(date)}
    />
  );
}
