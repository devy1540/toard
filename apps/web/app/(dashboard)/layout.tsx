import { type ReactNode } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { SidebarNav } from "@/components/dashboard/sidebar-nav";
import { UserMenu } from "@/components/dashboard/user-menu";
import { LogoMark } from "@/components/logo-mark";
import { TimezoneSync } from "@/components/timezone-sync";
import { getSessionUser } from "@/lib/session-user";
import { hasAnyUser } from "@/lib/setup";

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  // open 모드(내부망 공개)가 아니면 로그인 필수 — 미로그인은 로그인 화면으로.
  if ((process.env.AUTH_MODE ?? "oauth") !== "open") {
    const session = await auth();
    if (!session?.user) {
      redirect((await hasAnyUser()) ? "/login" : "/setup");
    }
  }

  // 관리 메뉴 노출 여부 (open 모드는 세션이 없어 미노출 — /admin 은 서버 가드가 재차 차단)
  const sessionUser = await getSessionUser();
  const isAdmin = sessionUser?.role === "admin";

  return (
    <div className="flex min-h-screen">
      <TimezoneSync />
      <aside className="bg-sidebar text-sidebar-foreground border-sidebar-border sticky top-0 hidden h-screen w-56 shrink-0 flex-col border-r p-4 md:flex">
        <div className="mb-6 flex items-center gap-2 px-2">
          <LogoMark size={28} />
          <span className="text-lg font-bold">toard</span>
        </div>
        <SidebarNav isAdmin={isAdmin} />
        <div className="border-sidebar-border mt-auto border-t pt-4">
          <UserMenu />
        </div>
      </aside>
      <main className="flex-1">
        {/* 공통 콘텐츠 영역 — 풀폭 + 고정 패딩. 페이지 간 폭·정렬 통일은 각 페이지의 그리드가 담당 */}
        <div className="p-6 lg:p-8">{children}</div>
      </main>
    </div>
  );
}
