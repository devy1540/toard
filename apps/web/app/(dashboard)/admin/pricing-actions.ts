"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { setAutoSyncEnabled } from "@/lib/pricing-auto-sync";
import { runPricingSync } from "@/lib/pricing-sync";
import { getSessionUser } from "@/lib/session-user";

export type PricingSyncState = { ok?: boolean; error?: string; upserted?: number; day?: string };

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
