import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { LibraryBig, Search } from "lucide-react";
import type { CatalogInstallState, ToolCatalogKind, ToolCatalogScope } from "@toard/core";
import { LinkTabs } from "@/components/dashboard/link-tabs";
import { FeatureStatusBadge } from "@/components/dashboard/feature-status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { listToolCatalog, type CatalogListFilter, type ToolCatalogListItem } from "@/lib/tool-catalog";
import { getDashboardViewer } from "@/lib/session-user";

export const dynamic = "force-dynamic";

type LibrarySearchParams = { scope?: string; kind?: string; q?: string };

function parseScope(value: string | undefined): ToolCatalogScope {
  return value === "public" || value === "workspace" || value === "mine" ? value : "all";
}

function parseKind(value: string | undefined): ToolCatalogKind | "all" {
  return value === "mcp" || value === "skill" || value === "plugin" ? value : "all";
}

function libraryHref(scope: ToolCatalogScope, kind: ToolCatalogKind | "all", query: string): string {
  const params = new URLSearchParams();
  if (scope !== "all") params.set("scope", scope);
  if (kind !== "all") params.set("kind", kind);
  if (query) params.set("q", query);
  const search = params.toString();
  return search ? `/library?${search}` : "/library";
}

function stateKey(state: CatalogInstallState): string {
  if (state.status === "not_installed" || state.status === "unavailable") return `state.${state.status}`;
  if (state.versionRelation === "same") return "state.sameVersion";
  if (state.versionRelation === "different") return "state.differentVersion";
  return "state.versionUnknown";
}

export default async function LibraryPage({ searchParams }: { searchParams: Promise<LibrarySearchParams> }) {
  const viewer = await getDashboardViewer();
  if (!viewer) redirect("/login");
  const [sp, t] = await Promise.all([searchParams, getTranslations("library")]);
  const filter: CatalogListFilter = {
    scope: parseScope(sp.scope),
    kind: parseKind(sp.kind),
    query: (sp.q ?? "").trim().slice(0, 100),
  };
  const items = await listToolCatalog(viewer, filter);

  return (
    <div className="min-w-0 space-y-5">
      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight">{t("title")}</h1>
            <FeatureStatusBadge status="preview">{t("experimental")}</FeatureStatusBadge>
          </div>
          <p className="text-muted-foreground mt-1 text-sm">{t("description")}</p>
        </div>
        <Button asChild className="self-start">
          <Link href="/library/share">{t("share")}</Link>
        </Button>
      </div>

      <div className="min-w-0 space-y-3">
        <LinkTabs
          active={filter.scope}
          tabs={(["all", "public", "workspace", "mine"] as const).map((scope) => ({
            value: scope,
            label: t(`scope.${scope}`),
            href: libraryHref(scope, filter.kind, filter.query),
          }))}
        />

        <form method="get" className="flex min-w-0 flex-col gap-2 rounded-lg border bg-card p-3 sm:flex-row sm:items-end">
          <input type="hidden" name="scope" value={filter.scope} />
          <label className="min-w-0 flex-1 text-xs font-medium">
            <span className="sr-only">{t("filters.searchLabel")}</span>
            <Input name="q" defaultValue={filter.query} placeholder={t("filters.searchPlaceholder")} />
          </label>
          <label className="text-xs font-medium">
            <span className="sr-only">{t("filters.kindLabel")}</span>
            <select
              name="kind"
              defaultValue={filter.kind}
              className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm sm:w-40"
            >
              {(["all", "mcp", "skill", "plugin"] as const).map((kind) => (
                <option key={kind} value={kind}>{t(`kind.${kind}`)}</option>
              ))}
            </select>
          </label>
          <div className="flex gap-2">
            <Button type="submit" size="sm"><Search />{t("filters.apply")}</Button>
            <Button asChild type="button" size="sm" variant="outline"><Link href="/library">{t("filters.reset")}</Link></Button>
          </div>
        </form>
      </div>

      {items.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon"><LibraryBig /></EmptyMedia>
            <EmptyTitle>{t("empty.title")}</EmptyTitle>
            <EmptyDescription>{t("empty.description")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="min-w-0 overflow-hidden rounded-lg border bg-card">
          <div className="text-muted-foreground hidden grid-cols-[minmax(0,2fr)_7rem_10rem_11rem_4rem] gap-3 border-b bg-muted/40 px-4 py-2 text-xs font-medium md:grid">
            <span>{t("table.tool")}</span><span>{t("table.kind")}</span><span>{t("table.origin")}</span><span>{t("table.state")}</span><span />
          </div>
          <div className="divide-y">
            {items.map((item) => <LibraryRow key={item.id} item={item} />)}
          </div>
        </div>
      )}
    </div>
  );
}

async function LibraryRow({ item }: { item: ToolCatalogListItem }) {
  const t = await getTranslations("library");
  const origin = item.origin === "public"
    ? t("table.publicOrigin")
    : t("table.workspaceOrigin", { owner: item.ownerName ?? "—" });
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 md:grid-cols-[minmax(0,2fr)_7rem_10rem_11rem_4rem]">
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <Link className="truncate font-medium hover:underline" href={`/library/${item.slug}`}>{item.name}</Link>
          <Badge variant={item.trustStatus === "verified" ? "default" : "outline"}>{t(`trust.${item.trustStatus}`)}</Badge>
          {item.lifecycleStatus === "deprecated" ? <Badge variant="outline">{t("lifecycle.deprecated")}</Badge> : null}
        </div>
        <p className="text-muted-foreground mt-0.5 truncate text-sm">{item.description}</p>
        <p className="text-muted-foreground mt-1 truncate text-xs md:hidden">{origin} · {t(stateKey(item.installState) as "state.not_installed")}</p>
      </div>
      <Badge variant="secondary" className="hidden md:inline-flex">{t(`kind.${item.kind}`)}</Badge>
      <span className="hidden truncate text-sm md:block">{origin}</span>
      <span className="hidden text-sm md:block">{t(stateKey(item.installState) as "state.not_installed")}</span>
      <Button asChild size="sm" variant="outline"><Link href={`/library/${item.slug}`}>{t("table.detail")}</Link></Button>
    </div>
  );
}
