import { orgDate } from "@/lib/org-time";
import { getStorage } from "@/lib/storage";

export const dynamic = "force-dynamic";

/**
 * Mart 마감 재계산 cron (설계 §4.4·§8.2).
 * 어제(마감) + 오늘(보정) 의 일별 집계를 usage_events 에서 재계산해
 * SUM 지표는 물론 DISTINCT(sessions·active_users)까지 채운다.
 * CRON_SECRET 이 설정돼 있으면 Bearer 인증 요구(미설정 시 dev 편의로 통과).
 */
export async function GET(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return new Response("unauthorized", { status: 401 });
    }
  }

  const days = [{ day: orgDate(-1) }, { day: orgDate(0) }];
  await getStorage().recomputeDaily(days);

  return Response.json({ recomputed: days.map((d) => d.day) });
}
