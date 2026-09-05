import { parseCollectionHealthReport, parseShimUserAgent, WireParseError } from "@toard/core";
import { recordCollectionHealth } from "@/lib/collection-health";
import { getPool } from "@/lib/db";
import { recordShimVersions } from "@/lib/host-shims";
import { authenticateIngestToken } from "@/lib/ingest-auth";
import { readBoundedJson } from "@/lib/tool-ingest";
import { recordTokenHost } from "@/lib/tokens";

export async function POST(request: Request): Promise<Response> {
  const identity = await authenticateIngestToken(request.headers.get("authorization"));
  if (!identity) return new Response("unauthorized", { status: 401 });
  try {
    const report = parseCollectionHealthReport(await readBoundedJson(request, 16 * 1024));
    const providers = await getPool().query("SELECT key FROM providers WHERE key = ANY($1::text[])", [report.collectors.map((row) => row.providerKey)]);
    if (providers.rows.length !== report.collectors.length) return new Response("unknown collection provider", { status: 400 });
    const reported = await recordCollectionHealth(identity.userId, identity.tokenId, report);
    await recordTokenHost(identity.tokenId, [report.host]);
    const version = parseShimUserAgent(request.headers.get("user-agent"));
    if (version) await recordShimVersions(identity.userId, version, [report.host]);
    return Response.json({ reported, userId: identity.userId, eventsReceiptVersion: 1 });
  } catch (error) {
    if (error instanceof RangeError) return new Response("collection report too large", { status: 413 });
    if (error instanceof WireParseError || error instanceof SyntaxError) return new Response("invalid collection health report", { status: 400 });
    return new Response("collection health unavailable", { status: 503 });
  }
}
