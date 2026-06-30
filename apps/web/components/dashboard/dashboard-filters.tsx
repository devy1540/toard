"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const PERIODS = [
  { v: "7", l: "최근 7일" },
  { v: "30", l: "최근 30일" },
  { v: "90", l: "최근 90일" },
];

const PROVIDERS = [
  { v: "all", l: "전체 도구" },
  { v: "claude_code", l: "Claude Code" },
  { v: "codex", l: "Codex" },
];

export function DashboardFilters() {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const period = sp.get("period") ?? "30";
  const provider = sp.get("provider") ?? "all";

  const update = (key: string, value: string) => {
    const next = new URLSearchParams(sp.toString());
    next.set(key, value);
    router.push(`${pathname}?${next.toString()}`);
  };

  return (
    <div className="flex items-center gap-2">
      <Select value={period} onValueChange={(v) => update("period", v)}>
        <SelectTrigger className="w-32">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {PERIODS.map((p) => (
            <SelectItem key={p.v} value={p.v}>
              {p.l}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={provider} onValueChange={(v) => update("provider", v)}>
        <SelectTrigger className="w-36">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {PROVIDERS.map((p) => (
            <SelectItem key={p.v} value={p.v}>
              {p.l}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
