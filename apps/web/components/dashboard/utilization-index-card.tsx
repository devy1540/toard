import type { UtilizationReason } from "@toard/core";
import { getFormatter, getTranslations } from "next-intl/server";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import type { PersonalUtilizationView } from "@/lib/ai-utilization";
import { getOrgTimezone } from "@/lib/org-time";

function percent(value: number | null, format: Awaited<ReturnType<typeof getFormatter>>): string {
  return value == null
    ? "—"
    : format.number(value, { style: "percent", maximumFractionDigits: 0 });
}

export async function UtilizationIndexCard({ result }: { result: PersonalUtilizationView }) {
  const [t, format] = await Promise.all([getTranslations("insights"), getFormatter()]);
  const timezone = getOrgTimezone();
  const period = (from: Date, to: Date) => t("utilization.periodRange", {
    from: format.dateTime(from, { dateStyle: "medium", timeZone: timezone }),
    to: format.dateTime(new Date(to.getTime() - 1), { dateStyle: "medium", timeZone: timezone }),
  });
  const dimensionNames = {
    context_continuity: t("utilization.dimensions.context_continuity"),
    execution_stability: t("utilization.dimensions.execution_stability"),
    recovery_burden: t("utilization.dimensions.recovery_burden"),
  };
  const reason = (key: UtilizationReason) => t(`utilization.reasons.${key}`);

  return (
    <Card className="overflow-hidden">
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>{t("utilization.title")}</CardTitle>
            <CardDescription>{t("utilization.description")}</CardDescription>
          </div>
          <Badge variant="secondary">{t(`utilization.confidence.${result.confidence}`)}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="bg-muted/35 rounded-lg px-4 py-4">
          {result.score == null ? (
            <div className="space-y-2">
              <p className="text-lg font-semibold">{t("utilization.unavailable")}</p>
              <ul className="text-muted-foreground space-y-1 text-sm">
                {result.reasons.map((item) => <li key={item}>{reason(item)}</li>)}
              </ul>
            </div>
          ) : (
            <div className="flex flex-wrap items-end gap-x-4 gap-y-1">
              <span className="text-4xl font-semibold tabular-nums">{format.number(result.score)}</span>
              <span className="text-muted-foreground pb-1 text-sm">{t("utilization.selfBaseline")}</span>
            </div>
          )}
        </div>

        <div className="grid gap-3 md:grid-cols-3">
          {result.dimensions.map((dimension) => (
            <div key={dimension.key} className="border-border/70 rounded-lg border px-3 py-3">
              <p className="text-muted-foreground text-xs">{dimensionNames[dimension.key]}</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">
                {dimension.score == null ? "—" : format.number(dimension.score)}
              </p>
              <p className="text-muted-foreground mt-1 text-xs">
                {t("utilization.dimensionValues", {
                  current: percent(dimension.currentValue, format),
                  baseline: percent(dimension.baselineMedian, format),
                })}
              </p>
              {dimension.reason ? (
                <p className="text-muted-foreground mt-2 text-xs">{reason(dimension.reason)}</p>
              ) : null}
            </div>
          ))}
        </div>

        <div>
          <p className="mb-2 text-sm font-medium">{t("utilization.observations.title")}</p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Observation label={t("utilization.observations.activeDays")} value={format.number(result.observations.activeDays)} />
            <Observation label={t("utilization.observations.sessions")} value={format.number(result.observations.sessions)} />
            <Observation
              label={t("utilization.observations.toolSessionRate")}
              value={percent(result.observations.toolActiveSessionRate, format)}
            />
            <Observation label={t("utilization.observations.distinctTools")} value={format.number(result.observations.distinctTools)} />
          </div>
        </div>
      </CardContent>
      <CardFooter className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 border-t text-xs">
        <span>{t("utilization.currentPeriod", { range: period(result.currentPeriod.from, result.currentPeriod.to) })}</span>
        <span>{t("utilization.baseline", { range: period(result.baselinePeriod.from, result.baselinePeriod.to) })}</span>
        <span>{result.methodologyVersion}</span>
        <span>{t("utilization.calculatedAt", {
          time: format.dateTime(new Date(result.calculatedAt), {
            dateStyle: "medium",
            timeStyle: "short",
            timeZone: timezone,
          }),
        })}</span>
        <span>{t("utilization.delay")}</span>
      </CardFooter>
    </Card>
  );
}

function Observation({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-border/70 border-l pl-3">
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className="mt-1 font-medium tabular-nums">{value}</p>
    </div>
  );
}
