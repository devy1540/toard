import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { Blocks, Puzzle, Wrench } from "lucide-react";
import { FeatureStatusBadge } from "@/components/dashboard/feature-status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { fmtNum } from "@/lib/format";
import type { DashboardPeriod } from "@/lib/period";
import { getMyToolActivity } from "@/lib/tool-metadata";

export async function ToolActivityCard({ userId, period }: { userId: string; period: DashboardPeriod }) {
  const t = await getTranslations("dashboard.toolActivity");
  const navT = await getTranslations("nav");
  const { summary, rows } = await getMyToolActivity(userId, period);
  const params = new URLSearchParams({ period: period.preset });
  if (period.providerKey) params.set("provider", period.providerKey);
  if (period.bucket !== "day" && period.preset === "today") params.set("bucket", period.bucket);
  const top = rows.slice(0, 3);

  return (
    <Card className="min-w-0">
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <CardTitle>{t("title")}</CardTitle>
            <FeatureStatusBadge status="beta">{navT("badge.beta")}</FeatureStatusBadge>
          </div>
          <CardDescription>{t("description")}</CardDescription>
        </div>
        <Button asChild variant="ghost" size="sm">
          <Link href={`/tools?${params.toString()}`}>{t("details")}</Link>
        </Button>
      </CardHeader>
      <CardContent>
        <div className="grid gap-4 sm:grid-cols-3">
          <Metric icon={<Wrench className="size-4" />} label={t("mcpLabel")} value={fmtNum(summary.mcpCalls)} />
          <Metric icon={<Blocks className="size-4" />} label={t("skillLabel")} value={fmtNum(summary.distinctSkills)} />
          <Metric icon={<Puzzle className="size-4" />} label={t("pluginLabel")} value={fmtNum(summary.distinctPlugins)} />
        </div>
        {top.length > 0 ? (
          <div className="mt-4 flex flex-wrap gap-2">
            {top.map((row) => (
              <span key={`${row.activityKind}:${row.itemKey}:${row.detection}`} className="bg-muted rounded-md px-2 py-1 text-xs">
                {row.displayName} · {t("calls", { count: row.calls })}
              </span>
            ))}
          </div>
        ) : (
          <p className="text-muted-foreground mt-4 text-sm">{t("empty")}</p>
        )}
      </CardContent>
    </Card>
  );
}

function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-muted-foreground flex items-center gap-1.5 text-xs">{icon}{label}</div>
      <div className="mt-1 text-xl font-medium tabular-nums">{value}</div>
    </div>
  );
}
