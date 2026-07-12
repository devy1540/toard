"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { Building2, ChartBar, Lightbulb, MessageSquare, Settings, ShieldCheck, User, type LucideIcon } from "lucide-react";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { featureStatusBadgeClassName } from "./feature-status-badge";

type NavKey = "myUsage" | "insights" | "history" | "org" | "orgTeams" | "myTeam" | "settings" | "admin";
type GroupKey = "groupPersonal" | "groupShared" | "groupSystem";
type NavBadge = "preview" | "beta";
type NavItem = { href: string; key: NavKey; icon: LucideIcon; badge?: NavBadge };
type NavGroup = { label: GroupKey; items: NavItem[] };

export function SidebarNav({ isAdmin = false }: { isAdmin?: boolean }) {
  const t = useTranslations("nav");
  const pathname = usePathname();
  const { setOpenMobile } = useSidebar();
  const workspaceItems: NavItem[] = [
    { href: "/org", key: "org", icon: ChartBar, badge: "preview" },
    ...(isAdmin ? ([{ href: "/org/teams", key: "orgTeams", icon: Building2, badge: "preview" }] satisfies NavItem[]) : []),
    { href: "/org/team", key: "myTeam", icon: Building2, badge: "preview" },
  ];

  // 그룹 축: 개인(내 데이터) / 워크스페이스(이 인스턴스 전체·팀별 집계) / 시스템
  const groups: NavGroup[] = [
    {
      label: "groupPersonal",
      items: [
        { href: "/", key: "myUsage", icon: User },
        { href: "/insights", key: "insights", icon: Lightbulb, badge: "beta" },
        { href: "/history", key: "history", icon: MessageSquare, badge: "preview" },
      ],
    },
    {
      label: "groupShared",
      items: workspaceItems,
    },
    {
      label: "groupSystem",
      items: [
        { href: "/settings", key: "settings", icon: Settings },
        ...(isAdmin ? ([{ href: "/admin", key: "admin", icon: ShieldCheck }] satisfies NavItem[]) : []),
      ],
    },
  ];

  return (
    <>
      {groups.map(({ label, items }) => (
        <SidebarGroup key={label}>
          <SidebarGroupLabel>{t(label)}</SidebarGroupLabel>
          <SidebarMenu>
            {items.map(({ href, key, icon: Icon, badge }) => {
              // 하위 경로(/history/:id 등)에서도 해당 메뉴가 활성으로 남게 prefix 매칭
              const active =
                href === "/"
                  ? pathname === "/"
                  : href === "/org"
                    ? pathname === "/org"
                    : pathname === href || pathname.startsWith(`${href}/`);
              return (
                <SidebarMenuItem key={href}>
                  <SidebarMenuButton asChild isActive={active} tooltip={t(key)} className={badge ? "pr-20" : undefined}>
                    {/* 모바일 드로어는 이동 후 자동으로 닫히지 않아 직접 닫는다 (데스크톱은 no-op) */}
                    <Link href={href} prefetch={false} onClick={() => setOpenMobile(false)}>
                      <Icon />
                      <span>{t(key)}</span>
                    </Link>
                  </SidebarMenuButton>
                  {badge ? (
                    <SidebarMenuBadge
                      className={featureStatusBadgeClassName(badge, "h-4 min-w-0 px-1.5 text-[10px]")}
                    >
                      {badge === "preview" ? t("badge.preview") : t("badge.beta")}
                    </SidebarMenuBadge>
                  ) : null}
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroup>
      ))}
    </>
  );
}
