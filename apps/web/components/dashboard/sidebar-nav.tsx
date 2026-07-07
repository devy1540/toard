"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { ChartBar, MessageSquare, Settings, ShieldCheck, User, type LucideIcon } from "lucide-react";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";

type NavKey = "myUsage" | "history" | "org" | "settings" | "admin";
type GroupKey = "groupPersonal" | "groupShared" | "groupSystem";
type NavItem = { href: string; key: NavKey; icon: LucideIcon };
type NavGroup = { label: GroupKey; items: NavItem[] };

export function SidebarNav({ isAdmin = false }: { isAdmin?: boolean }) {
  const t = useTranslations("nav");
  const pathname = usePathname();
  const { setOpenMobile } = useSidebar();

  // 그룹 축: 개인(내 데이터) / 공용(모두의 데이터 — 팀·가족·개인 다중기기 등 배포 형태 불문) / 시스템
  const groups: NavGroup[] = [
    {
      label: "groupPersonal",
      items: [
        { href: "/", key: "myUsage", icon: User },
        { href: "/history", key: "history", icon: MessageSquare },
      ],
    },
    {
      label: "groupShared",
      items: [{ href: "/org", key: "org", icon: ChartBar }],
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
            {items.map(({ href, key, icon: Icon }) => {
              // 하위 경로(/history/:id 등)에서도 해당 메뉴가 활성으로 남게 prefix 매칭
              const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
              return (
                <SidebarMenuItem key={href}>
                  <SidebarMenuButton asChild isActive={active} tooltip={t(key)}>
                    {/* 모바일 드로어는 이동 후 자동으로 닫히지 않아 직접 닫는다 (데스크톱은 no-op) */}
                    <Link href={href} onClick={() => setOpenMobile(false)}>
                      <Icon />
                      <span>{t(key)}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroup>
      ))}
    </>
  );
}
