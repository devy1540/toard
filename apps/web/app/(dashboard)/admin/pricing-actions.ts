"use server";

import { revalidatePath } from "next/cache";
import { runPricingSync } from "@/lib/pricing-sync";
import { getSessionUser } from "@/lib/session-user";

export type PricingSyncState = { ok?: boolean; error?: string; upserted?: number; day?: string };

/** 가격 수동 동기화 (admin) — cron 미등록/실패 시 비용 $0 함정의 즉시 탈출구. */
export async function syncPricingAction(
  _prev: PricingSyncState,
  _formData: FormData,
): Promise<PricingSyncState> {
  const user = await getSessionUser();
  if (!user || user.role !== "admin") return { error: "관리자만 가능합니다." };

  const r = await runPricingSync();
  if (!r.ok) {
    return {
      error: r.kept
        ? `가격 다운로드에 실패해 기존 스냅샷을 유지했습니다 — ${r.error}`
        : `동기화 실패 — ${r.error}`,
    };
  }
  revalidatePath("/admin");
  return { ok: true, upserted: r.upserted, day: r.day };
}
