import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FeatureStatusBadge } from "@/components/dashboard/feature-status-badge";
import { getDashboardViewer } from "@/lib/session-user";
import { getMyDeviceInventories } from "@/lib/tool-metadata";
import { ToolShareForm } from "./tool-share-form";

export default async function ShareToolPage() {
  const viewer = await getDashboardViewer();
  if (!viewer) redirect("/login");
  const [t, inventories] = await Promise.all([
    getTranslations("library"),
    getMyDeviceInventories(viewer.id).catch(() => []),
  ]);
  const detectedTools = [...new Map(
    inventories.flatMap((inventory) => inventory.items).map((item) => [
      `${item.kind}:${item.sourceProvider}:${item.itemKey}`,
      {
        kind: item.kind,
        itemKey: item.itemKey,
        displayName: item.displayName,
        sourceProvider: item.sourceProvider,
      },
    ]),
  ).values()];
  return <div className="min-w-0 space-y-5"><Button asChild variant="ghost" size="sm"><Link href="/library"><ArrowLeft />{t("detail.back")}</Link></Button><div><div className="flex flex-wrap items-center gap-2"><h1 className="text-xl font-semibold tracking-tight">{t("form.title")}</h1><FeatureStatusBadge status="experiment">{t("experimental")}</FeatureStatusBadge></div><p className="text-muted-foreground mt-1 text-sm">{t("form.description")}</p></div><ToolShareForm mode="create" detectedTools={detectedTools} /></div>;
}
