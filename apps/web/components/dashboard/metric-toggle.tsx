"use client";

import { useTranslations } from "next-intl";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";

export type ChartMetric = "tokens" | "cost";

/** 차트 지표(토큰/비용) 전환 — URL ?metric= 으로 유지되어 필터·새로고침과 공존. */
export function MetricToggle({ value }: { value: ChartMetric }) {
  const t = useTranslations("dashboard");
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();

  const select = (m: ChartMetric) => {
    if (m === value) return;
    const next = new URLSearchParams(sp.toString());
    next.set("metric", m);
    router.push(`${pathname}?${next.toString()}`);
  };

  return (
    <div className="flex gap-1">
      {(["tokens", "cost"] as const).map((m) => (
        <Button key={m} size="sm" variant={value === m ? "default" : "outline"} onClick={() => select(m)}>
          {t(m === "tokens" ? "chart.tokens" : "chart.cost")}
        </Button>
      ))}
    </div>
  );
}
