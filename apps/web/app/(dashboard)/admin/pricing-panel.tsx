"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { syncPricingAction, type PricingSyncState } from "./pricing-actions";

const INITIAL: PricingSyncState = {};

/** 가격 동기화 상태 + 수동 실행 — cron 등록 여부와 무관하게 여기서 즉시 채울 수 있다. */
export function PricingSyncPanel({ models, lastDay }: { models: number; lastDay: string | null }) {
  const [state, action, pending] = useActionState(syncPricingAction, INITIAL);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm">
          {models > 0 ? (
            <span>
              <span className="font-medium">{models.toLocaleString()}개 모델</span>{" "}
              <span className="text-muted-foreground">· 마지막 동기화 {lastDay ?? "—"}</span>
            </span>
          ) : (
            <span className="text-destructive">
              동기화된 가격이 없습니다 — 수집되는 비용이 $0 으로 계산됩니다.
            </span>
          )}
        </div>
        <form action={action}>
          <Button type="submit" disabled={pending}>
            {pending ? "동기화 중…" : "지금 동기화"}
          </Button>
        </form>
      </div>

      {state.error ? <p className="text-destructive text-sm">{state.error}</p> : null}
      {state.ok ? (
        <p className="text-sm text-emerald-600 dark:text-emerald-500">
          동기화 완료 — {state.upserted?.toLocaleString()}개 모델 반영
          {state.day ? ` (${state.day})` : ""}
        </p>
      ) : null}
    </div>
  );
}
