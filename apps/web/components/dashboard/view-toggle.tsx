"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { ChartColumn, LayoutGrid } from "lucide-react";
import { SegmentedControl, type SegmentedControlItem } from "@/components/ui/segmented-control";
import { DASHBOARD_VIEWS, VIEW_COOKIE, type DashboardView } from "@/lib/dashboard-view";

const ICONS = { overview: ChartColumn, classic: LayoutGrid } as const;

/** 대시보드 뷰 토글 — 클릭 즉시 쿠키 저장 + refresh(SSR 분기). 설정의 "기본 뷰"와 같은 쿠키를 쓴다. */
export function ViewToggle({ view }: { view: DashboardView }) {
  const t = useTranslations("dashboard");
  const router = useRouter();

  function select(next: DashboardView) {
    if (next === view) return;
    document.cookie = `${VIEW_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
    router.refresh();
  }

  const items: SegmentedControlItem<DashboardView>[] = DASHBOARD_VIEWS.map((v) => ({
    value: v,
    label: t(`view.${v}`),
    icon: ICONS[v],
  }));

  return (
    <SegmentedControl value={view} items={items} onValueChange={select} aria-label={t("view.label")} />
  );
}
