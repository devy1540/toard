import { useTranslations } from "next-intl";
import type { ToolCatalogItem } from "@toard/core";
import { Badge } from "@/components/ui/badge";
import { FeatureStatusBadge } from "@/components/dashboard/feature-status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { ToolDeploymentView } from "@/lib/tool-deployment-view";
import { excludeTeamDefaultAction, installToolAction } from "./tool-install-actions";

export function ToolInstallPanel({ item, deployment, enabled }: { item: ToolCatalogItem; deployment: ToolDeploymentView; enabled: boolean }) {
  const t = useTranslations("library.install");
  const settingsRequiredCommand = `toard-shim tool configure ${item.slug}`;
  return (
    <Card className="min-w-0 border-primary/25" aria-labelledby="install-heading">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle id="install-heading">{t("title")}</CardTitle>
          <FeatureStatusBadge status="preview">{t("experimental")}</FeatureStatusBadge>
        </div>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-3 rounded-lg bg-muted/50 p-4 text-sm sm:grid-cols-3">
          <Summary label={t("source")} value={item.sourceRef} />
          <Summary label={t("clients")} value={item.supportedClients.map((client) => client === "codex" ? "Codex" : "Claude Code").join(", ")} />
          <Summary label={t("permissions")} value={t("permissionCount", { env: item.requiredEnv.length, hosts: item.networkHosts.length })} />
        </div>

        {!enabled ? (
          <div className="rounded-md border border-orange-500/30 bg-orange-500/5 p-3 text-sm">
            <p className="font-medium">{t("disabledTitle")}</p>
            <p className="text-muted-foreground mt-1">{t("disabledDescription")}</p>
          </div>
        ) : deployment.versionId ? (
          <form action={installToolAction} className="space-y-3">
            <input type="hidden" name="catalogItemId" value={item.id} />
            <input type="hidden" name="versionId" value={deployment.versionId} />
            <input type="hidden" name="slug" value={item.slug} />
            <label className="flex items-start gap-3 rounded-md border p-3 text-sm">
              <input type="radio" name="scope" value="all_devices" defaultChecked={deployment.selectedScope === "all_devices"} className="mt-1" />
              <span><strong className="block">{t("installAllDevices")}</strong><span className="text-muted-foreground">{t("installAllDevicesDescription")}</span></span>
            </label>
            <details className="rounded-md border p-3">
              <summary className="cursor-pointer text-sm font-medium">{t("advancedDeviceSelection")}</summary>
              <label className="mt-3 flex items-start gap-3 text-sm">
                <input type="radio" name="scope" value="selected_devices" defaultChecked={deployment.selectedScope === "selected_devices"} className="mt-1" />
                <span>{t("selectedDevices")}</span>
              </label>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {deployment.devices.map((device) => (
                  <label key={device.fingerprint} className="flex items-start gap-2 rounded border p-2 text-xs">
                    <input type="checkbox" name="deviceFingerprints" value={device.fingerprint} defaultChecked={deployment.selectedDevices.includes(device.fingerprint)} />
                    <span className="min-w-0"><strong className="block truncate">{device.host ?? t("unknownDevice")}</strong><code className="text-muted-foreground">{device.fingerprint.slice(0, 12)}…</code></span>
                  </label>
                ))}
                {deployment.devices.length === 0 ? <p className="text-muted-foreground">{t("noDevices")}</p> : null}
              </div>
            </details>
            <Button type="submit">{t("install")}</Button>
            <p className="text-muted-foreground text-xs">{t("nextShimRun")}</p>
          </form>
        ) : (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
            <p className="font-medium">{t("versionUnavailable")}</p>
            <p className="text-muted-foreground mt-1">{t("versionUnavailableDescription")}</p>
          </div>
        )}

        {deployment.reports.length > 0 ? (
          <div className="space-y-2">
            <h3 className="text-sm font-medium">{t("deviceStatus")}</h3>
            {deployment.reports.map((report) => (
              <div key={report.fingerprint} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
                <span>{report.host ?? `${report.fingerprint.slice(0, 12)}…`}</span>
                <Badge variant={report.status === "installed" ? "default" : "outline"}>{t(`status.${report.status}`)}</Badge>
                {report.status === "settings_required" ? <code className="w-full rounded bg-muted p-2 text-xs">{settingsRequiredCommand}</code> : null}
              </div>
            ))}
            <p className="text-muted-foreground text-xs">{t("settingsRequiredCommand")}: <code>{settingsRequiredCommand}</code></p>
          </div>
        ) : null}

        {deployment.inherited ? (
          <form action={excludeTeamDefaultAction}>
            <input type="hidden" name="catalogItemId" value={item.id} />
            <input type="hidden" name="slug" value={item.slug} />
            <Button type="submit" variant="ghost">{t("excludeTeamDefault")}</Button>
          </form>
        ) : deployment.excluded ? <p className="text-muted-foreground text-sm">{t("excluded")}</p> : null}
      </CardContent>
    </Card>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0"><p className="text-muted-foreground text-xs">{label}</p><p className="mt-1 truncate font-medium">{value}</p></div>;
}
