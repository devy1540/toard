import { requireCronAuthorization } from "@/lib/cron-auth";
import { flushClickHouseOutbox } from "@/lib/clickhouse-outbox";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const unauthorized = requireCronAuthorization(req);
  if (unauthorized) return unauthorized;

  const limit = Number(new URL(req.url).searchParams.get("limit") ?? "10");
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.floor(limit))) : 10;
  const r = await flushClickHouseOutbox(safeLimit);
  return Response.json({ ok: true, ...r });
}
