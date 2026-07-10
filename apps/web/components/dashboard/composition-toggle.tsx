"use client";

import { useTranslations } from "next-intl";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";

export type CompositionDimension = "model" | "device";

/** 구성 패널 기준 전환 — URL ?composition= 으로 유지되어 새로고침·공유와 공존. */
export function CompositionToggle({ value }: { value: CompositionDimension }) {
  const t = useTranslations("dashboard");
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();

  const select = (dimension: CompositionDimension) => {
    if (dimension === value) return;
    const next = new URLSearchParams(sp.toString());
    if (dimension === "model") next.delete("composition");
    else next.set("composition", dimension);
    router.push(`${pathname}?${next.toString()}`);
  };

  return (
    <div className="flex gap-1" aria-label={t("compositionToggleLabel")}>
      {(["model", "device"] as const).map((dimension) => (
        <Button key={dimension} size="sm" variant={value === dimension ? "default" : "outline"} onClick={() => select(dimension)}>
          {t(dimension === "model" ? "compositionModel" : "compositionDevice")}
        </Button>
      ))}
    </div>
  );
}
