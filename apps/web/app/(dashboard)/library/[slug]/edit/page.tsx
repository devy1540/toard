import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ArrowLeft } from "lucide-react";
import type { ToolCatalogSubmission } from "@toard/core";
import { Button } from "@/components/ui/button";
import { getToolCatalogItem } from "@/lib/tool-catalog";
import { getDashboardViewer } from "@/lib/session-user";
import { ToolShareForm } from "../../share/tool-share-form";

export default async function EditToolPage({ params }: { params: Promise<{ slug: string }> }) {
  const viewer = await getDashboardViewer();
  if (!viewer) redirect("/login");
  const { slug } = await params;
  const item = await getToolCatalogItem(viewer, slug);
  if (!item || item.ownerUserId !== viewer.id) redirect(`/library/${slug}`);
  const t = await getTranslations("library");
  const initial: ToolCatalogSubmission = {
    name: item.name, slug: item.slug, description: item.description, kind: item.kind,
    sourceUrl: item.sourceUrl, sourceRef: item.sourceRef, supportedClients: item.supportedClients,
    requiredEnv: item.requiredEnv, networkHosts: item.networkHosts, installNotes: item.installNotes,
    uninstallNotes: item.uninstallNotes, inventoryItemKey: item.inventoryItemKey,
    inventorySourceProvider: item.inventorySourceProvider,
  };
  return <div className="min-w-0 space-y-5"><Button asChild variant="ghost" size="sm"><Link href={`/library/${item.slug}`}><ArrowLeft />{t("form.backToDetail")}</Link></Button><div><h1 className="text-xl font-semibold tracking-tight">{t("form.editTitle")}</h1><p className="text-muted-foreground mt-1 text-sm">{t("form.editDescription")}</p></div><ToolShareForm mode="edit" itemId={item.id} initial={initial} /></div>;
}
