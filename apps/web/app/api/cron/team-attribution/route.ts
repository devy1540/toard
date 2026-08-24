import { requireCronAuthorization } from "@/lib/cron-auth";
import { runTeamAttributionBatch } from "@/lib/team-attribution";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const unauthorized = requireCronAuthorization(req);
  if (unauthorized) return unauthorized;
  const outcome = await runTeamAttributionBatch();
  return Response.json({ ok: outcome !== "failed", outcome });
}
