import type { OrganizationUtilizationResult, UtilizationDimensionKey } from "@toard/core";
import { getFormatter, getTranslations } from "next-intl/server";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { FeatureStatusBadge } from "@/components/dashboard/feature-status-badge";

const dimensions: UtilizationDimensionKey[] = [
  "context_continuity",
  "execution_stability",
];

export async function OrgUtilizationCard({ result }: { result: OrganizationUtilizationResult }) {
  const [t, format] = await Promise.all([getTranslations("org"), getFormatter()]);

  if (result.state === "suppressed") {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            {t("utilization.title")}
            <FeatureStatusBadge status="experiment">{t("utilization.experiment")}</FeatureStatusBadge>
          </CardTitle>
          <CardDescription>{t("utilization.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="bg-muted/35 rounded-lg px-4 py-4">
            <p className="font-medium">{t("utilization.suppressed.title")}</p>
            <p className="text-muted-foreground mt-1 text-sm">{t("utilization.suppressed.description")}</p>
          </div>
        </CardContent>
        <PolicyFooter label={t("utilization.policy")} disclaimer={t("utilization.disclaimer")} />
      </Card>
    );
  }

  if (result.state === "insufficient_data") {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            {t("utilization.title")}
            <FeatureStatusBadge status="experiment">{t("utilization.experiment")}</FeatureStatusBadge>
          </CardTitle>
          <CardDescription>{t("utilization.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="bg-muted/35 rounded-lg px-4 py-4">
            <p className="font-medium">{t("utilization.insufficient.title")}</p>
            <p className="text-muted-foreground mt-1 text-sm">{t(`utilization.insufficient.${result.reason}`)}</p>
          </div>
        </CardContent>
        <PolicyFooter label={t("utilization.policy")} disclaimer={t("utilization.disclaimer")} />
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {t("utilization.title")}
          <FeatureStatusBadge status="experiment">{t("utilization.experiment")}</FeatureStatusBadge>
        </CardTitle>
        <CardDescription>{t("utilization.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="bg-muted/35 flex flex-wrap items-end gap-x-4 gap-y-1 rounded-lg px-4 py-4">
          <span className="text-4xl font-semibold tabular-nums">{format.number(result.median)}</span>
          <span className="text-muted-foreground pb-1 text-sm">
            {t("utilization.range", { p25: result.range.p25, p75: result.range.p75 })}
          </span>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {dimensions.map((dimension) => (
            <div key={dimension} className="border-border/70 rounded-lg border px-3 py-3">
              <p className="text-muted-foreground text-xs">{t(`utilization.dimensions.${dimension}`)}</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">
                {result.dimensionMedians[dimension] == null
                  ? "—"
                  : format.number(result.dimensionMedians[dimension])}
              </p>
            </div>
          ))}
        </div>

        <div>
          <p className="mb-2 text-sm font-medium">{t("utilization.distribution.title")}</p>
          <div className="grid gap-3 sm:grid-cols-3">
            <Distribution label={t("utilization.distribution.above")} count={result.relativeDistribution.above} total={result.sampleSize} />
            <Distribution label={t("utilization.distribution.usual")} count={result.relativeDistribution.usual} total={result.sampleSize} />
            <Distribution label={t("utilization.distribution.below")} count={result.relativeDistribution.below} total={result.sampleSize} />
          </div>
          <p className="text-muted-foreground mt-3 text-xs">
            {t("utilization.sample", { included: result.sampleSize, excluded: result.excludedUsers })}
          </p>
        </div>
      </CardContent>
      <PolicyFooter label={t("utilization.policy")} disclaimer={t("utilization.disclaimer")} />
    </Card>
  );
}

function Distribution({ label, count, total }: { label: string; count: number; total: number }) {
  const width = total > 0 ? Math.round((count / total) * 100) : 0;
  return (
    <div>
      <div className="flex items-center justify-between gap-2 text-sm">
        <span>{label}</span>
        <span className="tabular-nums">{count}</span>
      </div>
      <div className="bg-muted mt-2 h-1.5 overflow-hidden rounded-full">
        <div className="bg-chart-1 h-full rounded-full" style={{ width: `${width}%` }} />
      </div>
    </div>
  );
}

function PolicyFooter({ label, disclaimer }: { label: string; disclaimer: string }) {
  return (
    <CardFooter className="text-muted-foreground flex flex-wrap items-center justify-between gap-2 border-t text-xs">
      <span>{disclaimer}</span>
      <a
        className="underline underline-offset-4"
        href="https://github.com/devy1540/toard/blob/main/docs/ai-utilization-policy.md"
        target="_blank"
        rel="noreferrer"
      >
        {label}
      </a>
    </CardFooter>
  );
}
