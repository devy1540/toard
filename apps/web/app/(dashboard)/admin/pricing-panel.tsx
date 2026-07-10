"use client";

import { useActionState, useRef } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  repriceUsageAction,
  setPricingAutoSyncAction,
  syncPricingAction,
  type AutoSyncToggleState,
  type PricingRepriceState,
  type PricingSyncState,
} from "./pricing-actions";

const INITIAL: PricingSyncState = {};
const INITIAL_TOGGLE: AutoSyncToggleState = {};
const INITIAL_REPRICE: PricingRepriceState = {};

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
  const [repriceState, repriceAction, repricePending] = useActionState(repriceUsageAction, INITIAL_REPRICE);
  const toggleFormRef = useRef<HTMLFormElement>(null);
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
        <form ref={toggleFormRef} action={toggleAction} className="space-y-1">
          <input type="hidden" name="enabled" value={enabled ? "false" : "true"} />
          <label className="flex cursor-pointer items-center gap-2 text-sm" htmlFor="pricing-auto-sync">
            <Switch
              id="pricing-auto-sync"
              checked={enabled}
              disabled={togglePending}
              onCheckedChange={() => toggleFormRef.current?.requestSubmit()}
            />
            <span>{t("system.autoSyncLabel")}</span>
          </label>
          <p className="text-muted-foreground text-xs">{t("system.autoSyncHint")}</p>
        </form>
      ) : (
        <p className="text-muted-foreground text-xs">{t("system.autoSyncUnavailable")}</p>
      )}

      <div className="border-t pt-3">
        <p className="text-sm font-medium">{t("system.repriceTitle")}</p>
        <p className="text-muted-foreground mt-0.5 text-xs">{t("system.repriceDescription")}</p>
        <form action={repriceAction} className="mt-2 flex flex-wrap items-end gap-2">
          <label className="grid gap-1 text-xs">
            <span className="text-muted-foreground">{t("system.repriceConfirmLabel")}</span>
            <input
              name="confirm-reprice"
              required
              autoComplete="off"
              placeholder={t("system.repriceConfirmPlaceholder")}
              className="border-input bg-background h-8 w-28 rounded-md border px-2 font-mono text-sm"
            />
          </label>
          <Button type="submit" variant="destructive" size="sm" disabled={repricePending}>
            {repricePending ? t("system.repricing") : t("system.repriceSubmit")}
          </Button>
        </form>
      </div>

      {toggleState.error ? <p className="text-destructive text-sm">{toggleState.error}</p> : null}
      {state.error ? <p className="text-destructive text-sm">{state.error}</p> : null}
      {repriceState.error ? <p className="text-destructive text-sm">{repriceState.error}</p> : null}
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
      {repriceState.ok ? (
        <p className="text-sm text-emerald-600 dark:text-emerald-500">
          {t("system.repriced", {
            count: repriceState.repriced?.toLocaleString() ?? "0",
            unpriced: repriceState.unpriced?.toLocaleString() ?? "0",
          })}
        </p>
      ) : null}
    </div>
  );
}
