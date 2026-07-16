"use client";

import { type ReactNode, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { ChartColumn, Check, LayoutGrid, Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { SettingsRow } from "@/components/dashboard/settings-row";
import { SegmentedControl, type SegmentedControlItem } from "@/components/ui/segmented-control";
import { Toggle } from "@/components/ui/toggle";
import {
  BRAND_COOKIE,
  BRAND_PRESETS,
  BRAND_SWATCHES,
  DEFAULT_BRAND,
  isBrandPreset,
  type BrandPreset,
} from "@/lib/brand";
import {
  DASHBOARD_VIEWS,
  DEFAULT_VIEW,
  VIEW_COOKIE,
  isDashboardView,
  type DashboardView,
} from "@/lib/dashboard-view";
import { cn } from "@/lib/utils";

const THEMES = [
  { value: "light", icon: Sun },
  { value: "dark", icon: Moon },
  { value: "system", icon: Monitor },
] as const;
type ThemeValue = (typeof THEMES)[number]["value"];

const VIEW_ICONS = { overview: ChartColumn, classic: LayoutGrid } as const;

/**
 * 모양 설정 컨트롤 — 테마·브랜드 색·기본 대시보드 뷰 (전부 기기 단위 개인 설정).
 * 색·뷰는 쿠키가 진실이고 SSR 이 반영하므로, 여기서는 즉시 적용 + refresh 만 한다.
 */
export function AppearanceForm({ timezoneControl }: { timezoneControl: ReactNode }) {
  const t = useTranslations("settings");
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [brand, setBrand] = useState<BrandPreset>(DEFAULT_BRAND);
  const [view, setView] = useState<DashboardView>(DEFAULT_VIEW);

  useEffect(() => {
    setMounted(true);
    const b = document.documentElement.dataset.brand;
    setBrand(isBrandPreset(b) ? b : DEFAULT_BRAND);
    const v = document.cookie.match(/(?:^|;\s*)toard\.view=([^;]*)/)?.[1];
    setView(isDashboardView(v) ? v : DEFAULT_VIEW);
  }, []);

  function onBrandChange(next: BrandPreset) {
    document.cookie = `${BRAND_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
    if (next === DEFAULT_BRAND) delete document.documentElement.dataset.brand;
    else document.documentElement.dataset.brand = next;
    setBrand(next);
    router.refresh();
  }

  function onViewChange(next: DashboardView) {
    document.cookie = `${VIEW_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
    setView(next);
    router.refresh();
  }

  const themeItems: SegmentedControlItem<ThemeValue>[] = THEMES.map(({ value, icon }) => ({
    value,
    icon,
    label: t(`appearance.theme_${value}`),
  }));
  const themeValue = mounted && THEMES.some(({ value }) => value === theme) ? (theme as ThemeValue) : "system";
  const viewItems: SegmentedControlItem<DashboardView>[] = DASHBOARD_VIEWS.map((v) => ({
    value: v,
    icon: VIEW_ICONS[v],
    label: t(`appearance.view_${v}`),
  }));

  return (
    <div className="min-w-0 divide-y">
      <SettingsRow layout="settings" label={t("appearance.theme")}>
        <SegmentedControl
          value={themeValue}
          items={themeItems}
          onValueChange={setTheme}
          aria-label={t("appearance.theme")}
          className="w-fit"
        />
      </SettingsRow>

      <SettingsRow layout="settings" label={t("appearance.color")}>
        <div className="flex flex-wrap items-center gap-2">
          {BRAND_PRESETS.map((p) => (
            <Toggle
              key={p}
              aria-label={p}
              title={p}
              pressed={brand === p}
              onPressedChange={(pressed) => {
                if (pressed) onBrandChange(p);
              }}
              className={cn(
                "flex size-6 min-w-0 items-center justify-center rounded-full p-0 text-current shadow-none transition-transform hover:scale-110 hover:bg-transparent hover:text-current data-[state=on]:bg-transparent data-[state=on]:text-current",
                brand === p && "ring-ring ring-2 ring-offset-2",
              )}
              style={{ background: BRAND_SWATCHES[p] }}
            >
              {brand === p ? <Check className="size-3.5 text-white" /> : null}
            </Toggle>
          ))}
        </div>
      </SettingsRow>

      <SettingsRow layout="settings" label={t("appearance.defaultView")}>
        <SegmentedControl
          value={view}
          items={viewItems}
          onValueChange={onViewChange}
          aria-label={t("appearance.defaultView")}
          className="w-fit"
        />
      </SettingsRow>

      <SettingsRow layout="settings" label={t("timezone.title")}>
        {timezoneControl}
      </SettingsRow>
    </div>
  );
}
