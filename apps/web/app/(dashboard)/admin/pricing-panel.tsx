"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
  setPricingAutoSyncAction,
  syncPricingAction,
  type AutoSyncToggleState,
  type PricingSyncState,
} from "./pricing-actions";

const INITIAL: PricingSyncState = {};
const INITIAL_TOGGLE: AutoSyncToggleState = {};

/** 가격 동기화 상태 + 수동 실행 + 자동 동기화(일 1회) 토글 — 재시작 없이 여기서 등록/해지한다. */
export function PricingSyncPanel({
  models,
  lastDay,
  autoSync,
  builtinScheduler,
}: {
  models: number;
  lastDay: string | null;
  /** 자동 동기화 토글의 저장된 상태 (app_settings) */
  autoSync: boolean;
  /** 내장 스케줄러가 이 배포에서 도는지 (Vercel·PRICING_AUTO_SYNC=off 면 false) */
  builtinScheduler: boolean;
}) {
  const t = useTranslations("admin");
  const [state, action, pending] = useActionState(syncPricingAction, INITIAL);
  const [toggleState, toggleAction, togglePending] = useActionState(
    setPricingAutoSyncAction,
    INITIAL_TOGGLE,
  );
  const enabled = toggleState.enabled ?? autoSync;

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

      {builtinScheduler ? (
        <form action={toggleAction} className="space-y-1">
          <input type="hidden" name="enabled" value={enabled ? "false" : "true"} />
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={enabled}
              disabled={togglePending}
              onChange={(e) => e.currentTarget.form?.requestSubmit()}
            />
            <span>{t("system.autoSyncLabel")}</span>
          </label>
          <p className="text-muted-foreground text-xs">{t("system.autoSyncHint")}</p>
        </form>
      ) : (
        <p className="text-muted-foreground text-xs">{t("system.autoSyncUnavailable")}</p>
      )}

      {toggleState.error ? <p className="text-destructive text-sm">{toggleState.error}</p> : null}
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
