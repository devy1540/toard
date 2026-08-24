import { requireCronAuthorization } from "@/lib/cron-auth";
import { runPricingSync } from "@/lib/pricing-sync";

export const dynamic = "force-dynamic";

/**
 * LiteLLM 가격 동기화 cron (설계 §6.2) — 코어는 lib/pricing-sync (admin 수동 동기화와 공유).
 * CRON_SECRET이 없거나 Bearer가 다르면 동기화를 실행하지 않는다.
 */
export async function GET(req: Request): Promise<Response> {
  const unauthorized = requireCronAuthorization(req);
  if (unauthorized) return unauthorized;

  const r = await runPricingSync();
  if (!r.ok) {
    // fetch 실패는 기존 스냅샷 유지(정상 폴백) — 200, DB 오류는 500
    return r.kept
      ? Response.json({ ok: false, kept: "snapshot", error: r.error })
      : Response.json({ ok: false, error: r.error }, { status: 500 });
  }
  return Response.json({ ok: true, upserted: r.upserted, day: r.day });
}
