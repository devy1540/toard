import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { ArrowLeft, ExternalLink, ShieldAlert } from "lucide-react";
import { CopyButton } from "@/components/dashboard/copy-button";
import { FeatureStatusBadge } from "@/components/dashboard/feature-status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { catalogInstallStateMessageKey } from "@/lib/catalog-install-state";
import { getToolCatalogItem } from "@/lib/tool-catalog";
import { getDashboardViewer } from "@/lib/session-user";
import { getToolDeploymentView } from "@/lib/tool-deployment-view";
import { toolDeploymentExperimentalEnabled } from "@/lib/tool-deployment-feature";
import { archiveToolCatalogAction } from "../tool-actions";
import { TeamDeploymentPanel } from "./team-deployment-panel";
import { ToolInstallPanel } from "./tool-install-panel";

export const dynamic = "force-dynamic";

export default async function LibraryDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const viewer = await getDashboardViewer();
  if (!viewer) redirect("/login");
  const [{ slug }, t, locale] = await Promise.all([params, getTranslations("library"), getLocale()]);
  const item = await getToolCatalogItem(viewer, slug);
  if (!item) notFound();
  const deployment = await getToolDeploymentView(viewer.id, viewer.teamId, item.id);
  const deploymentEnabled = toolDeploymentExperimentalEnabled();

  if (item.lifecycleStatus === "blocked") {
    return (
      <div className="space-y-5">
        <Button asChild variant="ghost" size="sm"><Link href="/library"><ArrowLeft />{t("detail.back")}</Link></Button>
        <Card className="border-destructive/40">
          <CardHeader>
            <div className="text-destructive flex items-center gap-2"><ShieldAlert className="size-5" /><CardTitle>{t("detail.blockedTitle")}</CardTitle></div>
            <CardDescription>{t("detail.blockedDescription")}</CardDescription>
          </CardHeader>
          <CardContent><p className="rounded-md bg-destructive/5 p-3 text-sm">{item.statusReason ?? t("detail.blockedNoReason")}</p></CardContent>
        </Card>
      </div>
    );
  }

  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(item.updatedAt);
  const installState = t(catalogInstallStateMessageKey(item.installState));

  return (
    <div className="min-w-0 space-y-5">
      <Button asChild variant="ghost" size="sm"><Link href="/library"><ArrowLeft />{t("detail.back")}</Link></Button>
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight">{item.name}</h1>
            <FeatureStatusBadge status="experiment">{t("experimental")}</FeatureStatusBadge>
            <Badge variant="secondary">{t(`kind.${item.kind}`)}</Badge>
            {item.lifecycleStatus === "deprecated" ? <Badge variant="outline">{t("lifecycle.deprecated")}</Badge> : null}
          </div>
          <p className="text-muted-foreground mt-2 text-sm">{item.description}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 self-start">
          <Badge variant="outline">{installState}</Badge>
          {item.ownerUserId === viewer.id ? (
            <>
              <Button asChild size="sm" variant="outline"><Link href={`/library/${item.slug}/edit`}>{t("form.edit")}</Link></Button>
              {item.lifecycleStatus !== "archived" ? <form action={archiveToolCatalogAction.bind(null, item.id)}><Button type="submit" size="sm" variant="destructive">{t("form.archive")}</Button></form> : null}
            </>
          ) : null}
        </div>
      </div>

      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(20rem,0.8fr)]">
        <ToolInstallPanel item={item} deployment={deployment} enabled={deploymentEnabled} />
        {viewer.teamRole === "leader" ? <TeamDeploymentPanel item={item} deployment={deployment} enabled={deploymentEnabled} /> : null}
      </div>

      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <Card className="min-w-0">
          <CardHeader><CardTitle>{t("detail.source")}</CardTitle></CardHeader>
          <CardContent className="min-w-0 space-y-4 text-sm">
            <div className="min-w-0"><Button asChild variant="outline" size="sm"><a href={item.sourceUrl} target="_blank" rel="noreferrer"><ExternalLink />{t("detail.sourceOpen")}</a></Button><p className="text-muted-foreground mt-2 break-all text-xs">{item.sourceUrl}</p></div>
            <div><p className="text-muted-foreground text-xs font-medium">{t("detail.sourceRef")}</p><code className="mt-1 block break-all rounded bg-muted px-2 py-1">{item.sourceRef}</code></div>
            <p className="text-muted-foreground text-xs">{t("detail.tagNotice")}</p>
            <p className="border-t pt-3 text-xs">{t("detail.verificationNotice")}</p>
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader><CardTitle>{t("detail.installState")}</CardTitle></CardHeader>
          <CardContent className="space-y-4 text-sm">
            <p className="font-medium">{installState}</p>
            <MetadataList label={t("detail.clients")} values={item.supportedClients.map((client) => client === "claude_code" ? "Claude Code" : "Codex")} empty="—" />
            <MetadataList label={t("detail.requiredEnv")} values={item.requiredEnv} empty={t("detail.noRequiredEnv")} code />
            <MetadataList label={t("detail.networkHosts")} values={item.networkHosts} empty={t("detail.noNetworkHosts")} code />
          </CardContent>
        </Card>
      </div>

      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <InstructionCard title={t("detail.installNotes")} text={item.installNotes || t("detail.noNotes")} copyLabel={t("detail.copyInstall")} copied={t("detail.copied")} />
        <InstructionCard title={t("detail.uninstallNotes")} text={item.uninstallNotes || t("detail.noNotes")} copyLabel={t("detail.copyUninstall")} copied={t("detail.copied")} />
      </div>

      <div className="text-muted-foreground flex flex-wrap gap-x-6 gap-y-1 border-t pt-4 text-xs">
        <span>{t("detail.publishedBy")}: {item.ownerName ?? t("detail.publicPublisher")}</span>
        <span>{t("detail.updatedAt")}: {date}</span>
      </div>
    </div>
  );
}

function MetadataList({ label, values, empty, code = false }: { label: string; values: string[]; empty: string; code?: boolean }) {
  return <div><p className="text-muted-foreground text-xs font-medium">{label}</p>{values.length ? <div className="mt-1 flex flex-wrap gap-1.5">{values.map((value) => code ? <code key={value} className="rounded bg-muted px-2 py-1 text-xs">{value}</code> : <Badge key={value} variant="outline">{value}</Badge>)}</div> : <p className="mt-1">{empty}</p>}</div>;
}

function InstructionCard({ title, text, copyLabel, copied }: { title: string; text: string; copyLabel: string; copied: string }) {
  return <Card className="min-w-0"><CardHeader className="flex-row items-center justify-between gap-3"><CardTitle>{title}</CardTitle><CopyButton text={text} label={copyLabel} message={copied} /></CardHeader><CardContent><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 font-mono text-xs">{text}</pre></CardContent></Card>;
}
