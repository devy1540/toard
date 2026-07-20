import { runTeamAttributionBatch } from "@/lib/team-attribution";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("unauthorized", { status: 401 });
  }
  const outcome = await runTeamAttributionBatch();
  return Response.json({ ok: outcome !== "failed", outcome });
}
