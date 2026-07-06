"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
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
