"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { ChartColumn, LayoutGrid } from "lucide-react";
import { DASHBOARD_VIEWS, VIEW_COOKIE, type DashboardView } from "@/lib/dashboard-view";
import { cn } from "@/lib/utils";

const ICONS = { classic: LayoutGrid, stats: ChartColumn } as const;

/** 대시보드 뷰 토글 — 클릭 즉시 쿠키 저장 + refresh(SSR 분기). 설정의 "기본 뷰"와 같은 쿠키를 쓴다. */
export function ViewToggle({ view }: { view: DashboardView }) {
  const t = useTranslations("dashboard");
  const router = useRouter();

  function select(next: DashboardView) {
    if (next === view) return;
    document.cookie = `${VIEW_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
    router.refresh();
  }

  return (
    <div className="border-input flex rounded-md border p-0.5" role="group" aria-label={t("view.label")}>
      {DASHBOARD_VIEWS.map((v) => {
        const Icon = ICONS[v];
        return (
          <button
            key={v}
            type="button"
            aria-pressed={view === v}
            onClick={() => select(v)}
            className={cn(
              "flex items-center gap-1.5 rounded-sm px-2 py-1 text-xs transition-colors",
              view === v ? "bg-muted text-foreground font-medium" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-3.5" />
            {t(`view.${v}`)}
          </button>
        );
      })}
    </div>
  );
}
