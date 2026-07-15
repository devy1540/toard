import { useTranslations } from "next-intl";
import type { ToolCatalogItem } from "@toard/core";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { ToolDeploymentView } from "@/lib/tool-deployment-view";
import { approveTeamRolloutAction, deployTeamDefaultAction } from "./tool-install-actions";

export function TeamDeploymentPanel({ item, deployment }: { item: ToolCatalogItem; deployment: ToolDeploymentView }) {
  const t = useTranslations("library.teamDeployment");
  const policy = deployment.teamPolicy;
  return (
    <Card className="min-w-0">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2"><CardTitle>{t("title")}</CardTitle><Badge variant="outline">{t("leaderOnly")}</Badge></div>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {policy ? (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2"><Badge>{t(`phase.${policy.phase}`)}</Badge><Badge variant="outline">{policy.percent}%</Badge></div>
            <div className="grid grid-cols-3 gap-2 text-center text-sm">
              <Metric label={t("installed")} value={policy.installed} />
              <Metric label={t("settingsRequired")} value={policy.settingsRequired} />
              <Metric label={t("failed")} value={policy.failed} />
            </div>
          </div>
        ) : <p className="text-muted-foreground text-sm">{t("notDeployed")}</p>}
        <form action={deployTeamDefaultAction}>
          <input type="hidden" name="catalogItemId" value={item.id} />
          <input type="hidden" name="versionId" value={deployment.versionId ?? ""} />
          <input type="hidden" name="slug" value={item.slug} />
          <Button type="submit" variant="outline" disabled={!deployment.versionId}>{policy ? t("update") : t("deploy")}</Button>
        </form>
        {policy?.phase === "paused" ? (
          <form action={approveTeamRolloutAction}>
            <input type="hidden" name="catalogItemId" value={item.id} />
            <input type="hidden" name="slug" value={item.slug} />
            <Button type="submit">{t("approvePermissions")}</Button>
          </form>
        ) : null}
        <p className="text-muted-foreground text-xs">{t("rolloutNotice")}</p>
      </CardContent>
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return <div className="rounded-md bg-muted p-2"><strong className="block text-base">{value}</strong><span className="text-muted-foreground text-xs">{label}</span></div>;
}
