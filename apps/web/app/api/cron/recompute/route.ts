import { requireCronAuthorization } from "@/lib/cron-auth";
import { orgDate } from "@/lib/org-time";
import { getStorage } from "@/lib/storage";

export const dynamic = "force-dynamic";

/**
 * Mart 마감 재계산 cron (설계 §4.4·§8.2).
 * 어제(마감) + 오늘(보정) 의 일별 집계를 usage_events 에서 재계산해
 * SUM 지표는 물론 DISTINCT(sessions·active_users)까지 채운다.
 * CRON_SECRET이 없거나 Bearer가 다르면 집계를 실행하지 않는다.
 */
export async function GET(req: Request): Promise<Response> {
  const unauthorized = requireCronAuthorization(req);
  if (unauthorized) return unauthorized;

  const days = [{ day: orgDate(-1) }, { day: orgDate(0) }];
  await getStorage().recomputeDaily(days);

  return Response.json({ recomputed: days.map((d) => d.day) });
}
