"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChartBar, Settings, ShieldCheck, User } from "lucide-react";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "내 사용량", icon: User },
  { href: "/org", label: "전체 현황", icon: ChartBar },
  { href: "/settings", label: "설정", icon: Settings },
];

const ADMIN_NAV = [{ href: "/admin", label: "관리", icon: ShieldCheck }];

export function SidebarNav({ isAdmin = false }: { isAdmin?: boolean }) {
  const pathname = usePathname();
  const items = isAdmin ? [...NAV, ...ADMIN_NAV] : NAV;
  return (
    <nav className="flex flex-col gap-1">
      {items.map(({ href, label, icon: Icon }) => {
        const active = pathname === href;
        return (
          <Link
            key={href}
            href={href}
            className={cn(
              "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
              active
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
            )}
          >
            <Icon className="size-4" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
