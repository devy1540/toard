import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getDashboardViewer } from "@/lib/session-user";
import { ToolShareForm } from "./tool-share-form";

export default async function ShareToolPage() {
  const viewer = await getDashboardViewer();
  if (!viewer) redirect("/login");
  const t = await getTranslations("library");
  return <div className="min-w-0 space-y-5"><Button asChild variant="ghost" size="sm"><Link href="/library"><ArrowLeft />{t("detail.back")}</Link></Button><div><h1 className="text-xl font-semibold tracking-tight">{t("form.title")}</h1><p className="text-muted-foreground mt-1 text-sm">{t("form.description")}</p></div><ToolShareForm mode="create" /></div>;
}
