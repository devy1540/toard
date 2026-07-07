"use client";

import { useEffect, useState } from "react";
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

/** 페이지 툴바 — 한 줄에 [제목·leading(탭 등)] + 기간(세그먼트+직접 선택)·도구(셀렉트) + [trailing(새로고침 등)].
 *  제목은 작게(14px) 유지: 위치 신호는 내비 하이라이트 하나에 의존하지 않고 헤딩으로 보강(NN/g You Are Here).
 *  비고정(sticky 없음) — 스크롤하면 콘텐츠와 같이 올라간다.
 *  직접 선택을 켜면 프리셋 하이라이트 해제(상호배타), 날짜 입력은 아래 줄로 분리해 도구 위치를 고정.
 *  showAllPreset/defaultPeriod: 히스토리처럼 "기본 = 전체"인 화면용.
 *  resetKeys: 필터가 바뀌면 함께 지울 파라미터(페이지 번호·열린 세션 등).
 *  timezone: 서버가 해석한 뷰어 타임존 — 기기 타임존과 다를 때만 표시(조용한 타임존 방지).
 *  같으면 "내 시간대로 보인다"가 자명해 정보가 0 — 숨겨서 필터 행 노이즈를 줄인다. */
export function DashboardFilters({
  providers,
  defaultPeriod = DEFAULT_PERIOD,
  showAllPreset = false,
  resetKeys = [],
  timezone,
  title,
  leading,
  trailing,
}: {
  providers: ProviderOption[];
  defaultPeriod?: string;
  showAllPreset?: boolean;
  resetKeys?: string[];
  timezone?: string;
  /** 페이지 제목 — h1 로 렌더 (접근성·오리엔테이션). */
  title?: string;
  /** 제목 뒤 로컬 컨텍스트 (전체 현황의 개요/순위 탭 등) */
  leading?: React.ReactNode;
  /** 우측 정렬 요소 (새로고침·안내 캡션 등) */
  trailing?: React.ReactNode;
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

  // 기기 타임존은 클라이언트에서만 알 수 있다 — SSR 마크업과의 hydration 불일치를 피해 마운트 후 해석
  const [deviceTz, setDeviceTz] = useState<string | null>(null);
  useEffect(() => {
    setDeviceTz(Intl.DateTimeFormat().resolvedOptions().timeZone ?? null);
  }, []);
  const tzDiffers = timezone != null && deviceTz != null && timezone !== deviceTz;

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
        {title ? <h1 className="mr-2 text-sm font-medium">{title}</h1> : null}
        {leading}
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

        {tzDiffers && (
          <span className="text-muted-foreground text-xs" title={timezone}>
            {t("filters.timezoneNote", { tz: timezone })}
          </span>
        )}
        {trailing ? <div className="ml-auto flex flex-wrap items-center gap-2">{trailing}</div> : null}
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
