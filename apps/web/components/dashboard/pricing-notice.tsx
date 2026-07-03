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

  const user = await getSessionUser();
  const isAdmin = user?.role === "admin";

  return (
    <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
      <div>
        <p className="font-medium">모델 가격이 동기화되지 않아 비용이 $0 으로 표시됩니다.</p>
        <p className="text-muted-foreground mt-0.5 text-xs">
          {isAdmin ? (
            <>
              <Link
                href="/admin?tab=system"
                className="text-primary underline-offset-4 hover:underline"
              >
                관리 → 시스템
              </Link>
              에서 가격 동기화를 실행하세요. 일 단위 자동 갱신은 sync-pricing cron 등록이
              필요합니다(README 스케줄러 절).
            </>
          ) : (
            "관리자에게 가격 동기화(sync-pricing) 실행을 요청하세요."
          )}
        </p>
      </div>
    </div>
  );
}
