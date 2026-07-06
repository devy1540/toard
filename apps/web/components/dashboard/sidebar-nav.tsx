"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { ChartBar, MessageSquare, Settings, ShieldCheck, User } from "lucide-react";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", key: "myUsage", icon: User },
  { href: "/history", key: "history", icon: MessageSquare },
  { href: "/org", key: "org", icon: ChartBar },
  { href: "/settings", key: "settings", icon: Settings },
] as const;

const ADMIN_NAV = [{ href: "/admin", key: "admin", icon: ShieldCheck }] as const;

export function SidebarNav({ isAdmin = false }: { isAdmin?: boolean }) {
  const t = useTranslations("nav");
  const pathname = usePathname();
  const items = isAdmin ? [...NAV, ...ADMIN_NAV] : NAV;
  return (
    <nav className="flex flex-col gap-1">
      {items.map(({ href, key, icon: Icon }) => {
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
            {t(key)}
          </Link>
        );
      })}
    </nav>
  );
}
