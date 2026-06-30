import { Suspense, type ReactNode } from "react";
import { Activity } from "lucide-react";
import { DashboardFilters } from "@/components/dashboard/dashboard-filters";
import { SidebarNav } from "@/components/dashboard/sidebar-nav";
import { UserMenu } from "@/components/dashboard/user-menu";
import { ModeToggle } from "@/components/mode-toggle";

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen">
      <aside className="bg-sidebar text-sidebar-foreground border-sidebar-border sticky top-0 hidden h-screen w-56 shrink-0 flex-col border-r p-4 md:flex">
        <div className="mb-6 flex items-center gap-2 px-2">
          <Activity className="size-5" />
          <span className="text-lg font-bold">toard</span>
        </div>
        <SidebarNav />
        <div className="text-muted-foreground mt-auto px-2 text-xs">AI 사용량 대시보드</div>
      </aside>
      <main className="flex-1">
        <div className="bg-background/80 sticky top-0 z-10 flex items-center justify-end gap-2 border-b px-6 py-3 backdrop-blur">
          <Suspense fallback={null}>
            <DashboardFilters />
          </Suspense>
          <ModeToggle />
          <Suspense fallback={null}>
            <UserMenu />
          </Suspense>
        </div>
        <div className="p-6 lg:p-8">{children}</div>
      </main>
    </div>
  );
}
