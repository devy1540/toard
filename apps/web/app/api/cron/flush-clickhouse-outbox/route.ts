import { flushClickHouseOutbox } from "@/lib/clickhouse-outbox";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("unauthorized", { status: 401 });
  }

  const limit = Number(new URL(req.url).searchParams.get("limit") ?? "10");
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.floor(limit))) : 10;
  const r = await flushClickHouseOutbox(safeLimit);
  return Response.json({ ok: true, ...r });
}
