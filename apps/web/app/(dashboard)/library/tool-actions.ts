"use server";

import { redirect } from "next/navigation";
import { archiveToolCatalogItem } from "@/lib/tool-catalog";
import { getDashboardViewer } from "@/lib/session-user";

export async function archiveToolCatalogAction(id: string): Promise<void> {
  const viewer = await getDashboardViewer();
  if (!viewer) redirect("/login");
  const result = await archiveToolCatalogItem(viewer.id, id);
  redirect(result.ok ? "/library?scope=mine" : "/library?scope=mine&archive=failed");
}
