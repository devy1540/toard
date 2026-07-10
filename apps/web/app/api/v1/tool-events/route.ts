import { parseToolActivityBody, ToolWireParseError } from "@toard/core";
import { authenticateIngestToken, loadProviders } from "@/lib/ingest-auth";
import { ingestToolActivity, readBoundedJson } from "@/lib/tool-ingest";

const MAX_BODY_BYTES = 512 * 1024;

export async function POST(req: Request): Promise<Response> {
  const auth = await authenticateIngestToken(req.headers.get("authorization"));
  if (!auth) return new Response("unauthorized", { status: 401 });
  try {
    const events = parseToolActivityBody(await readBoundedJson(req, MAX_BODY_BYTES));
    const providers = new Set((await loadProviders()).map((provider) => provider.key));
    const unknown = [...new Set(events.map((event) => event.providerKey))].filter((key) => !providers.has(key));
    if (unknown.length > 0) return new Response(`등록되지 않은 provider: ${unknown.join(", ")}`, { status: 400 });
    return Response.json(await ingestToolActivity(auth, events));
  } catch (error) {
    if (error instanceof RangeError) return new Response(error.message, { status: 413 });
    const message = error instanceof ToolWireParseError ? error.message : "본문이 유효한 JSON 이 아닙니다";
    return new Response(message, { status: 400 });
  }
}
