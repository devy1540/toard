"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DEFAULT_PERIOD } from "@/lib/period";
import type { ProviderOption } from "@/lib/providers";

const PERIODS = [
  { v: "today", key: "filters.periodToday" },
  { v: "7", key: "filters.period7" },
  { v: "30", key: "filters.period30" },
  { v: "90", key: "filters.period90" },
] as const;

/** 기간(세그먼트+직접 선택)·도구(셀렉트) 필터 바 — 제목 줄 아래 별도 행에 배치.
 *  직접 선택을 켜면 프리셋 하이라이트 해제(상호배타), 날짜 입력은 아래 줄로 분리해 도구 위치를 고정. */
export function DashboardFilters({ providers }: { providers: ProviderOption[] }) {
  const t = useTranslations("dashboard");
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const period = sp.get("period") ?? DEFAULT_PERIOD;
  const provider = sp.get("provider") ?? "all";
  const isCustom = period === "custom";

  const [showCustom, setShowCustom] = useState(isCustom);
  const [from, setFrom] = useState(sp.get("from") ?? "");
  const [to, setTo] = useState(sp.get("to") ?? "");

  const push = (params: Record<string, string | null>) => {
    const next = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(params)) {
      if (v === null) next.delete(k);
      else next.set(k, v);
    }
    router.push(`${pathname}?${next.toString()}`);
  };

  const selectPreset = (v: string) => {
    setShowCustom(false);
    push({ period: v, from: null, to: null });
  };

  const applyCustom = () => {
    if (!from || !to) return;
    push({ period: "custom", from, to });
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1">
          {PERIODS.map((p) => (
            <Button
              key={p.v}
              size="sm"
              variant={!isCustom && !showCustom && period === p.v ? "default" : "outline"}
              onClick={() => selectPreset(p.v)}
            >
              {t(p.key)}
            </Button>
          ))}
          <Button
            size="sm"
            variant={isCustom || showCustom ? "default" : "outline"}
            onClick={() => setShowCustom((s) => !s)}
          >
            {t("filters.customRange")}
          </Button>
        </div>

        <Select value={provider} onValueChange={(v) => push({ provider: v })}>
          <SelectTrigger className="h-8 w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("filters.allTools")}</SelectItem>
            {providers.map((p) => (
              <SelectItem key={p.key} value={p.key}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {showCustom && (
        <div className="flex flex-wrap items-center gap-1">
          <Input
            type="date"
            value={from}
            max={to || undefined}
            onChange={(e) => setFrom(e.target.value)}
            className="h-8 w-auto"
            aria-label={t("filters.startDate")}
          />
          <span className="text-muted-foreground text-sm">~</span>
          <Input
            type="date"
            value={to}
            min={from || undefined}
            onChange={(e) => setTo(e.target.value)}
            className="h-8 w-auto"
            aria-label={t("filters.endDate")}
          />
          <Button size="sm" onClick={applyCustom} disabled={!from || !to}>
            {t("filters.apply")}
          </Button>
        </div>
      )}
    </div>
  );
}
