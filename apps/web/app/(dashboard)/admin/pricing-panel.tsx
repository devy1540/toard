"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { syncPricingAction, type PricingSyncState } from "./pricing-actions";

const INITIAL: PricingSyncState = {};

/** 가격 동기화 상태 + 수동 실행 — cron 등록 여부와 무관하게 여기서 즉시 채울 수 있다. */
export function PricingSyncPanel({ models, lastDay }: { models: number; lastDay: string | null }) {
  const t = useTranslations("admin");
  const [state, action, pending] = useActionState(syncPricingAction, INITIAL);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm">
          {models > 0 ? (
            <span>
              <span className="font-medium">
                {t("system.modelsCount", { count: models.toLocaleString() })}
              </span>{" "}
              <span className="text-muted-foreground">
                {t("system.lastSync", { day: lastDay ?? "—" })}
              </span>
            </span>
          ) : (
            <span className="text-destructive">{t("system.noPricing")}</span>
          )}
        </div>
        <form action={action}>
          <Button type="submit" disabled={pending}>
            {pending ? t("system.syncing") : t("system.syncNow")}
          </Button>
        </form>
      </div>

      {state.error ? <p className="text-destructive text-sm">{state.error}</p> : null}
      {state.ok ? (
        <p className="text-sm text-emerald-600 dark:text-emerald-500">
          {state.day
            ? t("system.syncedWithDay", {
                count: state.upserted?.toLocaleString() ?? "0",
                day: state.day,
              })
            : t("system.synced", { count: state.upserted?.toLocaleString() ?? "0" })}
        </p>
      ) : null}
    </div>
  );
}
