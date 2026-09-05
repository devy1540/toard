import Link from "next/link";
import { redirect } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { DashboardFilters } from "@/components/dashboard/dashboard-filters";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Disclosure } from "@/components/ui/disclosure";
import { Surface } from "@/components/ui/surface";
import { decodeCostCursor, encodeCostCursor, explainStoredCost, getCostEvidenceRevisions } from "@/lib/cost-evidence";
import { getCurrentUserId } from "@/lib/current-user";
import { fmtNum, fmtUsd } from "@/lib/format";
import { parseDashboardPeriod, type DashboardSearchParams } from "@/lib/period";
import { getEnabledProviders } from "@/lib/providers";
import { getStorage } from "@/lib/storage";
import { getViewerTimezone } from "@/lib/viewer-time";

export const dynamic = "force-dynamic";
const componentKeys = ["input", "output", "cacheRead", "cacheCreate", "cacheCreate1h"] as const;

export default async function CostsPage({ searchParams }: {
  searchParams: Promise<DashboardSearchParams & { cursor?: string }>;
}) {
  const userId = await getCurrentUserId();
  if (!userId) redirect("/login");
  const sp = await searchParams;
  const timezone = await getViewerTimezone();
  const period = parseDashboardPeriod({ ...sp, period: sp.period ?? "30" }, timezone);
  const t = await getTranslations("dashboard");
  const locale = await getLocale();
  const [page, providers] = await Promise.all([
    getStorage().getCostEvidence(userId, { ...period, before: decodeCostCursor(sp.cursor), limit: 50 }),
    getEnabledProviders(),
  ]);
  const revisions = await getCostEvidenceRevisions(page.events);
  const nextQuery = new URLSearchParams();
  for (const key of ["period", "provider", "from", "to"] as const) {
    if (typeof sp[key] === "string") nextQuery.set(key, sp[key]);
  }
  if (page.next) nextQuery.set("cursor", encodeCostCursor(page.next));
  const formatTime = (date: Date) => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: timezone }).format(date);

  return (
    <div className="space-y-5" data-cost-evidence="personal">
      <DashboardFilters title={t("costEvidence.title")} providers={providers} timezone={timezone} limited={period.limited} defaultPeriod="30" resetKeys={["cursor"]} />
      <p className="text-muted-foreground text-sm">{t("costBasis.description")}</p>
      <p className="text-muted-foreground text-xs">{t("costEvidence.retention")}</p>
      {page.events.length === 0 ? <p>{t("costEvidence.empty")}</p> : (
        <Card><CardContent className="divide-y">
          {page.events.map((event) => {
            const revision = event.pricingRevisionId ? revisions.get(event.pricingRevisionId) : undefined;
            const explanation = explainStoredCost(event, revision);
            return (
              <Disclosure key={event.dedupKey} className="py-4" data-cost-status={event.costStatus}
                triggerClassName="flex w-full flex-wrap justify-start text-left"
                trigger={<>
                  <span className="ml-1 font-medium">{event.model ?? t("costEvidence.unknownModel")}</span>
                  <span className="ml-3 tabular-nums">{event.costStatus === "unpriced" ? t("costCoverage.unpriced") : fmtUsd(event.costUsd)}</span>
                  <span className="text-muted-foreground ml-3 text-xs">{t(`costEvidence.status.${event.costStatus}`)} · {formatTime(event.ts)}</span>
                </>}>
                <dl className="mt-4 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_minmax(0,1fr)]">
                  <dt>{t("costEvidence.input")}</dt><dd>{fmtNum(event.inputTokens)}</dd>
                  <dt>{t("costEvidence.output")}</dt><dd>{fmtNum(event.outputTokens)}</dd>
                  <dt>{t("costEvidence.cache")}</dt><dd>{fmtNum(event.cacheReadTokens)} / {fmtNum(event.cacheCreationTokens)}</dd>
                  <dt>{t("costEvidence.calculator")}</dt><dd>{event.costCalculationVersion ?? "cost-v1"}</dd>
                  <dt>{t("costEvidence.priceModel")}</dt><dd>{revision?.sourceModelId ?? revision?.modelId ?? "—"}</dd>
                  <dt>{t("costEvidence.source")}</dt><dd className="break-all">{revision?.source ?? "—"}</dd>
                  <dt>{t("costEvidence.effective")}</dt><dd>{revision ? formatTime(revision.effectiveAt) : "—"}</dd>
                  <dt>{t("costEvidence.revision")}</dt><dd className="break-all font-mono text-xs">{event.pricingRevisionId ?? "—"}</dd>
                </dl>
                {explanation?.breakdown ? (
                  <Surface variant="muted" radius="sm" padding="md" className="mt-4 space-y-2 text-xs">
                    <p>{t("costEvidence.context", { count: fmtNum(explanation.breakdown.contextTokens) })}</p>
                    <dl className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                      {componentKeys.map((key) => (
                        <div key={key}>
                          <dt>{t(`costEvidence.components.${key}`)}</dt>
                          <dd className="font-mono">${explanation.breakdown!.componentsUsd[key].toFixed(6)}</dd>
                          <dd className="text-muted-foreground mt-1">{t("costEvidence.rate", {
                            rate: explanation.breakdown!.ratesPerMillion[key]?.toLocaleString(locale, { maximumFractionDigits: 8 }) ?? "—",
                          })}</dd>
                        </div>
                      ))}
                    </dl>
                    {explanation.reason ? <p>{t(`costEvidence.reason.${explanation.reason}`)}</p> : null}
                  </Surface>
                ) : <p className="text-muted-foreground mt-4 text-xs">{t("costEvidence.unavailable")}</p>}
              </Disclosure>
            );
          })}
        </CardContent></Card>
      )}
      <div className="flex justify-between">
        <Button asChild variant="outline"><Link href="/">{t("costEvidence.back")}</Link></Button>
        {page.next ? <Button asChild variant="outline"><Link href={`/costs?${nextQuery}`}>{t("costEvidence.next")}</Link></Button> : null}
      </div>
    </div>
  );
}
