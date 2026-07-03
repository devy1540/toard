"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { ProviderOption } from "@/lib/providers";

const PERIODS = [
  { v: "today", l: "오늘" },
  { v: "7", l: "7일" },
  { v: "30", l: "30일" },
  { v: "90", l: "90일" },
];

/** 기간(세그먼트)·도구(셀렉트) 필터 — 페이지 헤더 우측에 배치(순위 개인/팀 토글과 동일 패턴). */
export function DashboardFilters({ providers }: { providers: ProviderOption[] }) {
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
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex gap-1">
        {PERIODS.map((p) => (
          <Button
            key={p.v}
            size="sm"
            variant={period === p.v ? "default" : "outline"}
            onClick={() => update("period", p.v)}
          >
            {p.l}
          </Button>
        ))}
      </div>
      <Select value={provider} onValueChange={(v) => update("provider", v)}>
        <SelectTrigger className="w-36">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">전체 도구</SelectItem>
          {providers.map((p) => (
            <SelectItem key={p.key} value={p.key}>
              {p.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
