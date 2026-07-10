"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { getPool } from "@/lib/db";
import { getOrgTimezone } from "@/lib/org-time";
import { getPricingMap } from "@/lib/pricing";
import { setAutoSyncEnabled } from "@/lib/pricing-auto-sync";
import { repriceUsageCostsWithPool } from "@/lib/pricing-reprice";
import { runPricingSync } from "@/lib/pricing-sync";
import { getSessionUser } from "@/lib/session-user";
import { getStorage } from "@/lib/storage";

export type PricingSyncState = { ok?: boolean; error?: string; upserted?: number; day?: string };
export type PricingRepriceState = { ok?: boolean; error?: string; repriced?: number; unpriced?: number };

/** 가격 수동 동기화 (admin) — cron 미등록/실패 시 비용 $0 함정의 즉시 탈출구. */
export async function syncPricingAction(
  _prev: PricingSyncState,
  _formData: FormData,
): Promise<PricingSyncState> {
  const t = await getTranslations("admin");
  const user = await getSessionUser();
  if (!user || user.role !== "admin") return { error: t("errors.onlyAdmin") };

  const r = await runPricingSync();
  if (!r.ok) {
    return {
      error: r.kept
        ? t("errors.pricingDownloadKept", { error: r.error })
        : t("errors.pricingSyncFailed", { error: r.error }),
    };
  }
  revalidatePath("/admin");
  return { ok: true, upserted: r.upserted, day: r.day };
}

/** 보존 기간 전체를 현재 가격표로 재평가 — 관리자의 명시 확인이 있어야만 실행한다. */
export async function repriceUsageAction(
  _prev: PricingRepriceState,
  formData: FormData,
): Promise<PricingRepriceState> {
  const t = await getTranslations("admin");
  const user = await getSessionUser();
  if (!user || user.role !== "admin") return { error: t("errors.onlyAdmin") };
  if (formData.get("confirm-reprice") !== "REPRICE") return { error: t("errors.repriceConfirmationRequired") };
  if (process.env.STORAGE_BACKEND === "clickhouse") return { error: t("errors.repriceClickHouseMaintenance") };

  try {
    const result = await repriceUsageCostsWithPool(getPool(), await getPricingMap(), getOrgTimezone());
    await getStorage().recomputeDaily(result.days.map((day) => ({ day })));
    revalidatePath("/");
    revalidatePath("/history");
    revalidatePath("/org");
    revalidatePath("/admin");
    return { ok: true, repriced: result.repriced, unpriced: result.unpriced };
  } catch (error) {
    return { error: t("errors.repriceFailed", { error: String(error) }) };
  }
}

export type AutoSyncToggleState = { enabled?: boolean; error?: string };

/** 내장 자동 동기화 on/off (admin) — DB(app_settings)에 저장, 재시작 없이 다음 틱(≤1시간)부터 반영. */
export async function setPricingAutoSyncAction(
  _prev: AutoSyncToggleState,
  formData: FormData,
): Promise<AutoSyncToggleState> {
  const t = await getTranslations("admin");
  const user = await getSessionUser();
  if (!user || user.role !== "admin") return { error: t("errors.onlyAdmin") };

  const enabled = formData.get("enabled") === "true";
  try {
    await setAutoSyncEnabled(enabled);
  } catch (e) {
    return { error: t("errors.autoSyncSaveFailed", { error: String(e) }) };
  }
  revalidatePath("/admin");
  return { enabled };
}
