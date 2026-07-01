"use client";

import { Suspense } from "react";
import { usePathname } from "next/navigation";
import { DashboardFilters } from "@/components/dashboard/dashboard-filters";

// 기간/도구 필터가 의미 있는(=집계 데이터를 보여주는) 경로에서만 상단 바를 노출한다.
// 설치(/onboarding)·설정(/settings)처럼 필터할 데이터가 없는 페이지는 상단 바 자체를 그리지 않는다.
const FILTER_ROUTES = new Set(["/", "/me", "/leaderboard"]);

export function DashboardTopbar() {
  const pathname = usePathname();
  if (!FILTER_ROUTES.has(pathname)) return null;

  return (
    <div className="bg-background/80 sticky top-0 z-10 flex items-center justify-end gap-2 border-b px-6 py-3 backdrop-blur">
      <Suspense fallback={null}>
        <DashboardFilters />
      </Suspense>
    </div>
  );
}
