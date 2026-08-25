import type { UtilizationDimensionKey } from "@toard/core";
import { getFormatter, getTranslations } from "next-intl/server";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { FeatureStatusBadge } from "@/components/dashboard/feature-status-badge";
import { Surface } from "@/components/ui/surface";
import type { OrganizationUtilizationView } from "@/lib/ai-utilization";

const dimensions: UtilizationDimensionKey[] = [
  "context_continuity",
  "execution_stability",
];

export async function OrgUtilizationCard({ result }: { result: OrganizationUtilizationView }) {
  const [t, format] = await Promise.all([getTranslations("org"), getFormatter()]);
  const period = (from: Date, to: Date) => t("utilization.methodology.periodRange", {
    from: format.dateTime(from, { dateStyle: "medium", timeZone: result.timezone }),
    to: format.dateTime(new Date(to.getTime() - 1), { dateStyle: "medium", timeZone: result.timezone }),
  });
  const methodology = (
    <MethodologyDisclosure
      currentPeriod={period(result.currentPeriod.from, result.currentPeriod.to)}
      baselinePeriod={period(result.baselinePeriod.from, result.baselinePeriod.to)}
      timezone={result.timezone}
      methodologyVersion={result.methodologyVersion}
      labels={{
        current: t("utilization.methodology.current"),
        baseline: t("utilization.methodology.baseline"),
        timezone: t("utilization.methodology.timezone"),
        version: t("utilization.methodology.version"),
        fixed: t("utilization.methodology.fixed"),
      }}
    />
  );

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
        <CardContent className="space-y-4">
          <Surface variant="muted" className="border-0 px-4 py-4">
            <p className="font-medium">{t("utilization.suppressed.title")}</p>
            <p className="text-muted-foreground mt-1 text-sm">{t("utilization.suppressed.description")}</p>
          </Surface>
          {methodology}
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
        <CardContent className="space-y-4">
          <Surface variant="muted" className="border-0 px-4 py-4">
            <p className="font-medium">{t("utilization.insufficient.title")}</p>
            <p className="text-muted-foreground mt-1 text-sm">{t(`utilization.insufficient.${result.reason}`)}</p>
          </Surface>
          {methodology}
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
        <Surface variant="muted" className="flex flex-wrap items-end gap-x-4 gap-y-1 border-0 px-4 py-4">
          <span className="text-4xl font-semibold tabular-nums">{format.number(result.median)}</span>
          <span className="text-muted-foreground pb-1 text-sm">
            {t("utilization.range", { p25: result.range.p25, p75: result.range.p75 })}
          </span>
        </Surface>

        <div className="grid gap-3 sm:grid-cols-2">
          {dimensions.map((dimension) => (
            <Surface key={dimension} padding="md">
              <p className="text-muted-foreground text-xs">{t(`utilization.dimensions.${dimension}`)}</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">
                {result.dimensionMedians[dimension] == null
                  ? "—"
                  : format.number(result.dimensionMedians[dimension])}
              </p>
            </Surface>
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

        {methodology}
      </CardContent>
      <PolicyFooter label={t("utilization.policy")} disclaimer={t("utilization.disclaimer")} />
    </Card>
  );
}

function MethodologyDisclosure({
  currentPeriod,
  baselinePeriod,
  timezone,
  methodologyVersion,
  labels,
}: {
  currentPeriod: string;
  baselinePeriod: string;
  timezone: string;
  methodologyVersion: string;
  labels: { current: string; baseline: string; timezone: string; version: string; fixed: string };
}) {
  const entries = [
    [labels.current, currentPeriod],
    [labels.baseline, baselinePeriod],
    [labels.timezone, timezone],
    [labels.version, methodologyVersion],
  ];
  return (
    <Surface padding="md">
      <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
        {entries.map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className="text-muted-foreground text-xs">{label}</dt>
            <dd className="mt-1 break-words text-sm font-medium">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-muted-foreground mt-4 border-t pt-3 text-xs leading-relaxed">{labels.fixed}</p>
    </Surface>
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
