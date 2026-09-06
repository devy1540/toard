import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import type { UsageCostCoverage } from "@toard/core";
import { Alert } from "@/components/ui/alert";
import { costCoverageState } from "@/lib/pricing";

/**
 * 이미 조회한 usage aggregate의 가격 상태를 사용한다. 별도 가격-table 조회를 하지 않아
 * 혼합 모델의 일부 미확정 비용도 놓치지 않고 dashboard query roundtrip도 늘리지 않는다.
 */
export async function PricingNotice({ coverage }: { coverage: UsageCostCoverage }) {
  const state = costCoverageState(coverage);
  const t = await getTranslations("dashboard");
  if (state === "complete" || state === "legacy") {
    return <p className="text-muted-foreground text-xs" data-cost-basis="api-equivalent">{t("costBasis.description")} <Link href="/costs" className="underline">{t("costEvidence.title")}</Link></p>;
  }

  return (
    <Alert className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
      <div>
        <p className="font-medium">
          {state === "estimated"
            ? t("costBasis.estimatedTitle", { count: coverage.estimatedEvents ?? 0 })
            : t("pricingNotice.unpricedTitle", { count: coverage.unpricedEvents })}
        </p>
        <p className="text-muted-foreground mt-0.5 text-xs" data-cost-basis="api-equivalent">
          {t(state === "estimated" ? "costBasis.estimatedDescription" : "pricingNotice.unpricedAction")}
          {" "}{t("costBasis.description")}
          {" "}<Link href="/costs" className="underline">{t("costEvidence.title")}</Link>
        </p>
      </div>
    </Alert>
  );
}
