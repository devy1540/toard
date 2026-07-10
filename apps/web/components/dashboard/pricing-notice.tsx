import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { AlertTriangle, Info } from "lucide-react";
import type { UsageCostCoverage } from "@toard/core";
import { costCoverageState } from "@/lib/pricing";
import { getSessionUser } from "@/lib/session-user";

/**
 * 이미 조회한 usage aggregate의 가격 상태를 사용한다. 별도 가격-table 조회를 하지 않아
 * 혼합 모델의 일부 미확정 비용도 놓치지 않고 dashboard query roundtrip도 늘리지 않는다.
 */
export async function PricingNotice({ coverage }: { coverage: UsageCostCoverage }) {
  const state = costCoverageState(coverage);
  if (state === "complete") return null;

  const t = await getTranslations("dashboard");
  const hasUnpriced = state === "partial" || state === "unpriced";
  const isAdmin = hasUnpriced ? (await getSessionUser())?.role === "admin" : false;
  const Icon = hasUnpriced ? AlertTriangle : Info;

  return (
    <div
      className={hasUnpriced
        ? "flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm"
        : "flex items-start gap-2 rounded-md border border-sky-500/30 bg-sky-500/5 p-3 text-sm"}
    >
      <Icon className={hasUnpriced ? "mt-0.5 size-4 shrink-0 text-amber-500" : "mt-0.5 size-4 shrink-0 text-sky-500"} />
      <div>
        <p className="font-medium">
          {hasUnpriced
            ? t("pricingNotice.unpricedTitle", { count: coverage.unpricedEvents })
            : t("pricingNotice.legacyTitle", { count: coverage.legacyEvents })}
        </p>
        <p className="text-muted-foreground mt-0.5 text-xs">
          {hasUnpriced && isAdmin
            ? t.rich("pricingNotice.unpricedAdminAction", {
                link: (chunks) => (
                  <Link
                    href="/admin?tab=system"
                    className="text-primary underline-offset-4 hover:underline"
                  >
                    {chunks}
                  </Link>
                ),
              })
            : hasUnpriced
              ? t("pricingNotice.unpricedMemberAction")
              : t("pricingNotice.legacyDescription")}
        </p>
      </div>
    </div>
  );
}
