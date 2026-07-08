import Link from "next/link";
import { cn } from "@/lib/utils";

export interface LinkTab {
  value: string;
  label: string;
  href: string;
}

/** URL 기반 탭 바 — shadcn Tabs(TabsList/TabsTrigger) 스타일을 Link 로 미러.
 *  Radix Tabs 는 클라이언트 상태 기반이라 서버 컴포넌트 + 쿼리 딥링크 구조에는 이 쪽을 쓴다. */
export function LinkTabs({ tabs, active }: { tabs: LinkTab[]; active: string }) {
  return (
    <nav className="bg-muted text-muted-foreground inline-flex h-9 max-w-full items-center overflow-x-auto rounded-lg p-[3px]">
      {tabs.map((t) => (
        <Link
          key={t.value}
          href={t.href}
          className={cn(
            "inline-flex h-[calc(100%-1px)] items-center justify-center rounded-md border border-transparent px-3 py-1 text-sm font-medium whitespace-nowrap transition-[color,box-shadow]",
            active === t.value && "bg-background text-foreground shadow-sm",
          )}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
