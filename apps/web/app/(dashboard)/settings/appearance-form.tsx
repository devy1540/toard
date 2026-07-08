"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { ChartColumn, Check, LayoutGrid, Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { SettingsRow } from "@/components/dashboard/settings-row";
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

const VIEW_ICONS = { classic: LayoutGrid, stats: ChartColumn } as const;

/**
 * 모양 설정 행들 — 테마·브랜드 색·기본 대시보드 뷰 (전부 기기 단위 개인 설정).
 * 색·뷰는 쿠키가 진실이고 SSR 이 반영하므로, 여기서는 즉시 적용 + refresh 만 한다.
 * divide-y 컨테이너(환경 설정 카드) 안에서 SettingsRow 목록으로 렌더된다.
 */
export function AppearanceForm() {
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

  return (
    <>
      <SettingsRow label={t("appearance.theme")}>
        <div className="border-input flex rounded-md border p-0.5">
          {THEMES.map(({ value, icon: Icon }) => (
            <button
              key={value}
              type="button"
              aria-pressed={mounted && theme === value}
              onClick={() => setTheme(value)}
              className={cn(
                "flex items-center gap-1.5 rounded-sm px-2.5 py-1 text-xs transition-colors",
                mounted && theme === value
                  ? "bg-muted text-foreground font-medium"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="size-3.5" />
              {t(`appearance.theme_${value}`)}
            </button>
          ))}
        </div>
      </SettingsRow>

      <SettingsRow label={t("appearance.color")}>
        <div className="flex items-center gap-2">
          {BRAND_PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              aria-label={p}
              title={p}
              aria-pressed={brand === p}
              onClick={() => onBrandChange(p)}
              className={cn(
                "flex size-6 items-center justify-center rounded-full transition-transform hover:scale-110",
                brand === p && "ring-ring ring-2 ring-offset-2",
              )}
              style={{ background: BRAND_SWATCHES[p] }}
            >
              {brand === p ? <Check className="size-3.5 text-white" /> : null}
            </button>
          ))}
        </div>
      </SettingsRow>

      <SettingsRow label={t("appearance.defaultView")}>
        <div className="flex gap-2">
          {DASHBOARD_VIEWS.map((v) => {
            const Icon = VIEW_ICONS[v];
            return (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                onClick={() => onViewChange(v)}
                className={cn(
                  "flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs transition-colors",
                  view === v
                    ? "border-ring bg-muted text-foreground font-medium"
                    : "border-input text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="size-3.5" />
                {t(`appearance.view_${v}`)}
              </button>
            );
          })}
        </div>
      </SettingsRow>
    </>
  );
}
