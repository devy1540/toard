"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { InsightPreset } from "@/lib/insight-period";
import type { ProviderOption } from "@/lib/providers";

type InsightFiltersProps = {
  preset: InsightPreset;
  metric: "cost" | "tokens";
  provider: string;
  providers: ProviderOption[];
};

function FilterButtons<T extends string>({
  value,
  items,
  label,
  onChange,
}: {
  value: T;
  items: readonly { value: T; label: ReactNode }[];
  label: string;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1" role="group" aria-label={label}>
      {items.map((item) => (
        <Button
          key={item.value}
          size="sm"
          variant={value === item.value ? "default" : "outline"}
          aria-pressed={value === item.value}
          onClick={() => onChange(item.value)}
        >
          {item.label}
        </Button>
      ))}
    </div>
  );
}

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

  const presets: readonly { value: InsightPreset; label: ReactNode }[] = [
    { value: "7", label: t("presets.sevenDays") },
    { value: "week", label: t("presets.week") },
    { value: "month", label: t("presets.month") },
  ];
  const metrics: readonly { value: "cost" | "tokens"; label: ReactNode }[] = [
    { value: "tokens", label: t("filters.tokens") },
    { value: "cost", label: t("filters.cost") },
  ];

  return (
    <div className="flex flex-wrap items-center gap-2">
      <FilterButtons
        value={preset}
        items={presets}
        label={t("presets.label")}
        onChange={(value) => update("period", value)}
      />

      <Select value={provider} onValueChange={(value) => update("provider", value)}>
        <SelectTrigger
          className="h-8 w-fit min-w-0 max-w-44 justify-start gap-1.5 px-2.5"
          aria-label={t("filters.providerLabel")}
        >
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

      <FilterButtons
        value={metric}
        items={metrics}
        label={t("filters.metricLabel")}
        onChange={(value) => update("metric", value)}
      />
    </div>
  );
}
