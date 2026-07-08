import { type ReactNode } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { AppSidebar } from "@/components/dashboard/app-sidebar";
import { LogoMark } from "@/components/logo-mark";
import { TimezoneSync } from "@/components/timezone-sync";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { getSessionUser } from "@/lib/session-user";
import { hasAnyUser } from "@/lib/setup";
import { hasTeams, isTeamOnboardingPending } from "@/lib/team-onboarding";

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
  if (sessionUser && isTeamOnboardingPending(sessionUser) && (await hasTeams())) {
    redirect("/onboarding/team");
  }
  const isAdmin = sessionUser?.role === "admin";

  // 접힘 상태를 쿠키로 복원해 SSR 첫 페인트부터 일치 (shadcn Sidebar 기본 계약)
  const sidebarState = (await cookies()).get("sidebar_state")?.value;

  return (
    <SidebarProvider defaultOpen={sidebarState !== "false"}>
      <TimezoneSync />
      <AppSidebar isAdmin={isAdmin} />
      <SidebarInset>
        {/* 모바일 전용 상단바 — 드로어 트리거. 비고정(sticky 지양 — 스크롤 시 콘텐츠와 함께 올라감) */}
        <header className="flex h-12 items-center gap-2 border-b px-4 md:hidden">
          <SidebarTrigger />
          <LogoMark size={20} />
          <span className="text-sm font-bold">toard</span>
        </header>
        {/* 공통 콘텐츠 영역 — 풀폭 + 고정 패딩. 페이지 간 폭·정렬 통일은 각 페이지의 그리드가 담당 */}
        <div className="min-w-0 p-4 sm:p-6 lg:p-8">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}
