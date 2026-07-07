import Link from "next/link";
import { SidebarNav } from "@/components/dashboard/sidebar-nav";
import { UserMenu } from "@/components/dashboard/user-menu";
import { LogoMark } from "@/components/logo-mark";
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader, SidebarRail } from "@/components/ui/sidebar";

/**
 * 앱 공통 사이드바 (server component).
 * 데스크톱: 아이콘 collapse(레일 클릭·⌘/Ctrl+B) / 모바일: Sheet 드로어 — shadcn Sidebar가 담당.
 */
export function AppSidebar({ isAdmin = false }: { isAdmin?: boolean }) {
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <Link
          href="/"
          className="flex h-10 items-center gap-2 rounded-md px-2 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0"
        >
          <LogoMark size={24} className="shrink-0" />
          <span className="truncate text-base font-bold group-data-[collapsible=icon]:hidden">toard</span>
        </Link>
      </SidebarHeader>
      <SidebarContent>
        <SidebarNav isAdmin={isAdmin} />
      </SidebarContent>
      <SidebarFooter>
        <UserMenu />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
