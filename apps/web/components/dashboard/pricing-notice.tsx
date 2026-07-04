import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { getPricingStatus } from "@/lib/pricing";
import { getSessionUser } from "@/lib/session-user";

/**
 * 가격 미동기화 경고 — pricing_models 가 비면 모든 비용이 조용히 $0 으로 보이는 함정을
 * 대시보드에서 표면화한다. 가격이 1건이라도 있으면 렌더하지 않는다.
 */
export async function PricingNotice() {
  const status = await getPricingStatus();
  if (status.models > 0) return null;

  const t = await getTranslations("dashboard");
  const user = await getSessionUser();
  const isAdmin = user?.role === "admin";

  return (
    <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
      <div>
        <p className="font-medium">{t("pricingNotice.title")}</p>
        <p className="text-muted-foreground mt-0.5 text-xs">
          {isAdmin
            ? t.rich("pricingNotice.adminAction", {
                link: (chunks) => (
                  <Link
                    href="/admin?tab=system"
                    className="text-primary underline-offset-4 hover:underline"
                  >
                    {chunks}
                  </Link>
                ),
              })
            : t("pricingNotice.memberAction")}
        </p>
      </div>
    </div>
  );
}
