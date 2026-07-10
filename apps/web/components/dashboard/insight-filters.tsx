"use client";

import { useTranslations } from "next-intl";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { SegmentedControl, type SegmentedControlItem } from "@/components/ui/segmented-control";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { InsightPreset } from "@/lib/insight-period";
import type { ProviderOption } from "@/lib/providers";

type InsightFiltersProps = {
  preset: InsightPreset;
  metric: "cost" | "tokens";
  provider: string;
  providers: ProviderOption[];
};

export function InsightFilters({ preset, metric, provider, providers }: InsightFiltersProps) {
  const t = useTranslations("insights");
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();

  const update = (key: "period" | "provider" | "metric", value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set(key, value);
    router.push(`${pathname}?${params.toString()}`);
  };

  const presets: SegmentedControlItem<InsightPreset>[] = [
    { value: "7", label: t("presets.sevenDays") },
    { value: "week", label: t("presets.week") },
    { value: "month", label: t("presets.month") },
  ];
  const metrics: SegmentedControlItem<"cost" | "tokens">[] = [
    { value: "cost", label: t("filters.cost") },
    { value: "tokens", label: t("filters.tokens") },
  ];

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="space-y-1.5">
        <div className="text-muted-foreground text-xs">{t("presets.label")}</div>
        <SegmentedControl
          value={preset}
          items={presets}
          onValueChange={(value) => update("period", value)}
          aria-label={t("presets.label")}
        />
      </div>

      <div className="space-y-1.5">
        <div className="text-muted-foreground text-xs">{t("filters.providerLabel")}</div>
        <Select value={provider} onValueChange={(value) => update("provider", value)}>
          <SelectTrigger className="h-8 w-fit min-w-0 max-w-44 justify-start gap-1.5 px-2.5" aria-label={t("filters.providerLabel")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-w-[min(24rem,var(--radix-select-content-available-width))]">
            <SelectItem value="all">{t("filters.allProviders")}</SelectItem>
            {providers.map((option) => (
              <SelectItem key={option.key} value={option.key} title={option.label}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <div className="text-muted-foreground text-xs">{t("filters.metricLabel")}</div>
        <SegmentedControl
          value={metric}
          items={metrics}
          onValueChange={(value) => update("metric", value)}
          aria-label={t("filters.metricLabel")}
        />
      </div>
    </div>
  );
}
