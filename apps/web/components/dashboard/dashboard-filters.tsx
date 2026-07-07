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

const ALL_PERIOD = { v: "all", key: "filters.periodAll" } as const;

/** 기간(세그먼트+직접 선택)·도구(셀렉트) 필터 바 — 제목 줄 아래 별도 행에 배치.
 *  직접 선택을 켜면 프리셋 하이라이트 해제(상호배타), 날짜 입력은 아래 줄로 분리해 도구 위치를 고정.
 *  showAllPreset/defaultPeriod: 히스토리처럼 "기본 = 전체"인 화면용.
 *  resetKeys: 필터가 바뀌면 함께 지울 파라미터(페이지 번호·열린 세션 등).
 *  timezone: 서버가 해석한 뷰어 타임존 — 기간 경계가 어느 벽시계 기준인지 명시(조용한 타임존 방지). */
export function DashboardFilters({
  providers,
  defaultPeriod = DEFAULT_PERIOD,
  showAllPreset = false,
  resetKeys = [],
  timezone,
}: {
  providers: ProviderOption[];
  defaultPeriod?: string;
  showAllPreset?: boolean;
  resetKeys?: string[];
  timezone?: string;
}) {
  const t = useTranslations("dashboard");
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const period = sp.get("period") ?? defaultPeriod;
  const provider = sp.get("provider") ?? "all";
  const isCustom = period === "custom";
  const periods = showAllPreset ? [ALL_PERIOD, ...PERIODS] : PERIODS;

  const [showCustom, setShowCustom] = useState(isCustom);
  const [from, setFrom] = useState(sp.get("from") ?? "");
  const [to, setTo] = useState(sp.get("to") ?? "");

  const push = (params: Record<string, string | null>) => {
    const next = new URLSearchParams(sp.toString());
    for (const k of resetKeys) next.delete(k);
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
          {periods.map((p) => (
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

        {timezone && (
          <span className="text-muted-foreground text-xs" title={timezone}>
            {t("filters.timezoneNote", { tz: timezone })}
          </span>
        )}
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
